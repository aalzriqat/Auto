import ts from "typescript";

import { unwrapExpression } from "./ast-utils.mjs";

function expressionIsPrimitive(current) {
  return (
    ts.isStringLiteral(current) ||
    ts.isNumericLiteral(current) ||
    ts.isBigIntLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword
  );
}

function propertyKeyIsInert(expression) {
  return expressionIsPrimitive(unwrapExpression(expression));
}

function appendArrayValues(array, pending) {
  for (const element of array.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isSpreadElement(element)) return false;
    pending.push(element);
  }
  return true;
}

function appendObjectValues(object, pending) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) return false;
    if (
      ts.isComputedPropertyName(property.name) &&
      !propertyKeyIsInert(property.name.expression)
    ) {
      return false;
    }
    pending.push(property.initializer);
  }
  return true;
}

export function expressionIsInert(expression) {
  const pending = [expression];
  while (pending.length > 0) {
    const current = unwrapExpression(pending.pop());
    if (expressionIsPrimitive(current)) continue;
    if (ts.isArrayLiteralExpression(current)) {
      if (!appendArrayValues(current, pending)) return false;
      continue;
    }
    if (ts.isObjectLiteralExpression(current)) {
      if (!appendObjectValues(current, pending)) return false;
      continue;
    }
    return false;
  }
  return true;
}

export function bindingInitializersAreInert(name) {
  const pending = [name];
  while (pending.length > 0) {
    const current = pending.pop();
    if (ts.isIdentifier(current)) continue;
    for (const element of current.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (
        (element.initializer && !expressionIsInert(element.initializer)) ||
        (element.propertyName &&
          ts.isComputedPropertyName(element.propertyName) &&
          !propertyKeyIsInert(element.propertyName.expression))
      ) {
        return false;
      }
      pending.push(element.name);
    }
  }
  return true;
}

/** True when parameter evaluation cannot execute code before handler authentication. */
export function parameterInitializersAreInert(handler) {
  return handler.parameters.every(
    (parameter) =>
      (!parameter.initializer || expressionIsInert(parameter.initializer)) &&
      bindingInitializersAreInert(parameter.name),
  );
}
