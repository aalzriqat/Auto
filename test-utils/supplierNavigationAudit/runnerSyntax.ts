import ts from "typescript";
import { reviewedRunnerFixtureHook, RUNNER_FINGERPRINTS, RUNNER_TYPES } from "./runnerPolicyFixtures";

export function runnerStatementName(node: ts.Statement, source: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return node.name?.text;
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map(declaration => declaration.name.getText(source)).join(",");
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "afterEach") return "afterEach";
}

export function runnerRefusal(source: ts.SourceFile, node: ts.Node, reason: string): never {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  throw new Error(`${source.fileName}:${line}: ADMITTED_RUNNER_REFERENCES: ${reason}: ${node.getText(source).slice(0, 160)}; rerun the runner mutants before reviewing this statement`);
}

export function runnerRegistration(node: ts.Statement, source: ts.SourceFile): boolean {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
  const call = node.expression;
  return ["test", "describe"].includes(call.expression.getText(source)) &&
    call.arguments.length === 2 && ts.isStringLiteral(call.arguments[0]!) &&
    (ts.isArrowFunction(call.arguments[1]!) || ts.isFunctionExpression(call.arguments[1]!));
}

export function runnerRoot(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return runnerRoot(node.expression);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return runnerRoot(node.expression);
  if (ts.isCallExpression(node)) return runnerRoot(node.expression);
}

function protectedRunnerTarget(node: ts.Node, protectedNames: ReadonlySet<string>): boolean {
  const name = runnerRoot(node);
  if (name) return protectedNames.has(name);
  // Destructuring writes retain the same prohibition, including nested targets.
  if (ts.isShorthandPropertyAssignment(node)) return protectedNames.has(node.name.text);
  if (ts.isPropertyAssignment(node)) return protectedRunnerTarget(node.initializer, protectedNames);
  if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) return protectedRunnerTarget(node.expression, protectedNames);
  if (ts.isObjectLiteralExpression(node)) return node.properties.some(child => protectedRunnerTarget(child, protectedNames));
  if (ts.isArrayLiteralExpression(node)) return node.elements.some(child => protectedRunnerTarget(child, protectedNames));
  return false;
}

export function runnerWriteTarget(node: ts.Node): ts.Node | undefined {
  if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
    !ts.isVariableDeclarationList(node.initializer)) return node.initializer;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return node.left;
  if (ts.isDeleteExpression(node)) return node.expression;
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) return node.operand;
}

export function runnerMember(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
}

const RUNNER_HOOKS = ["beforeAll", "beforeEach", "afterAll", "afterEach", "onTestFinished", "onTestFailed", "aroundEach", "aroundAll"];

const RUNNER_EXPECT_MUTATORS = ["extend", "addSnapshotSerializer", "addEqualityTesters", "setState"];

const RUNNER_VI_MUTATORS = ["mock", "doMock", "hoisted"];

export function runnerDirectCall(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function allowedRunnerApiValue(source: ts.SourceFile, node: ts.Identifier, teardown: ts.Statement | undefined): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return true;
  if (RUNNER_HOOKS.includes(node.text)) return runnerDirectCall(node) &&
    (node.text === "afterEach" && parent.parent === teardown || reviewedRunnerFixtureHook(source, parent));
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return true;
  if (!runnerDirectCall(node)) return false;
  return ["expect", "test", "describe"].includes(node.text);
}

function reviewedRunnerContext(source: ts.SourceFile, node: ts.Node): boolean {
  const statement = ts.findAncestor(node, candidate => ts.isStatement(candidate) && ts.isSourceFile(candidate.parent));
  const name = statement && ts.isStatement(statement) ? runnerStatementName(statement, source) : undefined;
  return name !== undefined && RUNNER_FINGERPRINTS.some(pin => pin.name === name);
}

function sensitiveRunnerMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const owner = runnerRoot(node);
  const member = runnerMember(node);
  if (RUNNER_HOOKS.includes(member ?? "")) return true;
  if (owner === "expect") return !member || RUNNER_EXPECT_MUTATORS.includes(member);
  if (owner === "vi") return !member || RUNNER_VI_MUTATORS.includes(member) ||
    ["spyOn", "stubGlobal"].includes(member) && !runnerDirectCall(node);
  return owner === "test" || owner === "describe";
}

