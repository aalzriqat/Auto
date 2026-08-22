import ts from "typescript";

const CONDITIONAL_KINDS = new Set([
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);
const SHORT_CIRCUIT_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function statementBoundary(node) {
  let current = node;
  while (current.parent) {
    if (
      ts.isStatement(current) &&
      (ts.isSourceFile(current.parent) || ts.isBlock(current.parent))
    ) {
      return current;
    }
    if (ts.isFunctionLike(current) && current !== node) return undefined;
    current = current.parent;
  }
  return undefined;
}

function writeBoundaries(node) {
  const boundaries = [];
  let current = node;
  while (current.parent) {
    if (
      ts.isStatement(current) &&
      (ts.isSourceFile(current.parent) || ts.isBlock(current.parent))
    ) {
      boundaries.push(current);
    }
    if (ts.isFunctionLike(current)) break;
    current = current.parent;
  }
  return boundaries;
}

function conditionalExecution(node) {
  if (CONDITIONAL_KINDS.has(node.kind) || ts.isFunctionLike(node)) return true;
  return (
    ts.isBinaryExpression(node) &&
    SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind)
  );
}

function unconditionallyEvaluated(call, statement) {
  let current = call.parent;
  while (current && current !== statement) {
    if (conditionalExecution(current)) return false;
    current = current.parent;
  }
  return current === statement;
}

/** Whether a call is unconditionally evaluated before a later write. */
export function callDominatesWrite(call, writeNode) {
  const callStatement = statementBoundary(call);
  if (!callStatement || !unconditionallyEvaluated(call, callStatement)) {
    return false;
  }
  return writeBoundaries(writeNode).some((boundary) => {
    if (boundary.parent !== callStatement.parent) return false;
    const statements = boundary.parent.statements;
    return statements.indexOf(callStatement) < statements.indexOf(boundary);
  });
}

export function callExpressions(sourceFile) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}
