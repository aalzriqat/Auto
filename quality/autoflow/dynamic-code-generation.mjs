import ts from "typescript";

const DYNAMIC_CODE_GENERATORS = new Set(["eval", "Function"]);
const REFLECTION_GLOBALS = new Set(["Reflect"]);
const GLOBAL_FUNCTIONS = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "Function",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "String",
]);
const FUNCTION_VALUE_MEMBERS = new Set(["apply", "bind", "call", "toString"]);
const ARRAY_FUNCTION_MEMBERS = new Set([
  "at",
  "concat",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "map",
  "pop",
  "push",
  "reduce",
  "reduceRight",
  "reverse",
  "shift",
  "slice",
  "some",
  "sort",
  "splice",
  "unshift",
  "values",
]);
const OBJECT_PROTOTYPE_FUNCTION_MEMBERS = new Set([
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);
const SAFE_FUNCTION_METADATA_MEMBERS = new Set(["length", "name"]);
const LOADER_CAPABLE_CODE =
  /\b(?:constructor|eval|Function|global|globalThis|import|module|process|require|return|this)\b/u;

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

function expressionEnvelope(node) {
  let current = node;
  while (
    current.parent &&
    unwrapStaticExpression(current.parent) === current &&
    current.parent !== current
  ) {
    current = current.parent;
  }
  return current;
}

function staticMemberName(expression, bindings) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!ts.isElementAccessExpression(expression)) return undefined;
  const argument = expression.argumentExpression
    ? unwrapStaticExpression(expression.argumentExpression)
    : undefined;
  return boundStaticStringValue(argument, bindings);
}

function staticStringValue(expression) {
  const current = unwrapStaticExpression(expression);
  if (!current) return undefined;
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return current.text;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValue(current.left);
    const right = staticStringValue(current.right);
    return left === undefined || right === undefined
      ? undefined
      : `${left}${right}`;
  }
  return undefined;
}

function boundStaticStringValue(expression, bindings, seen = new Set()) {
  const direct = staticStringValue(expression);
  if (direct !== undefined || !bindings) return direct;
  const current = unwrapStaticExpression(expression);
  if (!ts.isIdentifier(current)) return undefined;
  const binding = bindings.bindingOf(current);
  if (!binding || seen.has(binding)) return undefined;
  seen.add(binding);
  const declaration = binding.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.name !== binding ||
    !declaration.initializer ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    return undefined;
  }
  return boundStaticStringValue(declaration.initializer, bindings, seen);
}

function isUnboundIdentifierIn(node, names, bindings) {
  return (
    ts.isIdentifier(node) && names.has(node.text) && !bindings.hasBinding(node)
  );
}

function isIdentifierReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (parent.name === node && !ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }
  if (parent.propertyName === node) return false;
  if (ts.isQualifiedName(parent) || ts.isTypeNode(parent)) return false;
  return true;
}

function dynamicCodeGenerationViolation(sourceFile, modulePath, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile, false),
  );
  return {
    kind: "DYNAMIC CODE GENERATION",
    rule: "runtime-imports-resolve",
    from: modulePath,
    line: start.line + 1,
    column: start.character + 1,
    message:
      "Do not use eval or Function-family code generation in audited runtime modules; generated code can hide repository dependencies and cycles.",
  };
}

function directCodeGeneratorViolation(sourceFile, modulePath, node, bindings) {
  if (
    (!isUnboundIdentifierIn(node, DYNAMIC_CODE_GENERATORS, bindings) &&
      !isDestructuredFunctionConstructor(node, bindings)) ||
    !isIdentifierReference(node) ||
    ts.isTypeOfExpression(expressionEnvelope(node).parent)
  ) {
    return undefined;
  }
  return dynamicCodeGenerationViolation(sourceFile, modulePath, node);
}

function bindingElementPropertyName(element, bindings) {
  if (element.dotDotDotToken) return undefined;
  const propertyName = element.propertyName ?? element.name;
  if (ts.isIdentifier(propertyName)) return propertyName.text;
  if (!ts.isComputedPropertyName(propertyName)) return undefined;
  return boundStaticStringValue(propertyName.expression, bindings);
}

