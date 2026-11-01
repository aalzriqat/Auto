/**
 * SCRUM-816 source locator for the existing SCRUM-342 / SCRUM-761 evidence.
 *
 * This derives candidate web routes and API bindings from source. It deliberately
 * does not decide pilot enablement, UI action availability, economic correctness,
 * or runtime coverage. Those require SCRUM-810 policy and executed evidence.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type ApiKind = "query" | "mutation" | "action";

export interface ApiSite {
  file: string;
  line: number;
}

export interface PublicEndpoint {
  id: string;
  kind: ApiKind;
  declaration: ApiSite;
  webRoutes: string[];
  webSites: ApiSite[];
}

export interface RouteCandidate {
  route: string;
  page: string;
  sourceFiles: string[];
  apiIds: string[];
}

export interface CensusUnknown {
  kind: "dynamic-import" | "dynamic-api" | "indirect-api" | "missing-local-module" | "unresolved-api";
  site: ApiSite;
  detail: string;
}

export interface PilotJourneyCensus {
  routes: RouteCandidate[];
  publicEndpoints: PublicEndpoint[];
  unknowns: CensusUnknown[];
  evidenceBoundary: string;
}

type ParsedModule = {
  imports: string[];
  apiRefs: { id: string; site: ApiSite }[];
  unknowns: CensusUnknown[];
};

const PUBLIC_BUILDERS = new Set<ApiKind>(["query", "mutation", "action"]);
const BACKEND_BUILDERS = new Set([
  ...PUBLIC_BUILDERS,
  "internalQuery",
  "internalMutation",
  "internalAction",
]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function within(root: string, absolute: string): boolean {
  const rel = path.relative(root, absolute);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "_generated" || entry.name === "node_modules") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(absolute));
    else if (
      SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) &&
      !/\.(test|spec)\.[jt]sx?$/.test(entry.name)
    ) found.push(absolute);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

function sourceFile(absolute: string): ts.SourceFile {
  const kind = absolute.endsWith(".tsx") || absolute.endsWith(".jsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return ts.createSourceFile(absolute, fs.readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

function lineAt(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function resolveLocal(root: string, importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return undefined;
  const stem = specifier.startsWith("@/")
    ? path.resolve(root, specifier.slice(2))
    : path.resolve(path.dirname(importer), specifier);
  if (!within(root, stem)) return undefined;
  const candidates = [stem, ...SOURCE_EXTENSIONS.map((ext) => stem + ext),
    ...SOURCE_EXTENSIONS.map((ext) => path.join(stem, "index" + ext))];
  return candidates.find((candidate) =>
    fs.existsSync(candidate) && fs.statSync(candidate).isFile() &&
    SOURCE_EXTENSIONS.some((ext) => candidate.endsWith(ext))
  );
}

function propertyChain(node: ts.PropertyAccessExpression): string[] | undefined {
  const segments: string[] = [];
  let part: ts.Expression = node;
  while (ts.isPropertyAccessExpression(part)) {
    segments.unshift(part.name.text);
    part = part.expression;
  }
  if (!ts.isIdentifier(part)) return undefined;
  return [part.text, ...segments];
}

function isTypeReference(node: ts.Node): boolean {
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor && !ts.isStatement(ancestor)) {
    if (ts.isTypeNode(ancestor)) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

function isApiElementAccess(node: ts.ElementAccessExpression, aliases: Set<string>): boolean {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return aliases.has(expression.text);
  if (ts.isPropertyAccessExpression(expression)) {
    const chain = propertyChain(expression);
    return !!chain && aliases.has(chain[0]!);
  }
  return ts.isElementAccessExpression(expression) && isApiElementAccess(expression, aliases);
}

function addGeneratedApiAliases(statement: ts.ImportDeclaration, apiAliases: Set<string>): void {
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return;
  for (const element of bindings.elements) {
    if ((element.propertyName?.text ?? element.name.text) === "api") apiAliases.add(element.name.text);
  }
}

function addLocalWebImport(root: string, absolute: string, sf: ts.SourceFile,
  statement: ts.ImportDeclaration | ts.ExportDeclaration, specifier: string,
  imports: string[], unknowns: CensusUnknown[]): void {
  if (specifier.startsWith("@/convex/")) return;
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return;
  const resolved = resolveLocal(root, absolute, specifier);
  if (resolved) {
    if (!relative(root, resolved).startsWith("convex/")) imports.push(resolved);
  } else if (!path.extname(specifier) || SOURCE_EXTENSIONS.includes(path.extname(specifier))) {
    unknowns.push({ kind: "missing-local-module", site: { file: relative(root, absolute), line: lineAt(sf, statement) }, detail: specifier });
  }
}

function webImports(root: string, absolute: string, sf: ts.SourceFile): {
  imports: string[]; apiAliases: Set<string>; unknowns: CensusUnknown[];
} {
  const imports: string[] = [];
  const apiAliases = new Set<string>();
  const unknowns: CensusUnknown[] = [];

  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const moduleNode = statement.moduleSpecifier;
    if (!moduleNode || !ts.isStringLiteral(moduleNode)) continue;
    const specifier = moduleNode.text;
    if (ts.isImportDeclaration(statement) && /(?:^|\/)convex\/_generated\/api$/.test(specifier)) {
      addGeneratedApiAliases(statement, apiAliases);
      continue;
    }
    addLocalWebImport(root, absolute, sf, statement, specifier, imports, unknowns);
  }

  return { imports, apiAliases, unknowns };
}

function apiUnknown(kind: CensusUnknown["kind"], sf: ts.SourceFile, file: string, node: ts.Node): CensusUnknown {
  return { kind, site: { file, line: lineAt(sf, node) }, detail: node.getText(sf).slice(0, 120) };
}

function isUnresolvedImport(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
  const moduleName = node.arguments[0];
  return !moduleName || !ts.isStringLiteral(moduleName) ||
    moduleName.text.startsWith(".") || moduleName.text.startsWith("@/");
}

function isDynamicApi(node: ts.Node, aliases: Set<string>): boolean {
  return ts.isElementAccessExpression(node) && isApiElementAccess(node, aliases) &&
    !(ts.isElementAccessExpression(node.parent) && node.parent.expression === node);
}

function isIndirectApi(node: ts.Node, aliases: Set<string>): boolean {
  return ts.isIdentifier(node) && aliases.has(node.text) &&
    !ts.isImportSpecifier(node.parent) &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) &&
    !(ts.isElementAccessExpression(node.parent) && node.parent.expression === node) &&
    !isTypeReference(node);
}

function apiPropertyChain(node: ts.Node, aliases: Set<string>): string[] | undefined {
  if (!ts.isPropertyAccessExpression(node) ||
    (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) ||
    (ts.isElementAccessExpression(node.parent) && node.parent.expression === node) ||
    isTypeReference(node)) return undefined;
  const chain = propertyChain(node);
  return chain && aliases.has(chain[0]!) ? chain : undefined;
}

function webApiRefs(sf: ts.SourceFile, file: string, apiAliases: Set<string>): {
  apiRefs: ParsedModule["apiRefs"]; unknowns: CensusUnknown[];
} {
  const apiRefs: ParsedModule["apiRefs"] = [];
  const unknowns: CensusUnknown[] = [];
  const visit = (node: ts.Node): void => {
    if (isUnresolvedImport(node)) unknowns.push(apiUnknown("dynamic-import", sf, file, node));
    if (isDynamicApi(node, apiAliases)) unknowns.push(apiUnknown("dynamic-api", sf, file, node));
    if (isIndirectApi(node, apiAliases)) unknowns.push(apiUnknown("indirect-api", sf, file, node));
    const chain = apiPropertyChain(node, apiAliases);
    if (chain && chain.length >= 3) {
      apiRefs.push({ id: chain.slice(1).join("."), site: { file, line: lineAt(sf, node) } });
    } else if (chain) {
      unknowns.push(apiUnknown("indirect-api", sf, file, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { apiRefs, unknowns };
}

function parseWebModule(root: string, absolute: string): ParsedModule {
  const sf = sourceFile(absolute);
  const imports = webImports(root, absolute, sf);
  const refs = webApiRefs(sf, relative(root, absolute), imports.apiAliases);
  return { imports: imports.imports, apiRefs: refs.apiRefs,
    unknowns: [...imports.unknowns, ...refs.unknowns] };
}

function recordBuilderAliases(bindings: ts.NamedImports, rawServer: boolean,
  aggregateWrapper: boolean, aliases: Map<string, string>): void {
  for (const element of bindings.elements) {
    const original = element.propertyName?.text ?? element.name.text;
    if (rawServer && BACKEND_BUILDERS.has(original)) aliases.set(element.name.text, original);
    if (aggregateWrapper && original === "socialBulkMutation") aliases.set(element.name.text, "mutation");
    if (aggregateWrapper && (original === "mutation" || original === "internalMutation")) {
      aliases.set(element.name.text, original);
    }
  }
}

function backendBuilderAliases(root: string, absolute: string, sf: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const rawServer = specifier.endsWith("/_generated/server");
    const aggregateWrapper = path.resolve(path.dirname(absolute), specifier) ===
      path.join(root, "convex", "functions");
    if (!rawServer && !aggregateWrapper) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      recordBuilderAliases(bindings, rawServer, aggregateWrapper, aliases);
    }
  }
  return aliases;
}

type PublicDeclaration = Omit<PublicEndpoint, "webRoutes" | "webSites">;

function publicEndpointForDeclaration(file: string, sf: ts.SourceFile,
  declaration: ts.VariableDeclaration, aliases: Map<string, string>): PublicDeclaration | undefined {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer ||
    !ts.isCallExpression(declaration.initializer) ||
    !ts.isIdentifier(declaration.initializer.expression)) return undefined;
  const builder = aliases.get(declaration.initializer.expression.text);
  if (!builder || !PUBLIC_BUILDERS.has(builder as ApiKind)) return undefined;
  const modulePath = file.slice("convex/".length).replace(/\.[jt]sx?$/, "");
  const id = `${modulePath.replaceAll("/", ".")}.${declaration.name.text}`;
  return { id, kind: builder as ApiKind, declaration: { file, line: lineAt(sf, declaration) } };
}

function publicDeclarations(root: string): Map<string, PublicDeclaration> {
  const found = new Map<string, PublicDeclaration>();
  for (const absolute of listSourceFiles(path.join(root, "convex"))) {
    const sf = sourceFile(absolute);
    const file = relative(root, absolute);
    const aliases = backendBuilderAliases(root, absolute, sf);
    for (const statement of sf.statements) {
      if (!ts.isVariableStatement(statement) ||
        !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const endpoint = publicEndpointForDeclaration(file, sf, declaration, aliases);
        if (endpoint) found.set(endpoint.id, endpoint);
      }
    }
  }
  return found;
}

function routeName(dashboardRoot: string, page: string): string {
  const directory = relative(dashboardRoot, path.dirname(page));
  return "/[orgId]" + (directory === "" ? "" : "/" + directory);
}

function collectRoute(root: string, dashboardRoot: string, page: string,
  getModule: (absolute: string) => ParsedModule,
  sitesByEndpoint: Map<string, Map<string, ApiSite>>,
  routesByEndpoint: Map<string, Set<string>>): RouteCandidate {
  const route = routeName(dashboardRoot, page);
  const pending = [page];
  const visited = new Set<string>();
  const apiIds = new Set<string>();
  while (pending.length > 0) {
    const absolute = pending.pop()!;
    if (visited.has(absolute)) continue;
    visited.add(absolute);
    const parsedModule = getModule(absolute);
    pending.push(...parsedModule.imports);
    for (const ref of parsedModule.apiRefs) {
      apiIds.add(ref.id);
      if (!sitesByEndpoint.has(ref.id)) sitesByEndpoint.set(ref.id, new Map());
      sitesByEndpoint.get(ref.id)!.set(`${ref.site.file}:${ref.site.line}`, ref.site);
      if (!routesByEndpoint.has(ref.id)) routesByEndpoint.set(ref.id, new Set());
      routesByEndpoint.get(ref.id)!.add(route);
    }
  }
  return { route, page: relative(root, page),
    sourceFiles: [...visited].map((file) => relative(root, file)).sort((a, b) => a.localeCompare(b)),
    apiIds: [...apiIds].sort((a, b) => a.localeCompare(b)) };
}

/** Returns source candidates only. UNKNOWN is never converted to PASS. */
export function buildPilotJourneyCensus(root: string): PilotJourneyCensus {
  const repoRoot = path.resolve(root);
  const dashboardRoot = path.join(repoRoot, "app", "(dashboard)", "[orgId]");
  const declarations = publicDeclarations(repoRoot);
  const parsed = new Map<string, ParsedModule>();
  const routes: RouteCandidate[] = [];
  const unknowns: CensusUnknown[] = [];
  const sitesByEndpoint = new Map<string, Map<string, ApiSite>>();
  const routesByEndpoint = new Map<string, Set<string>>();

  const getModule = (absolute: string): ParsedModule => {
    let value = parsed.get(absolute);
    if (!value) {
      value = parseWebModule(repoRoot, absolute);
      parsed.set(absolute, value);
      unknowns.push(...value.unknowns);
    }
    return value;
  };

  for (const page of listSourceFiles(dashboardRoot).filter((file) => path.basename(file) === "page.tsx")) {
    routes.push(collectRoute(repoRoot, dashboardRoot, page, getModule, sitesByEndpoint, routesByEndpoint));
  }

  for (const [id, sites] of sitesByEndpoint) {
    if (declarations.has(id)) continue;
    for (const site of sites.values()) unknowns.push({ kind: "unresolved-api", site, detail: id });
  }

  const publicEndpoints = [...declarations.values()].map((declaration) => ({
      ...declaration,
      webRoutes: [...(routesByEndpoint.get(declaration.id) ?? [])].sort((a, b) => a.localeCompare(b)),
      webSites: [...(sitesByEndpoint.get(declaration.id)?.values() ?? [])]
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    }));
  publicEndpoints.sort((a, b) => a.id.localeCompare(b.id));
  routes.sort((a, b) => a.route.localeCompare(b.route));
  unknowns.sort((a, b) => a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line);
  return {
    routes,
    publicEndpoints,
    unknowns,
    evidenceBoundary:
      "Static web dashboard page-import/API binding locator only; ancestor layouts and dynamic imports require separate review. A reachable binding is not an enabled button; an unreferenced public endpoint may be mobile, webhook, job, integration, or backend-only. No runtime, money, role, tenant, or consumer parity is proved.",
  };
}
