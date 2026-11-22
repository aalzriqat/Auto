import ts from "typescript";
import { identifierChecker } from "./navigationSyntax";
import { updateTable, root, parse } from "./source";
import { join, resolve, relative } from "node:path";
import { literalTestBody, awaitedCallerCall } from "./callerCells";
import { listActiveTestRegistrations } from "../../autoflowInvariantCatalog";
import { expect } from "vitest";
import { readFileSync } from "node:fs";

// SCRUM-943: pin the caller, not just the helper. getText deliberately includes
// the scope's exact initializer so permission re-sourcing needs explicit review.
interface NavigationCaller {
  file: string; caller: string; exportedQuery: string | null; callee: string; arguments: string; scope: string;
}

export const NAVIGATION_CALLERS: readonly (NavigationCaller & { tests: readonly string[] })[] = [
  { file: "convex/supplierRelationships.ts", caller: "vehicles", exportedQuery: "vehicles", callee: "project",
    arguments: 'vehicle, "SOURCED", role.permissions', scope: 'role.permissions',
    tests: ["relationship query preserves the viewer vehicle permission for sourced and owned rows", "relationship multi-row large and endCursor pages preserve both viewer gates"] },
  { file: "convex/supplierRelationships.ts", caller: "vehicles", exportedQuery: "vehicles", callee: "project",
    arguments: 'vehicle, "OWNED_ON_ACCOUNT", role.permissions, payable._id', scope: 'role.permissions',
    tests: ["relationship query preserves the viewer vehicle permission for sourced and owned rows", "relationship multi-row large and endCursor pages preserve both viewer gates"] },
  { file: "convex/supplierStatement.ts", caller: "settled", exportedQuery: "settled", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.payable", scope: "{ ...args, permissions: role.permissions, cache: createSupplierReadCache() }",
    tests: ["settled cash sale AP preserves the viewer gate and refuses foreign or deleted sales", "settled application AP preserves the viewer gate and refuses foreign or missing applications and hidden sales", "settled opening AP preserves the viewer gate and refuses foreign or missing drafts", "settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles", "settled multi-row AP and AR preserve denied and allowed source links"] },
  { file: "convex/supplierStatement.ts", caller: "settled", exportedQuery: "settled", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.receivable", scope: "{ ...args, permissions: role.permissions, cache: createSupplierReadCache() }",
    tests: ["settled cash sale AR preserves the viewer gate and refuses foreign or deleted sales", "settled application AR preserves the viewer gate and refuses foreign or missing applications and hidden sales", "settled opening AR preserves the viewer gate and refuses foreign or missing drafts", "settled expense vehicle AR preserves the viewer gate and refuses foreign or deleted sources", "settled multi-row AP and AR preserve denied and allowed source links", "settled partially recovered opening and expense rows preserve denied and allowed viewer gates"] },
  { file: "convex/supplierStatement.ts", caller: "outstanding", exportedQuery: "outstanding", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.payable", scope: "{ ...args, permissions: role.permissions, cache }",
    tests: ["opening link gate checks local targets across every navigation condition", "vehicle link gate checks local targets across every navigation condition", "outstanding multi-row AP and AR preserve denied and allowed source links"] },
  { file: "convex/supplierStatement.ts", caller: "outstanding", exportedQuery: "outstanding", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.receivable", scope: "{ ...args, permissions: role.permissions, cache }",
    tests: ["sales link gate checks local targets across every navigation condition part 1 of 2", "sales link gate checks local targets across every navigation condition part 2 of 2", "application lookup checks local deleted and missing targets across every navigation condition", "outstanding multi-row AP and AR preserve denied and allowed source links"] },
  { file: "convex/supplierRelationships.ts", caller: "project", exportedQuery: null, callee: "supplierVehicleHref",
    arguments: "vehicle.orgId, vehicle._id, permissions", scope: "permissions: readonly string[]",
    tests: ["relationship query preserves the viewer vehicle permission for sourced and owned rows", "relationship multi-row large and endCursor pages preserve both viewer gates"] },
  { file: "convex/utils/supplierNavigation.ts", caller: "vehicleSource", exportedQuery: null, callee: "supplierVehicleHref",
    arguments: "args.orgId, vehicle._id, args.permissions", scope: "args: NavigationArgs",
    tests: ["settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles", "vehicle link gate checks local targets across every navigation condition"] },
];