function isDestructuredFunctionConstructor(identifier, bindings) {
  if (!ts.isIdentifier(identifier)) return false;
  const binding = bindings.bindingOf(identifier);
  const element = binding?.parent;
  if (
    !binding ||
    !element ||
    !ts.isBindingElement(element) ||
    bindingElementPropertyName(element, bindings) !== "constructor" ||
    !ts.isObjectBindingPattern(element.parent)
  ) {
    return false;
  }
  const declaration = element.parent.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    Boolean(declaration.parent.flags & ts.NodeFlags.Const) &&
    Boolean(declaration.initializer) &&
    isFunctionProducingExpression(declaration.initializer, bindings)
  );
}

function propertyDeclarationName(node) {
  const name = node.name;
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return ts.isComputedPropertyName(name)
    ? staticStringValue(name.expression)
    : undefined;
}

function isFunctionLikeValue(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isClassDeclaration(node)
  );
}

function boundRuntimeValue(identifier, bindings, seen) {
  const binding = bindings.bindingOf(identifier);
  if (!binding || seen.has(binding)) return undefined;
  seen.add(binding);
  const declaration = binding.parent;
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isClassExpression(declaration)
  ) {
    return declaration;
  }
  return ts.isVariableDeclaration(declaration) && declaration.name === binding
    ? declaration.initializer
    : undefined;
}

function resolveRuntimeExpression(expression, bindings, seen) {
  const current = unwrapStaticExpression(expression);
  if (!ts.isIdentifier(current)) return current;
  const value = boundRuntimeValue(current, bindings, seen);
  return value ? resolveRuntimeExpression(value, bindings, seen) : current;
}

function objectPropertyValue(property) {
  if (ts.isMethodDeclaration(property)) return property;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return undefined;
}

function objectMemberProducesFunction(object, member, bindings, seen) {
  const property = object.properties.find(
    (candidate) => propertyDeclarationName(candidate) === member,
  );
  const value = property ? objectPropertyValue(property) : undefined;
  return value
    ? isFunctionProducingExpression(value, bindings, seen)
    : OBJECT_PROTOTYPE_FUNCTION_MEMBERS.has(member);
}

function objectConstructorProducesFunction(object, bindings, seen) {
  const property = object.properties.find(
    (candidate) => propertyDeclarationName(candidate) === "constructor",
  );
  if (!property) return true;
  const value = objectPropertyValue(property);
  return value ? isFunctionProducingExpression(value, bindings, seen) : false;
}

function literalHasFunctionConstructor(node, bindings, seen) {
  const current = resolveRuntimeExpression(node, bindings, seen);
  if (ts.isObjectLiteralExpression(current)) {
    return objectConstructorProducesFunction(current, bindings, seen);
  }
  return (
    ts.isArrayLiteralExpression(current) ||
    ts.isStringLiteral(current) ||
    ts.isNumericLiteral(current) ||
    ts.isRegularExpressionLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword
  );
}

function propertyProducesFunction(node, bindings, seen) {
  const member = staticMemberName(node, bindings);
  if (member === undefined) return false;
  const owner = unwrapStaticExpression(node.expression);
  if (member === "constructor") {
    return (
      isFunctionProducingExpression(owner, bindings, seen) ||
      literalHasFunctionConstructor(owner, bindings, seen)
    );
  }
  if (
    FUNCTION_VALUE_MEMBERS.has(member) &&
    isFunctionProducingExpression(owner, bindings, seen)
  ) {
    return true;
  }
  const resolvedOwner = resolveRuntimeExpression(owner, bindings, seen);
  if (ts.isArrayLiteralExpression(resolvedOwner)) {
    return ARRAY_FUNCTION_MEMBERS.has(member);
  }
  return ts.isObjectLiteralExpression(resolvedOwner)
    ? objectMemberProducesFunction(resolvedOwner, member, bindings, seen)
    : false;
}

function callProducesFunction(node, bindings, seen) {
  const callee = unwrapStaticExpression(node.expression);
  return (
    (ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee)) &&
    staticMemberName(callee, bindings) === "bind" &&
    isFunctionProducingExpression(callee.expression, bindings, seen)
  );
}

function isFunctionProducingExpression(expression, bindings, seen = new Set()) {
  const current = unwrapStaticExpression(expression);
  if (isFunctionLikeValue(current)) return true;
  if (isUnboundIdentifierIn(current, GLOBAL_FUNCTIONS, bindings)) return true;
  if (ts.isIdentifier(current)) {
    const value = boundRuntimeValue(current, bindings, seen);
    return value ? isFunctionProducingExpression(value, bindings, seen) : false;
  }
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return propertyProducesFunction(current, bindings, seen);
  }
  return ts.isCallExpression(current)
    ? callProducesFunction(current, bindings, seen)
    : false;
}

