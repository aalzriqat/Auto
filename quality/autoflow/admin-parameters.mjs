import ts from "typescript";

import { unwrapExpression } from "./ast-utils.mjs";

function inertDefaultExpression(expression) {
  const current = unwrapExpression(expression);
  if (
    ts.isStringLiteral(current) ||
    ts.isNumericLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.every(
      (element) =>
        !ts.isSpreadElement(element) && inertDefaultExpression(element),
    );
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.every((property) => {
      if (!ts.isPropertyAssignment(property)) return false;
      if (
        ts.isComputedPropertyName(property.name) &&
        !inertDefaultExpression(property.name.expression)
      ) {
        return false;
      }
      return inertDefaultExpression(property.initializer);
    });
  }
  return false;
}

function bindingInitializersAreInert(name) {
  if (ts.isIdentifier(name)) return true;
  return name.elements.every((element) => {
    if (ts.isOmittedExpression(element)) return true;
    if (
      (element.initializer && !inertDefaultExpression(element.initializer)) ||
      (element.propertyName &&
        ts.isComputedPropertyName(element.propertyName) &&
        !inertDefaultExpression(element.propertyName.expression))
    ) {
      return false;
    }
    return bindingInitializersAreInert(element.name);
  });
}

/** True when parameter evaluation cannot execute code before handler authentication. */
export function parameterInitializersAreInert(handler) {
  return handler.parameters.every(
    (parameter) =>
      (!parameter.initializer ||
        inertDefaultExpression(parameter.initializer)) &&
      bindingInitializersAreInert(parameter.name),
  );
}
