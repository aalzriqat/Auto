import ts from "typescript";
import { navigationTokens } from "./fingerprints";
import { callerLiteral } from "./callerCells";
import { expect } from "vitest";
import { AUTH_HELPER_CONTRACTS } from "./authorizationContracts";
import { AUTH_CONDITION_PAIRS } from "./authorizationPairs";

export function authorizationConditions(source: ts.SourceFile, name: string): string[] {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error("Authorization condition inventory missing " + name);
  const conditions: string[] = [];
  const add = (kind: string, node: ts.Node) => conditions.push(name + "/" + kind + ":" + navigationTokens(node, source).join(" "));
  const visit = (node: ts.Node): void => {
    authorizationControl(source, node);
    if (ts.isIfStatement(node)) add("if", node.expression);
    if (ts.isConditionalExpression(node)) add("ternary", node.condition);
    if (ts.isBinaryExpression(node)) for (const decision of authorizationBinaryDecisions(node)) add(decision.kind, decision.node);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) add("negation", node);
    // PLAN_GATE_LABELS selects refusal text, not admission; the helper pin covers it.
    if (ts.isElementAccessExpression(node) && navigationTokens(node, source).join("") !== "PLAN_GATE_LABELS[gate]") add("lookup", node);
    if (ts.isReturnStatement(node) && node.expression && declaration.type &&
      (declaration.type.kind === ts.SyntaxKind.BooleanKeyword || ts.isTypePredicateNode(declaration.type)) &&
      ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.expression.kind)) add("return", node.expression);
    if (ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.expression) &&
      ["filter", "every"].includes(node.parent.expression.name.text)) add("predicate-" + node.parent.expression.name.text, node.body);
    ts.forEachChild(node, visit);
  };
  for (const parameter of declaration.parameters) if (parameter.initializer) visit(parameter.initializer);
  visit(declaration.body);
  return conditions;
}

function authorizationBinaryDecisions(node: ts.BinaryExpression): readonly { kind: string; node: ts.Node }[] {
  const operator = node.operatorToken.kind;
  if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(operator)) {
    return [{ kind: "logical", node }, ...authorizationAtoms(node).map(atom => ({ kind: "atom", node: atom }))];
  }
  if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword].includes(operator)) {
    return [{ kind: "comparison", node }];
  }
  if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(operator)) return [{ kind: "conditional-binary", node }];
  return [];
}

function authorizationAtoms(node: ts.Node): readonly ts.Node[] {
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
    return [...authorizationAtoms(node.left), ...authorizationAtoms(node.right)];
  }
  return [node];
}

function authorizationControl(source: ts.SourceFile, node: ts.Node): void {
  if (ts.isIterationStatement(node, false) || ts.isSwitchStatement(node) || ts.isTryStatement(node) || ts.isWithStatement(node) ||
    ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) {
    throw new Error(source.fileName + ": unreviewed authorization control " + ts.SyntaxKind[node.kind]);
  }
  const reviewedLookup = ts.isElementAccessExpression(node) &&
    ["PLANS[planId]", "PLANS[planId].gates[gate]", "PLAN_GATE_LABELS[gate]"].includes(navigationTokens(node, source).join(""));
  if (ts.isOptionalChain(node) || (ts.isElementAccessExpression(node) && !reviewedLookup) ||
    (ts.isNewExpression(node) && !["Set", "ConvexError"].includes(node.expression.getText(source)))) {
    throw new Error(source.fileName + ": unreviewed authorization control " + ts.SyntaxKind[node.kind]);
  }
}

function authLiteralRows(source: ts.SourceFile): readonly (readonly unknown[])[] {
  const statement = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(source) === "AUTH_DECISION_ROWS");
  if (!statement || !ts.isVariableStatement(statement)) throw new Error("Missing literal AUTH_DECISION_ROWS");
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) throw new Error("Missing auth decision rows");
  const rows = callerLiteral(initializer, "AUTH_DECISION_ROWS");
  if (!Array.isArray(rows) || rows.length === 0 || rows.some(row => !Array.isArray(row) || row.length !== 9)) throw new Error("Non-empty literal auth decision rows required");
  return rows;
}

export function assertAuthorizationPairs(source: ts.SourceFile): void {
  const rows = authLiteralRows(source);
  const ids = rows.map(row => row[0]);
  expect(new Set(ids).size, "auth row ids must be unique").toBe(rows.length);
  for (const helper of AUTH_HELPER_CONTRACTS) for (const id of helper.killRows) {
    expect(ids, helper.name + ": behavioural kill row must exist and execute").toContain(id);
  }
  for (const [condition, pairs] of AUTH_CONDITION_PAIRS) {
    expect(pairs.length, condition + ": missing literal outcome pair").toBeGreaterThan(0);
    for (const [leftId, rightId] of pairs) {
      const left = rows.find(row => row[0] === leftId);
      const right = rows.find(row => row[0] === rightId);
      if (!left || !right) throw new Error(condition + ": missing paired auth row");
      expect([left[7], left[8]], condition + ": paired literal outcomes must differ").not.toStrictEqual([right[7], right[8]]);
    }
  }
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "assertAuthDecisionRows") {
      const values = node.arguments[0] && callerLiteral(node.arguments[0], "executed auth rows");
      if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Auth row execution requires literal ids");
      calls.push(...values);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(calls.toSorted(), "every auth row must execute exactly once in literal registrations").toStrictEqual([...ids].sort());
}
