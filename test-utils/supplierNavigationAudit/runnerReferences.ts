import ts from "typescript";
import { runnerStatementName, runnerDirectCall, runnerRefusal, runnerRoot, runnerMember, runnerProtectedNames, runnerWriteTarget } from "./runnerSyntax";
import { ADMITTED_RUNNER_REFERENCES } from "./referenceAdmissions";
import { expect } from "vitest";

function runnerBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  const namedBinding = ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) ||
    ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent);
  const namedType = ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeParameterDeclaration(parent);
  const namedImport = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent);
  return (namedBinding || namedType || namedImport || ts.isEnumDeclaration(parent) || ts.isModuleDeclaration(parent)) && parent.name === node;
}

function runnerPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (ts.isImportSpecifier(parent)) return parent.propertyName === node;
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return true;
  if (ts.isShorthandPropertyAssignment(parent) || ts.isExportSpecifier(parent)) return false;
  return (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node;
}

function runnerStatementBindings(statement: ts.Statement): ts.Identifier[] {
  if (ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return statement.name ? [statement.name] : [];
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name] : []);
  if (!ts.isImportDeclaration(statement)) return [];
  const bindings: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && runnerBindingIdentifier(node)) bindings.push(node);
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return bindings;
}

function runnerPinnedBindings(source: ts.SourceFile): ReadonlySet<ts.Identifier> {
  const bindings = source.statements.flatMap(runnerStatementBindings);
  const first = new Map<string, ts.Identifier>();
  for (const binding of bindings) if (!first.has(binding.text)) first.set(binding.text, binding);
  return new Set(first.values());
}

function runnerReferenceSite(source: ts.SourceFile, node: ts.Node): string {
  const statement = ts.findAncestor(node, candidate => ts.isStatement(candidate) && ts.isSourceFile(candidate.parent));
  if (statement && ts.isStatement(statement)) {
    const name = runnerStatementName(statement, source);
    if (name) return "declaration:" + name;
  }
  const registration = ts.findAncestor(node, candidate => ts.isCallExpression(candidate) &&
    ["test", "describe", "it"].includes(candidate.expression.getText(source)));
  if (registration && ts.isCallExpression(registration) && ts.isStringLiteral(registration.arguments[0]!)) {
    return "registration:" + registration.arguments[0]!.text;
  }
  return "unreviewed";
}

function runnerReferenceForm(node: ts.Identifier): string {
  if (runnerDirectCall(node)) return "call";
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) return "member:" + node.parent.name.text;
  return "value";
}

function assertRunnerReference(source: ts.SourceFile, node: ts.Identifier, counts: Map<string, number>): void {
  const site = runnerReferenceSite(source, node) + "/" + runnerReferenceForm(node);
  if (ADMITTED_RUNNER_REFERENCES[node.text]?.[site] === undefined) {
    runnerRefusal(source, node, `ADMITTED_RUNNER_REFERENCES refuses reference ${node.text} at ${site}`);
  }
  if (["navigationCells", "relationshipCells"].includes(node.text) &&
    (!site.startsWith("registration:") || !runnerDirectCall(node))) {
    runnerRefusal(source, node, `ADMITTED_RUNNER_REFERENCES requires pinned runner ${node.text} as direct registration callee`);
  }
  const key = node.text + "@" + site;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function assertRunnerCallback(source: ts.SourceFile, node: ts.CallExpression): void {
  if (!["test", "describe", "it"].includes(node.expression.getText(source))) return;
  const callback = node.arguments[1];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || callback.parameters.length !== 0) {
    runnerRefusal(source, node, "ADMITTED_RUNNER_REFERENCES requires a zero-parameter test/describe/it callback; no context exceptions exist");
  }
}

function runnerLocalSymbol(checker: ts.TypeChecker, root: ts.Node, enclosing?: ts.Node): boolean {
  if (!ts.isIdentifier(root)) return false;
  const symbol = ts.isShorthandPropertyAssignment(root.parent)
    ? checker.getShorthandAssignmentValueSymbol(root.parent) : checker.getSymbolAtLocation(root);
  const declarations = symbol?.declarations ?? [];
  return declarations.some(declaration => declaration.getSourceFile() === root.getSourceFile() &&
    (!enclosing || ts.findAncestor(declaration, candidate => candidate === enclosing) !== undefined));
}

