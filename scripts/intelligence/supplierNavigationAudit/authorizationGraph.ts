import { AUTH_HELPER_CONTRACTS, AUTH_MODULE_INITIALIZERS } from "./authorizationContracts";
import ts from "typescript";
import { resolve, relative } from "node:path";
import { root, parse } from "./source";
import { NAVIGATION_CALLERS } from "./callerCensus";
import { navigationTokens, navigationFingerprint } from "./fingerprints";
import { authorizationConditions } from "./authorizationDecisions";
import { expect } from "vitest";
import { AUTH_CONDITION_PAIRS } from "./authorizationPairs";

interface AuthorizationHelper {
  file: string;
  source: ts.SourceFile;
  declaration: ts.FunctionDeclaration;
  name: string;
}

function authorizationInitializers(source: ts.SourceFile): readonly ts.Statement[] {
  return source.statements.filter(node => !ts.isFunctionDeclaration(node) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node));
}

function authorizationProgram(sources: readonly ts.SourceFile[]): ts.Program {
  const options: ts.CompilerOptions = { noLib: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const files = new Map(sources.map(source => {
    const file = resolve(root, source.fileName).replaceAll("\\", "/");
    return [file, ts.createSourceFile(file, source.text, ts.ScriptTarget.Latest, true)] as const;
  }));
  const host = ts.createCompilerHost(options);
  const key = (file: string) => resolve(file).replaceAll("\\", "/");
  host.getSourceFile = file => files.get(key(file));
  host.fileExists = file => files.has(key(file));
  host.readFile = file => files.get(key(file))?.text;
  const program = ts.createProgram([...files.keys()], options, host);
  if (program.getSyntacticDiagnostics().length > 0) throw new Error("Unparseable authorization graph");
  return program;
}

function authorizationFunction(expression: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): ts.FunctionDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const target = symbol.flags === ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  for (const declaration of target.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = authorizationFunction(declaration.initializer, checker, seen);
      if (resolved) return resolved;
    }
  }
}

export function authorizationHelpers(sources: readonly ts.SourceFile[]): AuthorizationHelper[] {
  const program = authorizationProgram(sources);
  const checker = program.getTypeChecker();
  const helpers: AuthorizationHelper[] = [];
  const seen = new Set<ts.FunctionDeclaration>();
  const visit = (declaration: ts.FunctionDeclaration): void => {
    if (seen.has(declaration)) return;
    seen.add(declaration);
    const source = declaration.getSourceFile();
    const name = declaration.name?.text;
    if (!name || !declaration.body) throw new Error("Unnamed authorization helper");
    helpers.push({ file: relative(root, source.fileName).replaceAll("\\", "/"), source, declaration, name });
    authorizationCalls(declaration, checker, visit);
  };
  const roots = new Map(NAVIGATION_CALLERS.filter(caller => caller.exportedQuery !== null)
    .map(caller => [caller.file + ":" + caller.exportedQuery, caller]));
  for (const rootCaller of roots.values()) {
    const source = program.getSourceFile(resolve(root, rootCaller.file).replaceAll("\\", "/"));
    const entry = source?.statements.find(node => ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(declaration => declaration.name.getText(source) === rootCaller.exportedQuery));
    if (!entry) throw new Error("Missing authorization query root " + rootCaller.exportedQuery);
    const scan = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const target = authorizationFunction(node.expression, checker);
        if (target && /\/(?:utils\/(?:tenancy|permissions)|subscriptions)\.ts$/.test(target.getSourceFile().fileName)) visit(target);
      }
      ts.forEachChild(node, scan);
    };
    scan(entry);
  }
  if (helpers.length === 0) throw new Error("Authorization graph must reach helpers from public queries");
  return helpers;
}

function authorizationCalls(body: ts.Node, checker: ts.TypeChecker, visit: (declaration: ts.FunctionDeclaration) => void): void {
  const boundaries = ["ctx.auth.getUserIdentity", "ctx.db.query", "ctx.db.get", "ctx.db.insert", "Date.now", "Number"];
  const methods = ["withIndex", "unique", "eq", "filter", "includes", "every", "has", "join"];
  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = authorizationFunction(node.expression, checker);
      if (target) visit(target);
      else if (!boundaries.includes(navigationTokens(node.expression, node.getSourceFile()).join("")) &&
        !(ts.isPropertyAccessExpression(node.expression) && methods.includes(node.expression.name.text))) {
        throw new Error("authorization condition inventory changed: unreviewed call " + node.expression.getText());
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(body);
}

export function assertAuthorizationConditionInventory(tenancy: ts.SourceFile, permissions: ts.SourceFile): void {
  const helpers = authorizationHelpers(authorizationSources(tenancy, permissions));
  const actual = helpers.flatMap(helper => authorizationConditions(helper.source, helper.name));
  expect(actual.toSorted(), "authorization condition inventory changed; add a literal pair with different expected outcomes before reviewing the condition").toStrictEqual(AUTH_CONDITION_PAIRS.map(([condition]) => condition).sort());
  expect(helpers.map(helper => helper.file + ":" + helper.name).sort(), "Every reached helper needs a behavioural kill contract").toStrictEqual(AUTH_HELPER_CONTRACTS.map(helper => helper.file + ":" + helper.name).sort());
  for (const helper of helpers) {
    const contract = AUTH_HELPER_CONTRACTS.find(pin => pin.file === helper.file && pin.name === helper.name);
    expect(navigationFingerprint(helper.declaration, helper.source), helper.name + ": authorization helper changed; rerun its behavioural mutant before renewing the pin").toBe(contract?.hash);
    expect(contract?.killRows.length, helper.name + ": missing behavioural kill").toBeGreaterThan(0);
  }
  const modules = new Map(helpers.map(helper => [helper.file, helper.source]));
  expect([...modules.keys()].sort(), "Every authorization module needs initialization pins").toStrictEqual(AUTH_MODULE_INITIALIZERS.map(pin => pin.file).sort());
  for (const [file, source] of modules) {
    const pin = AUTH_MODULE_INITIALIZERS.find(entry => entry.file === file);
    expect(authorizationInitializers(source).map(node => navigationFingerprint(node, source)), file + ": authorization module initialization changed").toStrictEqual(pin?.hashes);
  }
}

export function authorizationSources(tenancy = parse("convex/utils/tenancy.ts"), permissions = parse("convex/utils/permissions.ts")): ts.SourceFile[] {
  return [tenancy, permissions, ...["convex/utils/errors.ts", "convex/utils/auditLog.ts", "convex/subscriptions.ts",
    "convex/utils/subscriptionFeatures.ts", "convex/supplierStatement.ts", "convex/supplierRelationships.ts"].map(file => parse(file))];
}
