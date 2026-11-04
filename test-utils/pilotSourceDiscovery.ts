import path from "node:path";
import ts from "typescript";

const SWITCH_NAME = /_PILOT_(?:DISABLED|REQUIRED|REFUSED)$/;
const NON_BOOLEAN_INITIALIZERS = new Set([
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral, ts.SyntaxKind.NullKeyword, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrayLiteralExpression, ts.SyntaxKind.ObjectLiteralExpression,
]);
const moduleName = (file: string): string => file.replace(/\.tsx?$/, "");

export interface SwitchDeclaration {
  readonly name: string;
  readonly kind: "constant" | "doorMap";
  readonly module: string;
  readonly value: boolean | null;
  readonly sourceId: string;
}

export interface PilotSourceDiscovery {
  readonly declarations: readonly SwitchDeclaration[];
  readonly exportedBy: ReadonlyMap<string, ReadonlySet<string>>;
  readonly guardModules: readonly string[];
}

export function unwrap(expr: ts.Expression | undefined): ts.Expression | undefined {
  let current = expr;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))) {
    current = current.expression;
  }
  return current;
}

function literalBoolean(expr: ts.Expression | undefined): boolean | null {
  const initializer = unwrap(expr);
  if (initializer?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (initializer?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function variableSwitches(decl: ts.VariableDeclaration): SwitchDeclaration[] {
  if (!ts.isIdentifier(decl.name)) return [];
  const moduleId = moduleName(decl.getSourceFile().fileName);
  const initializer = unwrap(decl.initializer);
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    return SWITCH_NAME.test(decl.name.text)
      ? [{ name: decl.name.text, kind: "constant", module: moduleId, value: literalBoolean(initializer), sourceId: `${moduleId}:${decl.pos}` }]
      : [];
  }
  return initializer.properties.flatMap((prop) => {
    if (!ts.isPropertyAssignment(prop)) return [];
    if (!(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) || !SWITCH_NAME.test(prop.name.text)) return [];
    const value = unwrap(prop.initializer);
    if (value && NON_BOOLEAN_INITIALIZERS.has(value.kind)) return [];
    return [{ name: prop.name.text, kind: "doorMap" as const, module: moduleId, value: literalBoolean(prop.initializer), sourceId: `${moduleId}:${prop.pos}` }];
  });
}

/** Resolve only within the supplied source snapshot. No node_modules or compiler library reads. */
export function sourceProgram(sources: ReadonlyMap<string, string>): ts.Program {
  const options: ts.CompilerOptions = { noLib: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => "/";
  host.getSourceFile = (file) => {
    const text = sources.get(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  };
  host.fileExists = (file) => sources.has(file);
  host.readFile = (file) => sources.get(file);
  host.resolveModuleNames = (specifiers, from) => specifiers.map((specifier) => {
    let target: string;
    if (specifier.startsWith("@/")) target = specifier.slice(2);
    else if (specifier.startsWith(".")) target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/^\//, "");
    else return undefined;
    const base = target.replace(/\.[cm]?[jt]sx?$/, "");
    const resolvedFileName = [target, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}/index.ts`].find((file) => sources.has(file));
    return resolvedFileName ? { resolvedFileName } : undefined;
  });
  return ts.createProgram([...sources.keys()], options, host);
}

function originalSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Follow compiler-resolved import/export aliases, namespaces, and exported const aliases. */
function switchesBehind(symbol: ts.Symbol, checker: ts.TypeChecker, visited = new Set<ts.Symbol>()): SwitchDeclaration[] {
  const original = originalSymbol(symbol, checker);
  if (visited.has(symbol)) return [];
  visited.add(symbol);
  if (original.flags & ts.SymbolFlags.Module) {
    return checker.getExportsOfModule(original).flatMap((entry) => switchesBehind(entry, checker, visited));
  }
  const declaration = original.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration)) return [];
  const exportedAlias = SWITCH_NAME.test(symbol.name) && symbol.name !== original.name
    ? [{ name: symbol.name, kind: "constant" as const, module: moduleName(declaration.getSourceFile().fileName),
      value: literalBoolean(declaration.initializer), sourceId: `${declaration.getSourceFile().fileName}:${declaration.pos}:${symbol.name}` }]
    : [];
  const initializer = unwrap(declaration.initializer);
  const target = initializer && checker.getSymbolAtLocation(initializer);
  const referenced = target ? switchesBehind(target, checker, visited) : [];
  return [...exportedAlias, ...referenced, ...variableSwitches(declaration)];
}

/** Every source is parsed. Export structure and compiler symbols, never text, decide inclusion. */
export function discoverPilotSources(sources: ReadonlyMap<string, string>, guardNames: ReadonlySet<string>): PilotSourceDiscovery {
  const program = sourceProgram(sources);
  const checker = program.getTypeChecker();
  const declarations = new Map<string, SwitchDeclaration>();
  const exportedBy = new Map<string, Set<string>>();
  const guardModules = new Set<string>();
  for (const file of program.getSourceFiles()) {
    const symbol = checker.getSymbolAtLocation(file);
    if (!symbol) continue;
    const moduleId = moduleName(file.fileName);
    for (const entry of checker.getExportsOfModule(symbol)) {
      if (guardNames.has(originalSymbol(entry, checker).name)) guardModules.add(moduleId);
      for (const declaration of switchesBehind(entry, checker)) {
        declarations.set(declaration.sourceId, declaration);
        const modules = exportedBy.get(declaration.name) ?? new Set<string>();
        modules.add(moduleId);
        exportedBy.set(declaration.name, modules);
      }
    }
  }
  return { declarations: [...declarations.values()], exportedBy, guardModules: [...guardModules] };
}

function moduleExports(file: ts.SourceFile, checker: ts.TypeChecker): ts.Symbol[] {
  const symbol = checker.getSymbolAtLocation(file);
  return symbol ? checker.getExportsOfModule(symbol) : [];
}

function resolvedSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && originalSymbol(symbol, checker);
}

function publicMutationHandler(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Node | undefined {
  const decl = originalSymbol(symbol, checker).valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl)) return undefined;
  const call = unwrap(decl.initializer);
  if (!call || !ts.isCallExpression(call)) return undefined;
  const builder = resolvedSymbol(call.expression, checker);
  const file = builder?.valueDeclaration?.getSourceFile().fileName;
  const publicBuilder = (file === "convex/functions.ts" && ["mutation", "socialBulkMutation"].includes(builder?.name ?? "")) ||
    (file === "convex/_generated/server.d.ts" && builder?.name === "mutation");
  if (!publicBuilder) return undefined;
  const config = unwrap(call.arguments[0]);
  if (!config || !ts.isObjectLiteralExpression(config)) return undefined;
  return config.properties.find((prop) => prop.name && prop.name.getText() === "handler");
}

function calledGuards(handler: ts.Node, checker: ts.TypeChecker, guards: ReadonlySet<ts.Symbol>): string[] {
  const found = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const symbol = resolvedSymbol(node.expression, checker);
      if (symbol && guards.has(symbol)) found.add(symbol.name);
    }
    ts.forEachChild(node, visit);
  }
  visit(handler);
  return [...found].sort();
}

/** Direct guard invocations inside exported public mutation handlers, including nested branches.
 * Guard exports come from containment modules, independently of the capability manifest.
 */
export function discoverGuardedPilotMutations(sources: ReadonlyMap<string, string>): ReadonlyMap<string, readonly string[]> {
  const program = sourceProgram(sources);
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles();
  const guards = new Set(files.filter((file) => /^convex\/utils\/[^/]*Containment\.ts$/.test(file.fileName))
    .flatMap((file) => moduleExports(file, checker))
    .filter((symbol) => /^assert\w*(?:Allowed|Enabled)$/.test(symbol.name))
    .map((symbol) => originalSymbol(symbol, checker)));
  const doors = new Map<string, readonly string[]>();
  for (const file of files.filter((source) => /^convex\/[^/]+\.ts$/.test(source.fileName) && !/\.(?:test|spec)\.ts$/.test(source.fileName))) {
    for (const symbol of moduleExports(file, checker)) {
      const handler = publicMutationHandler(symbol, checker);
      const calls = handler ? calledGuards(handler, checker, guards) : [];
      if (calls.length > 0) doors.set(`${path.posix.basename(file.fileName, ".ts")}.${symbol.name}`, calls);
    }
  }
  return doors;
}