function runnerRootNode(node: ts.Node): ts.Node {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return runnerRootNode(node.expression);
  return node;
}

function refuseNonlocalRunnerWrite(source: ts.SourceFile, checker: ts.TypeChecker, target: ts.Node): void {
  if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
    ts.forEachChild(target, child => refuseNonlocalRunnerWrite(source, checker, child));
    return;
  }
  if (ts.isPropertyAssignment(target)) return refuseNonlocalRunnerWrite(source, checker, target.initializer);
  if (ts.isSpreadAssignment(target) || ts.isSpreadElement(target)) return refuseNonlocalRunnerWrite(source, checker, target.expression);
  const root = ts.isShorthandPropertyAssignment(target) ? target.name : runnerRootNode(target);
  if (!runnerLocalSymbol(checker, root)) runnerRefusal(source, target, "ADMITTED_RUNNER_REFERENCES refuses mutation of a root not declared in this file");
}

const RUNNER_INTRINSIC_MUTATORS = ["Object.defineProperty", "Object.defineProperties", "Object.assign", "Object.setPrototypeOf",
  "Reflect.set", "Reflect.defineProperty", "Reflect.setPrototypeOf"];

function runnerErasedWrapper(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion | ts.SatisfiesExpression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node);
}

function runnerIntrinsicName(node: ts.Node): string | undefined {
  if (runnerErasedWrapper(node)) return runnerIntrinsicName(node.expression);
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
  const owner = runnerRoot(node.expression);
  const member = runnerMember(node);
  const name = `${owner}.${member}`;
  return RUNNER_INTRINSIC_MUTATORS.includes(name) ? name : undefined;
}

function runnerInvocation(node: ts.Node): ts.CallExpression | undefined {
  const parent = node.parent;
  if (runnerErasedWrapper(parent) && parent.expression === node) return runnerInvocation(parent);
  return ts.isCallExpression(parent) && parent.expression === node ? parent : undefined;
}

function refuseRunnerIntrinsicReference(source: ts.SourceFile, node: ts.Node): void {
  if (runnerIntrinsicName(node) && !runnerInvocation(node)) {
    runnerRefusal(source, node, "intrinsic mutator reference must remain a direct call with a reviewed local target");
  }
}

function refuseRunnerIntrinsic(source: ts.SourceFile, checker: ts.TypeChecker, node: ts.CallExpression): void {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) runnerRefusal(source, node, "ADMITTED_RUNNER_REFERENCES refuses dynamic import()");
  if (!runnerIntrinsicName(node.expression)) return;
  const target = node.arguments[0];
  const enclosing = ts.findAncestor(node, ts.isFunctionLike);
  if (!target || !enclosing || !runnerLocalSymbol(checker, runnerRootNode(target), enclosing)) {
    runnerRefusal(source, node, "ADMITTED_RUNNER_REFERENCES requires an intrinsic mutator target declared inside its enclosing function");
  }
}

function runnerChecker(source: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => file === source.fileName ? source : undefined;
  return ts.createProgram([source.fileName], options, host).getTypeChecker();
}

export function assertAdmittedRunnerReferences(source: ts.SourceFile): void {
  const protectedNames = runnerProtectedNames(source);
  const pinned = runnerPinnedBindings(source);
  const counts = new Map<string, number>();
  const checker = runnerChecker(source);
  const visit = (node: ts.Node): void => {
    refuseRunnerIntrinsicReference(source, node);
    if (ts.isIdentifier(node) && protectedNames.has(node.text)) {
      if (runnerBindingIdentifier(node)) {
        if (!pinned.has(node)) runnerRefusal(source, node, `ADMITTED_RUNNER_REFERENCES refuses second binding ${node.text}`);
      } else if (!runnerPropertyName(node)) assertRunnerReference(source, node, counts);
    }
    const target = runnerWriteTarget(node);
    if (target) refuseNonlocalRunnerWrite(source, checker, target);
    if (ts.isCallExpression(node)) { assertRunnerCallback(source, node); refuseRunnerIntrinsic(source, checker, node); }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [name, sites] of Object.entries(ADMITTED_RUNNER_REFERENCES)) for (const [site, expected] of Object.entries(sites)) {
    expect(counts.get(name + "@" + site) ?? 0, `ADMITTED_RUNNER_REFERENCES ${name} at ${site}: exact reviewed reference count`).toBe(expected);
  }
}
