import ts from "typescript";

export const RUNTIME_GLOBAL_OBJECT_NAMES = new Set([
  "global",
  "globalThis",
  "self",
]);

function unwrapStaticExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function staticMemberName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!ts.isElementAccessExpression(expression)) return undefined;
  const argument = expression.argumentExpression
    ? unwrapStaticExpression(expression.argumentExpression)
    : undefined;
  return argument &&
    (ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function isUnboundIdentifier(node, name, bindings) {
  return (
    ts.isIdentifier(node) && node.text === name && !bindings.hasBinding(node)
  );
}

function isUnboundGlobalObject(node, bindings) {
  return (
    ts.isIdentifier(node) &&
    RUNTIME_GLOBAL_OBJECT_NAMES.has(node.text) &&
    !bindings.hasBinding(node)
  );
}

function isGlobalThisKeyword(node) {
  if (node.kind !== ts.SyntaxKind.ThisKeyword) return false;
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

export function workerLoaderKind(expression, bindings) {
  const current = unwrapStaticExpression(expression);
  if (isUnboundIdentifier(current, "importScripts", bindings)) {
    return "importScripts";
  }
  if (
    (ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)) &&
    staticMemberName(current) === "importScripts"
  ) {
    const owner = unwrapStaticExpression(current.expression);
    if (isUnboundGlobalObject(owner, bindings) || isGlobalThisKeyword(owner)) {
      return "importScripts";
    }
  }
  return undefined;
}
