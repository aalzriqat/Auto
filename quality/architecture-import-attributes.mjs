import ts from "typescript";

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

function traceableModuleSpecifier(expression) {
  return ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : undefined;
}

function staticPropertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined;
}

function isStaticImportAttributes(expression) {
  const options = unwrapStaticExpression(expression);
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  if (options.properties.length !== 1) return false;

  const [withProperty] = options.properties;
  if (
    !ts.isPropertyAssignment(withProperty) ||
    staticPropertyName(withProperty.name) !== "with"
  ) {
    return false;
  }

  const attributes = unwrapStaticExpression(withProperty.initializer);
  return Boolean(
    attributes &&
    ts.isObjectLiteralExpression(attributes) &&
    attributes.properties.every(
      (attribute) =>
        ts.isPropertyAssignment(attribute) &&
        staticPropertyName(attribute.name) !== undefined &&
        ts.isStringLiteral(unwrapStaticExpression(attribute.initializer)),
    ),
  );
}

export function traceableLoaderSpecifier(node, loaderKind) {
  if (node.questionDotToken) return undefined;
  const validArguments =
    node.arguments.length === 1 ||
    (loaderKind === "import" &&
      node.arguments.length === 2 &&
      isStaticImportAttributes(node.arguments[1]));
  return validArguments
    ? traceableModuleSpecifier(node.arguments[0])
    : undefined;
}