export function callableNavigationExports(source: ts.SourceFile): string[] {
  const checker = identifierChecker(source);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Cannot enumerate navigation exports. ${updateTable}`);
  // Fail closed on EVERY callable export, regardless of parameter spelling,
  // array aliases, imported scope types or renamed permissions properties.
  // The two non-permission helpers are separately pinned by the original 22 hashes.
  return checker.getExportsOfModule(moduleSymbol).filter(symbol =>
    checker.getTypeOfSymbolAtLocation(symbol, source).getCallSignatures().length > 0)
    .map(symbol => symbol.name).filter(name => !["supplierVehicleLabel", "supplierNavigationFailure"].includes(name)).sort();
}

function isNavigationModule(source: ts.SourceFile, specifier: ts.Expression): boolean {
  if (!ts.isStringLiteral(specifier) && !ts.isNoSubstitutionTemplateLiteral(specifier)) return false;
  const target = ts.resolveModuleName(specifier.text, join(root, source.fileName), CALLER_COMPILER_OPTIONS, ts.sys).resolvedModule?.resolvedFileName;
  return target !== undefined && resolve(target) === resolve(root, "convex/utils/supplierNavigation.ts");
}

function callerCompilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(`Cannot read caller module-resolution options. ${updateTable}`);
  const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
  if (converted.errors.length) throw new Error(`Cannot parse caller module-resolution options. ${updateTable}`);
  return converted.options;
}

const CALLER_COMPILER_OPTIONS = callerCompilerOptions();

function navigationImportBindings(source: ts.SourceFile, statement: ts.ImportDeclaration, names: readonly string[]): [string, string][] {
  if (!isNavigationModule(source, statement.moduleSpecifier)) return [];
  const imported = statement.importClause?.namedBindings;
  if (!imported) throw new Error(`${source.fileName}: default helper import is unsupported. ${updateTable}`);
  if (ts.isNamespaceImport(imported)) return names.map(name => [`${imported.name.text}.${name}`, name]);
  return imported.elements.flatMap(element => {
    const name = (element.propertyName ?? element.name).text;
    return names.includes(name) ? [[element.name.text, name]] : [];
  });
}

function navigationBindings(source: ts.SourceFile, names: readonly string[]): Map<string, string> {
  for (const statement of source.statements.filter(ts.isExportDeclaration)) {
    if (statement.moduleSpecifier && isNavigationModule(source, statement.moduleSpecifier)) {
      throw new Error(`${source.fileName}:${source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1}: review navigation re-export callers and bind their behaviour. ${updateTable}`);
    }
  }
  const own: [string, string][] = source.fileName === "convex/utils/supplierNavigation.ts" ? names.map(name => [name, name]) : [];
  const forwarding: [string, string][] = source.fileName === "convex/supplierRelationships.ts" ? [["project", "project"]] : [];
  return new Map([...own, ...forwarding, ...source.statements.filter(ts.isImportDeclaration).flatMap(statement => navigationImportBindings(source, statement, names))]);
}

function enclosingCaller(node: ts.Node): { caller: string; exportedQuery: string | null } {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return { caller: parent.name?.text ?? "anonymous", exportedQuery: null };
    if (ts.isVariableDeclaration(parent) && parent.initializer && ts.isCallExpression(parent.initializer) &&
      parent.initializer.expression.getText() === "query") {
      return { caller: parent.name.getText(), exportedQuery: parent.name.getText() };
    }
  }
  throw new Error(`Unbound navigation caller at ${node.getSourceFile().fileName}. ${updateTable}`);
}

function scopeDeclaration(source: ts.SourceFile, node: ts.Expression, checker: ts.TypeChecker): string {
  const base = ts.isPropertyAccessExpression(node) ? node.expression : node;
  const declarations = checker.getSymbolAtLocation(base)?.declarations ?? [];
  const declaration = declarations[0];
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return declaration.initializer.getText(source);
  if (declaration && ts.isParameter(declaration)) return declaration.getText(source);
  return node.getText(source); // Inline scopes are pinned too; an unreviewed shape differs from the literal table.
}

function navigationReference(source: ts.SourceFile, node: ts.Node): string {
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    return `${node.expression.getText(source)}.${node.argumentExpression.text}`;
  }
  return node.getText(source);
}

function dynamicNavigationTarget(source: ts.SourceFile, node: ts.Node): ts.Expression | undefined {
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (!ts.isCallExpression(node)) return undefined;
  const expression = node.expression;
  if (expression.kind === ts.SyntaxKind.ImportKeyword || expression.getText(source) === "require" ||
    ts.isPropertyAccessExpression(expression) && expression.name.text === "require") return node.arguments[0];
  return undefined;
}

export function refuseDynamicNavigation(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    const target = dynamicNavigationTarget(source, node);
    if (target && isNavigationModule(source, target)) throw new Error(
      `${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: dynamic navigation import/require must become a reviewed static caller. ${updateTable}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function sourceNavigationCallers(source: ts.SourceFile, names: readonly string[]): (NavigationCaller & { line: number })[] {
  refuseDynamicNavigation(source);
  const bindings = navigationBindings(source, names);
  if (!bindings.size) return [];
  const checker = identifierChecker(source);
  const found: (NavigationCaller & { line: number })[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return; // Type queries in generated declarations do not invoke a helper.
    const callee = ts.isCallExpression(node) ? bindings.get(navigationReference(source, node.expression)) : undefined;
    if (callee && ts.isCallExpression(node)) {
      const scope = node.arguments[callee === "addSupplierRowContext" ? 1 : 2];
      if (!scope) throw new Error(`${source.fileName}: missing navigation scope. ${updateTable}`);
      found.push({ file: source.fileName, ...enclosingCaller(node), callee,
        arguments: node.arguments.map(argument => argument.getText(source)).join(", "), scope: scopeDeclaration(source, scope, checker),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    refuseBareNavigationNamespace(source, node, bindings);
    refuseNavigationAlias(source, node, bindings);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function refuseBareNavigationNamespace(source: ts.SourceFile, node: ts.Node, bindings: Map<string, string>): void {
  if (!ts.isIdentifier(node)) return;
  if (![...bindings.keys()].some(name => name.startsWith(`${node.text}.`))) return;
  const parent = node.parent;
  if (ts.isNamespaceImport(parent)) return;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return;
  if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteral(parent.argumentExpression)) return;
  throw new Error(`${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: review computed or aliased navigation namespace ${node.text}. ${updateTable}`);
}

function refuseNavigationAlias(source: ts.SourceFile, node: ts.Node, bindings: Map<string, string>): void {
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
  if (!bindings.has(navigationReference(source, node))) return;
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isFunctionDeclaration(parent) || ts.isNamespaceImport(parent)) return;
  if (ts.isCallExpression(parent) && parent.expression === node) return;
  throw new Error(`${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: non-call navigation reference ${node.getText(source)}; review aliases and bind its public-query behaviour. ${updateTable}`);
}

function callerLocation(caller: NavigationCaller): string {
  const source = parse(caller.file);
  const declaration = source.statements.find(statement => {
    if (ts.isFunctionDeclaration(statement)) return statement.name?.text === caller.caller;
    return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === caller.caller);
  });
  return `${caller.file}:${source.getLineAndCharacterOfPosition(declaration?.getStart(source) ?? source.end).line + 1}`;
}

function boundCallerCell(node: ts.Node, caller: NavigationCaller): boolean {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
  if (caller.caller === "project" || caller.caller === "vehicles") return node.expression.text === "relationshipCells";
  if (node.expression.text !== "navigationCells") return false;
  if (caller.caller === "vehicleSource") return node.arguments[1]?.getText().includes('"viewVehicles"') === true;
  const mode = node.arguments[3];
  const query = mode && ts.isStringLiteral(mode) ? mode.text : "outstanding";
  const role = node.arguments[4];
  return query === caller.exportedQuery && (!role || role.getText() === (caller.arguments.endsWith("result.payable") ? '"AP"' : '"AR"'));
}

function testHasCallerCells(source: ts.SourceFile, title: string, caller: NavigationCaller): boolean {
  const body = literalTestBody(source, title);
  if (body?.statements.length !== 1) return false;
  const call = awaitedCallerCall(body.statements[0]!);
  return call !== null && boundCallerCell(call, caller);
}

export function assertCallerTests(caller: typeof NAVIGATION_CALLERS[number], syntax: ts.SourceFile,
  active: readonly ReturnType<typeof listActiveTestRegistrations>[number][]): void {
  const location = callerLocation(caller);
  expect(caller.tests.length, `${location}: ${caller.caller} needs behavioural cells. ${updateTable}`).toBeGreaterThan(0);
  for (const title of caller.tests) {
    const message = `${location}: ${caller.caller} / ${caller.arguments} needs active literal behavioural test ${title}. ${updateTable}`;
    expect(active.filter(test => test.title === title).length, message).toBe(1);
    expect(testHasCallerCells(syntax, title, caller), message).toBe(true);
  }
}

function callerPin({ file, caller, exportedQuery, callee, arguments: argumentText, scope }: NavigationCaller): NavigationCaller {
  return { file, caller, exportedQuery, callee, arguments: argumentText, scope };
}

export function assertNavigationCallerSweep(quarter: 0 | 1 | 2 | 3): void {
  const names = callableNavigationExports(parse("convex/utils/supplierNavigation.ts"));
  const allFiles = ts.sys.readDirectory(join(root, "convex"), [".ts"], ["**/*.test.ts", "**/*.spec.ts", "**/_generated/**"]).sort();
  const allRelative = new Set(allFiles.map(file => relative(root, file).replaceAll("\\", "/")));
  for (const pin of NAVIGATION_CALLERS) expect(allRelative.has(pin.file), "Pinned caller file must remain inside the recursive sweep").toBe(true);
  const files = allFiles.filter((_, index) => index % 4 === quarter);
  const measuredFiles = new Set(files.map(file => relative(root, file).replaceAll("\\", "/")));
  expect(files.length, "The recursive Convex caller sweep must not be empty").toBeGreaterThan(0);
  const found = files.flatMap(file => {
    const text = readFileSync(file, "utf8");
    if (!text.includes("supplierNavigation") && !names.some(name => text.includes(name))) return [];
    const source = ts.createSourceFile(relative(root, file).replaceAll("\\", "/"), text, ts.ScriptTarget.Latest, true);
    return sourceNavigationCallers(source, names);
  });
  for (const current of found) expect(NAVIGATION_CALLERS.map(callerPin),
    `${current.file}:${current.line}: added caller or changed scope ${current.caller} / ${current.arguments}. ${updateTable}; add literal cells and a scenario before updating NAVIGATION_CALLERS`)
    .toContainEqual(callerPin(current));
  for (const pin of NAVIGATION_CALLERS.filter(pin => measuredFiles.has(pin.file)).map(callerPin)) {
    expect(found.filter(caller => JSON.stringify(callerPin(caller)) === JSON.stringify(pin)).length,
      `${callerLocation(pin)}: removed or changed caller ${pin.caller} / ${pin.arguments}. ${updateTable}; review its behavioural binding`).toBe(1);
  }
}
