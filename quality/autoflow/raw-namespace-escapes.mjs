import ts from "typescript";

import { memberObject, staticString, unwrapAwait } from "./ast-utils.mjs";

const RAW_MUTATION_BUILDERS = new Set(["mutation", "internalMutation"]);

function operationName(expression, valueDeclarations) {
  const current = unwrapAwait(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (!ts.isElementAccessExpression(current)) return undefined;
  return staticString(current.argumentExpression, valueDeclarations);
}

function unshadowedBuiltinMember(
  expression,
  objectName,
  operation,
  provenance,
  valueDeclarations,
) {
  const object = memberObject(expression);
  return (
    operationName(expression, valueDeclarations) === operation &&
    object &&
    ts.isIdentifier(object) &&
    object.text === objectName &&
    !provenance.hasBinding(object)
  );
}

function argumentValue(argument) {
  return ts.isSpreadElement(argument) ? argument.expression : argument;
}

function hasNamespaceArgument(node, isNamespace) {
  return (node.arguments ?? []).some((argument) =>
    isNamespace(argumentValue(argument)),
  );
}

function inspectReflectGet(node, context) {
  if (
    !ts.isCallExpression(node) ||
    !unshadowedBuiltinMember(
      node.expression,
      "Reflect",
      "get",
      context.provenance,
      context.valueDeclarations,
    ) ||
    !node.arguments[0] ||
    !context.isNamespace(argumentValue(node.arguments[0]))
  ) {
    return false;
  }
  const name = node.arguments[1]
    ? staticString(node.arguments[1], context.valueDeclarations)
    : undefined;
  if (name === undefined || RAW_MUTATION_BUILDERS.has(name)) {
    context.report(
      node,
      name
        ? `Reflect.get accesses raw ${name} from the ${context.namespaceLabel}.`
        : `Reflect.get cannot prove that mutation/internalMutation is excluded from the ${context.namespaceLabel}.`,
    );
  }
  return true;
}

function inspectObjectAssign(node, context) {
  if (
    !ts.isCallExpression(node) ||
    !unshadowedBuiltinMember(
      node.expression,
      "Object",
      "assign",
      context.provenance,
      context.valueDeclarations,
    ) ||
    !hasNamespaceArgument(node, context.isNamespace)
  ) {
    return false;
  }
  context.report(
    node,
    `Object.assign exposes the ${context.namespaceLabel}, including raw mutation builders; copy explicitly named query/action members instead.`,
  );
  return true;
}

function objectPropertyValue(property) {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  if (ts.isSpreadAssignment(property)) return property.expression;
  return undefined;
}

function inspectObjectContainment(node, context) {
  if (!ts.isObjectLiteralExpression(node)) return;
  for (const property of node.properties) {
    // Spread copies remain provenance-tracked by raw-namespace-provenance;
    // explicit properties hide the namespace behind a new member path.
    if (ts.isSpreadAssignment(property)) continue;
    const value = objectPropertyValue(property);
    if (!value || !context.isNamespace(value)) continue;
    context.report(
      property,
      `Object containment exposes the ${context.namespaceLabel}, including raw mutation builders; store explicitly named query/action members instead.`,
    );
  }
}

function inspectArrayContainment(node, context) {
  if (!ts.isArrayLiteralExpression(node)) return;
  for (const element of node.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (!context.isNamespace(argumentValue(element))) continue;
    context.report(
      element,
      `Array containment exposes the ${context.namespaceLabel}, including raw mutation builders; store explicitly named query/action members instead.`,
    );
  }
}

function inspectCallEscape(node, context, handledBuiltin) {
  if (
    handledBuiltin ||
    (!ts.isCallExpression(node) && !ts.isNewExpression(node)) ||
    !hasNamespaceArgument(node, context.isNamespace)
  ) {
    return;
  }
  context.report(
    node,
    `Passing the ${context.namespaceLabel} to a call exposes raw mutation builders through unverified code; pass explicitly named query/action members instead.`,
  );
}

/** Fails closed when a proven generated-server namespace escapes provenance. */
export function inspectNamespaceEscapes(node, context) {
  const normalizedContext = {
    namespaceLabel: "generated-server namespace",
    ...context,
  };
  const reflected = inspectReflectGet(node, normalizedContext);
  const assigned = inspectObjectAssign(node, normalizedContext);
  inspectObjectContainment(node, normalizedContext);
  inspectArrayContainment(node, normalizedContext);
  inspectCallEscape(node, normalizedContext, reflected || assigned);
}