function refuseRunnerApiReference(source: ts.SourceFile, node: ts.Node, teardown: ts.Statement | undefined): void {
  if (ts.isIdentifier(node) && ["expect", "vi", "test", "describe", ...RUNNER_HOOKS].includes(node.text) && !allowedRunnerApiValue(source, node, teardown)) {
    runnerRefusal(source, node, "a test API value cannot escape through an alias or argument");
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) refuseRunnerMemberReference(source, node);
}

function refuseRunnerMemberReference(source: ts.SourceFile, node: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
  if (sensitiveRunnerMember(node)) runnerRefusal(source, node, "forbidden test API member reference, including aliases and computed members");
  if (runnerRoot(node) === "vi" && !reviewedRunnerContext(source, node)) runnerRefusal(source, node, "vi APIs belong in reviewed pinned helpers");
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "expect") return;
  const member = runnerMember(node);
  if (["any", "arrayContaining", "objectContaining"].includes(member ?? "") && runnerDirectCall(node)) return;
  if (member === "getState" && runnerDirectCall(node) && reviewedRunnerContext(source, node)) return;
  runnerRefusal(source, node, "unreviewed static expect API reference");
}

function refuseRunnerCall(source: ts.SourceFile, node: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
  protectedNames: ReadonlySet<string>, teardown: ts.Statement | undefined): void {
  const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
  const member = runnerMember(callee);
  const rootName = runnerRoot(callee);
  if (rootName && ["test", "describe"].includes(rootName) && member !== rootName) runnerRefusal(source, node, "modified test registrations are forbidden");
  if (member === "eval" || member === "Function") runnerRefusal(source, node, "dynamic execution is outside the runner census");
  if (member && RUNNER_HOOKS.includes(member) && node.parent !== teardown && !reviewedRunnerFixtureHook(source, node)) runnerRefusal(source, node, "only pinned teardown and scoped fixture hooks are allowed");
  if (runnerRoot(callee) === "expect" && RUNNER_EXPECT_MUTATORS.includes(member ?? "")) {
    runnerRefusal(source, node, "matcher customization is forbidden");
  }
  if (runnerRoot(callee) !== "vi") return;
  if (RUNNER_VI_MUTATORS.includes(member ?? "")) runnerRefusal(source, node, "runner mocks are forbidden");
  if (!["spyOn", "stubGlobal"].includes(member ?? "") || ts.isTaggedTemplateExpression(node)) return;
  const target = node.arguments?.[0];
  if (target && (protectedRunnerTarget(target, protectedNames) || ts.isStringLiteral(target) && protectedNames.has(target.text))) {
    runnerRefusal(source, node, "mocking a protected runner binding is forbidden");
  }
}

export function runnerProtectedNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = [...RUNNER_FINGERPRINTS.map(pin => pin.name), ...RUNNER_TYPES.map(pin => pin.name)];
  for (const node of source.statements.filter(ts.isImportDeclaration)) {
    const clause = node.importClause;
    if (clause?.name) names.push(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map(binding => binding.name.text));
  }
  return new Set(names);
}

export function refuseRunnerOverrides(source: ts.SourceFile): void {
  const protectedNames = runnerProtectedNames(source);
  const teardown = source.statements.find(node => runnerStatementName(node, source) === "afterEach");
  const visit = (node: ts.Node): void => {
    refuseRunnerApiReference(source, node, teardown);
    if (ts.isIdentifier(node) && ["eval", "Function"].includes(node.text)) runnerRefusal(source, node, "dynamic execution identifier is forbidden");
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) runnerRefusal(source, node, "classes are forbidden in the behavioural test file");
    const target = runnerWriteTarget(node);
    if (target && protectedRunnerTarget(target, protectedNames)) runnerRefusal(source, node, "write to a protected top-level runner binding");
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) refuseRunnerCall(source, node, protectedNames, teardown);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
