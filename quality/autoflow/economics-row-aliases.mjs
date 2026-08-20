import ts from "typescript";

import { unwrapExpression } from "./ast-utils.mjs";

export function isUseOfBinding(identifier, bindings, provenance) {
  return (
    ts.isIdentifier(identifier) &&
    [...bindings].some((binding) => provenance.isUseOf(identifier, binding))
  );
}

export function directAlias(expression, bindings, provenance) {
  const current = unwrapExpression(expression);
  return (
    ts.isIdentifier(current) && isUseOfBinding(current, bindings, provenance)
  );
}

export function valueContainsAlias(expression, bindings, provenance) {
  const current = unwrapExpression(expression);
  if (directAlias(current, bindings, provenance)) return true;
  if (ts.isSpreadElement(current) || ts.isSpreadAssignment(current)) {
    return valueContainsAlias(current.expression, bindings, provenance);
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.some(
      (element) =>
        !ts.isOmittedExpression(element) &&
        valueContainsAlias(element, bindings, provenance),
    );
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) {
        return valueContainsAlias(property.expression, bindings, provenance);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return isUseOfBinding(property.name, bindings, provenance);
      }
      return (
        ts.isPropertyAssignment(property) &&
        valueContainsAlias(property.initializer, bindings, provenance)
      );
    });
  }
  if (ts.isConditionalExpression(current)) {
    return (
      valueContainsAlias(current.whenTrue, bindings, provenance) ||
      valueContainsAlias(current.whenFalse, bindings, provenance)
    );
  }
  return false;
}

function rootIdentifier(expression) {
  let current = unwrapExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function argumentIndex(expression, functionNode, provenance) {
  if (ts.isArrowFunction(functionNode)) return undefined;
  const current = unwrapExpression(expression);
  if (!ts.isElementAccessExpression(current) || !current.argumentExpression) {
    return undefined;
  }
  const owner = unwrapExpression(current.expression);
  if (
    !ts.isIdentifier(owner) ||
    owner.text !== "arguments" ||
    provenance.hasBinding(owner)
  ) {
    return undefined;
  }
  const index = unwrapExpression(current.argumentExpression);
  if (ts.isNumericLiteral(index)) return Number(index.text);
  return ts.isStringLiteral(index) && /^\d+$/.test(index.text)
    ? Number(index.text)
    : undefined;
}

function directMappedArgumentAlias(
  expression,
  functionNode,
  bindings,
  provenance,
) {
  const index = argumentIndex(expression, functionNode, provenance);
  const parameter =
    index === undefined ? undefined : functionNode.parameters[index];
  return Boolean(
    parameter &&
    ts.isIdentifier(parameter.name) &&
    bindings.has(parameter.name),
  );
}

function mappedArgumentTargetAlias(target, functionNode, bindings, provenance) {
  let current = unwrapExpression(target);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    if (
      directMappedArgumentAlias(current, functionNode, bindings, provenance)
    ) {
      return true;
    }
    current = unwrapExpression(current.expression);
  }
  return false;
}

function mutationTarget(node) {
  if (ts.isDeleteExpression(node)) return node.expression;
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
    node.operatorToken.kind > ts.SyntaxKind.LastAssignment
  ) {
    return undefined;
  }
  return node.left;
}

export function mutationTargetsAlias(node, bindings, provenance, functionNode) {
  const target = mutationTarget(node);
  if (!target) return false;
  const root = rootIdentifier(target);
  return (
    Boolean(root && isUseOfBinding(root, bindings, provenance)) ||
    Boolean(
      functionNode &&
      mappedArgumentTargetAlias(target, functionNode, bindings, provenance),
    )
  );
}

export function declarationAliases(node, bindings, provenance) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    directAlias(node.initializer, bindings, provenance)
  );
}