function isFunctionPrototypeLookup(node, bindings) {
  const current = unwrapStaticExpression(node);
  if (!ts.isCallExpression(current) || current.arguments.length !== 1) {
    return false;
  }
  const callee = unwrapStaticExpression(current.expression);
  return (
    (ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee)) &&
    staticMemberName(callee, bindings) === "getPrototypeOf" &&
    isUnboundIdentifierIn(
      unwrapStaticExpression(callee.expression),
      GLOBAL_FUNCTIONS,
      bindings,
    ) &&
    unwrapStaticExpression(callee.expression).text === "Object" &&
    isFunctionProducingExpression(current.arguments[0], bindings)
  );
}

function isSafeFunctionMetadataUse(node, bindings) {
  const envelope = expressionEnvelope(node);
  const parent = envelope.parent;
  if (ts.isTypeOfExpression(parent)) return true;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    unwrapStaticExpression(parent.expression) ===
      unwrapStaticExpression(envelope) &&
    SAFE_FUNCTION_METADATA_MEMBERS.has(staticMemberName(parent, bindings))
  );
}

function constructorInvocation(node) {
  const envelope = expressionEnvelope(node);
  const parent = envelope.parent;
  if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) {
    return undefined;
  }
  return unwrapStaticExpression(parent.expression) ===
    unwrapStaticExpression(envelope)
    ? parent
    : undefined;
}

function hasLoaderCapableCodeArgument(node) {
  return (node.arguments ?? []).some((argument) => {
    const source = staticStringValue(argument);
    return source === undefined || LOADER_CAPABLE_CODE.test(source);
  });
}

function constructorCodeGenerationViolation(
  sourceFile,
  modulePath,
  node,
  bindings,
) {
  if (
    (!ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)) ||
    staticMemberName(node, bindings) !== "constructor" ||
    isSafeFunctionMetadataUse(node, bindings)
  ) {
    return undefined;
  }
  const owner = unwrapStaticExpression(node.expression);
  const nestedConstructor =
    (ts.isPropertyAccessExpression(owner) ||
      ts.isElementAccessExpression(owner)) &&
    staticMemberName(owner, bindings) === "constructor";
  const invocation = constructorInvocation(node);
  const executableUnknownConstructor =
    invocation && hasLoaderCapableCodeArgument(invocation);
  if (
    !executableUnknownConstructor &&
    !nestedConstructor &&
    !isFunctionPrototypeLookup(owner, bindings) &&
    !isFunctionProducingExpression(owner, bindings)
  ) {
    return undefined;
  }
  return dynamicCodeGenerationViolation(sourceFile, modulePath, node);
}

function reflectiveConstructorViolation(
  sourceFile,
  modulePath,
  node,
  bindings,
) {
  if (!ts.isCallExpression(node) || node.arguments.length < 2) {
    return undefined;
  }
  const callee = resolveImmutableAlias(node.expression, bindings);
  if (
    (!ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)) ||
    staticMemberName(callee, bindings) !== "get" ||
    !isUnboundIdentifierIn(
      unwrapStaticExpression(callee.expression),
      REFLECTION_GLOBALS,
      bindings,
    ) ||
    boundStaticStringValue(node.arguments[1], bindings) !== "constructor" ||
    !isFunctionProducingExpression(node.arguments[0], bindings) ||
    isSafeFunctionMetadataUse(node, bindings)
  ) {
    return undefined;
  }
  return dynamicCodeGenerationViolation(sourceFile, modulePath, node);
}

function resolveImmutableAlias(expression, bindings, seen = new Set()) {
  const current = unwrapStaticExpression(expression);
  if (!ts.isIdentifier(current)) return current;
  const binding = bindings.bindingOf(current);
  if (!binding || seen.has(binding)) return current;
  const declaration = binding.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.name !== binding ||
    !declaration.initializer ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    return current;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(binding);
  return resolveImmutableAlias(declaration.initializer, bindings, nextSeen);
}

export function codeGenerationViolationForNode(
  sourceFile,
  modulePath,
  node,
  bindings,
) {
  return (
    directCodeGeneratorViolation(sourceFile, modulePath, node, bindings) ??
    constructorCodeGenerationViolation(
      sourceFile,
      modulePath,
      node,
      bindings,
    ) ??
    reflectiveConstructorViolation(sourceFile, modulePath, node, bindings)
  );
}
