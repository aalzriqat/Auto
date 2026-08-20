import ts from "typescript";

import {
  isGeneratedServerModule,
  moduleText,
  unwrapAwait,
} from "./ast-utils.mjs";

function directGeneratedSpecifier(expression, provenance) {
  const current = unwrapAwait(expression);
  if (
    ts.isCallExpression(current) &&
    current.expression.kind === ts.SyntaxKind.ImportKeyword &&
    current.arguments.length === 1
  ) {
    const specifier = moduleText(current.arguments[0]);
    return specifier && isGeneratedServerModule(specifier)
      ? specifier
      : undefined;
  }
  if (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "require" &&
    !provenance.hasBinding(current.expression) &&
    current.arguments.length === 1
  ) {
    const specifier = moduleText(current.arguments[0]);
    return specifier && isGeneratedServerModule(specifier)
      ? specifier
      : undefined;
  }
  return undefined;
}

function declarationBindingForValue(value) {
  if (
    value.parent &&
    ts.isVariableDeclaration(value.parent) &&
    value.parent.initializer === value &&
    ts.isIdentifier(value.parent.name)
  ) {
    return value.parent.name;
  }
  if (ts.isFunctionDeclaration(value) && value.name) return value.name;
  return undefined;
}

function returnedExpression(functionLike) {
  if (!ts.isBlock(functionLike.body)) return functionLike.body;
  const runtimeStatements = functionLike.body.statements.filter(
    (statement) =>
      !ts.isEmptyStatement(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement),
  );
  const returns = runtimeStatements.filter(
    (statement) => ts.isReturnStatement(statement) && statement.expression,
  );
  return returns.length === 1 && runtimeStatements.at(-1) === returns[0]
    ? returns[0].expression
    : undefined;
}

/** Tracks immutable lexical values proven to be the generated server namespace. */
export function createGeneratedNamespaceResolver(
  valueDeclarations,
  provenance,
) {
  const bindings = new Map();

  const addBinding = (identifier) => {
    const existing = bindings.get(identifier.text);
    if (existing) existing.push(identifier);
    else bindings.set(identifier.text, [identifier]);
  };

  const isBoundNamespace = (identifier) =>
    (bindings.get(identifier.text) ?? []).some((target) =>
      provenance.isUseOf(identifier, target),
    );

  const resolveLocalFunction = (expression) => {
    const current = unwrapAwait(expression);
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      return current;
    }
    if (!ts.isIdentifier(current)) return undefined;
    const resolved = valueDeclarations.resolveAt(current.text, current);
    const binding = resolved && declarationBindingForValue(resolved);
    if (!binding || !provenance.isUseOf(current, binding)) return undefined;
    return resolved &&
      (ts.isArrowFunction(resolved) ||
        ts.isFunctionExpression(resolved) ||
        ts.isFunctionDeclaration(resolved))
      ? resolved
      : undefined;
  };

  const generatedSpecifier = (expression, seen = new Set()) => {
    const current = unwrapAwait(expression);
    const direct = directGeneratedSpecifier(current, provenance);
    if (direct) return direct;
    if (ts.isIdentifier(current)) {
      const resolved = valueDeclarations.resolveAt(current.text, current);
      const binding = resolved && declarationBindingForValue(resolved);
      if (
        !resolved ||
        !binding ||
        !provenance.isUseOf(current, binding) ||
        seen.has(binding)
      ) {
        return undefined;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(binding);
      return generatedSpecifier(resolved, nextSeen);
    }
    if (!ts.isCallExpression(current)) return undefined;
    const localFunction = resolveLocalFunction(current.expression);
    if (!localFunction || seen.has(localFunction)) return undefined;
    const result = returnedExpression(localFunction);
    if (!result) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(localFunction);
    return generatedSpecifier(result, nextSeen);
  };

  const isNamespace = (expression, seen = new Set()) => {
    const current = unwrapAwait(expression);
    if (ts.isIdentifier(current)) return isBoundNamespace(current);
    if (generatedSpecifier(current)) return true;
    if (!ts.isObjectLiteralExpression(current) || seen.has(current))
      return false;
    const nextSeen = new Set(seen);
    nextSeen.add(current);
    return current.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) &&
        isNamespace(property.expression, nextSeen),
    );
  };

  return { addBinding, generatedSpecifier, isNamespace, resolveLocalFunction };
}
