import ts from "typescript";

import {
  propertyNameText,
  staticString,
  unwrapExpression,
} from "./ast-utils.mjs";

function callableAncestor(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function contains(scope, node) {
  let current = node;
  while (current) {
    if (current === scope) return true;
    current = current.parent;
  }
  return false;
}

function scopeDepth(scope) {
  let depth = 0;
  let current = scope;
  while (current.parent) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

function bindingScope(declaration, sourceFile) {
  let current = declaration.parent;
  while (
    current &&
    !ts.isBlock(current) &&
    !ts.isSourceFile(current) &&
    !ts.isCaseBlock(current)
  ) {
    current = current.parent;
  }
  return current ?? sourceFile;
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

function isAssignmentOperator(kind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

export function memberOperation(expression, values) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    return staticString(current.argumentExpression, values);
  }
  return undefined;
}

function recordBinding(node, sourceFile, bindings) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
  const binding = {
    name: node.name.text,
    node,
    initializer: node.initializer,
    scope: bindingScope(node, sourceFile),
  };
  const existing = bindings.get(binding.name);
  if (existing) existing.push(binding);
  else bindings.set(binding.name, [binding]);
}

function assignmentMutation(node) {
  if (
    !ts.isBinaryExpression(node) ||
    !isAssignmentOperator(node.operatorToken.kind)
  ) {
    return undefined;
  }
  const root = rootIdentifier(node.left);
  if (!root) return undefined;
  return {
    name: root.text,
    node,
    kind: ts.isIdentifier(unwrapExpression(node.left)) ? "reset" : "property",
    left: node.left,
    value: node.right,
  };
}

function updateMutation(node) {
  if (!ts.isPrefixUnaryExpression(node) && !ts.isPostfixUnaryExpression(node)) {
    return undefined;
  }
  if (
    node.operator !== ts.SyntaxKind.PlusPlusToken &&
    node.operator !== ts.SyntaxKind.MinusMinusToken
  ) {
    return undefined;
  }
  const root = rootIdentifier(node.operand);
  if (!root) return undefined;
  return {
    name: root.text,
    node,
    kind: ts.isIdentifier(unwrapExpression(node.operand))
      ? "reset"
      : "property",
    left: node.operand,
    value: undefined,
  };
}

function deletionMutation(node) {
  if (!ts.isDeleteExpression(node)) return undefined;
  const root = rootIdentifier(node.expression);
  return root
    ? { name: root.text, node, kind: "delete", left: node.expression }
    : undefined;
}

function resolvedCallExpression(call, values) {
  const callee = unwrapExpression(call.expression);
  if (!ts.isIdentifier(callee)) return callee;
  return unwrapExpression(values.resolveAt(callee.text, callee) ?? callee);
}

function callReceiver(call, values) {
  const callee = resolvedCallExpression(call, values);
  return unwrapExpression(
    ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee)
      ? callee.expression
      : callee,
  );
}

const OBJECT_CALL_MUTATIONS = new Set([
  "assign",
  "defineProperty",
  "defineProperties",
]);
const REFLECT_CALL_MUTATIONS = new Set(["set", "deleteProperty"]);

function mutationReceiverKind(receiver, operation) {
  if (!ts.isIdentifier(receiver)) return undefined;
  if (receiver.text === "Object" && OBJECT_CALL_MUTATIONS.has(operation)) {
    return "object";
  }
  if (receiver.text === "Reflect" && REFLECT_CALL_MUTATIONS.has(operation)) {
    return "reflect";
  }
  return undefined;
}

function callMutationKind(receiverKind, operation) {
  if (receiverKind !== "reflect") return operation;
  return operation === "deleteProperty" ? "reflectDelete" : "reflectSet";
}

function callMutation(node, values) {
  if (!ts.isCallExpression(node) || !node.arguments[0]) return undefined;
  const callee = resolvedCallExpression(node, values);
  const operation = memberOperation(callee, values);
  const receiver = callReceiver(node, values);
  const receiverKind = mutationReceiverKind(receiver, operation);
  if (!receiverKind) return undefined;
  const root = rootIdentifier(node.arguments[0]);
  if (!root) return undefined;
  const kind = callMutationKind(receiverKind, operation);
  return { name: root.text, node, kind, call: node };
}

export function collectBindingsAndMutations(sourceFile, values) {
  const bindings = new Map();
  const mutations = [];
  const visit = (node) => {
    recordBinding(node, sourceFile, bindings);
    const mutation =
      assignmentMutation(node) ??
      updateMutation(node) ??
      deletionMutation(node) ??
      callMutation(node, values);
    if (mutation) mutations.push(mutation);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  mutations.sort((left, right) => left.node.pos - right.node.pos);
  return { bindings, mutations };
}

export function bindingAt(records, name, useNode) {
  const eligible = (records.bindings.get(name) ?? []).filter(
    (binding) =>
      contains(binding.scope, useNode) && binding.node.pos <= useNode.pos,
  );
  if (eligible.length === 0) return undefined;
  const deepest = Math.max(
    ...eligible.map((binding) => scopeDepth(binding.scope)),
  );
  const nearest = eligible.filter(
    (binding) => scopeDepth(binding.scope) === deepest,
  );
  if (nearest.length === 1) return nearest[0];
  nearest.sort((left, right) => right.node.pos - left.node.pos);
  return nearest[0];
}

const CONDITIONAL_ANCESTORS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
]);
const SHORT_CIRCUIT_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);
const LOGICAL_ASSIGNMENTS = new Set([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function shortCircuitExpression(node) {
  return (
    ts.isBinaryExpression(node) &&
    SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind)
  );
}

export function conditionalMutation(node, callable) {
  if (
    ts.isBinaryExpression(node) &&
    LOGICAL_ASSIGNMENTS.has(node.operatorToken.kind)
  ) {
    return true;
  }
  let current = node.parent;
  while (current && current !== callable) {
    if (
      CONDITIONAL_ANCESTORS.has(current.kind) ||
      shortCircuitExpression(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function functionReturns(functionNode) {
  if (!functionNode.body) return [];
  if (!ts.isBlock(functionNode.body)) return [functionNode.body];
  const returned = [];
  const visit = (node) => {
    if (node !== functionNode.body && callableAncestor(node) !== functionNode)
      return;
    if (ts.isReturnStatement(node) && node.expression)
      returned.push(node.expression);
    else ts.forEachChild(node, visit);
  };
  visit(functionNode.body);
  return returned;
}

export function localFunction(expression, values) {
  const current = unwrapExpression(expression);
  if (
    ts.isFunctionDeclaration(current) ||
    ts.isFunctionExpression(current) ||
    ts.isArrowFunction(current)
  ) {
    return current;
  }
  if (!ts.isIdentifier(current)) return undefined;
  const resolved = values.resolveAt(current.text, current);
  const candidate = resolved ? unwrapExpression(resolved) : undefined;
  return candidate &&
    (ts.isFunctionDeclaration(candidate) ||
      ts.isFunctionExpression(candidate) ||
      ts.isArrowFunction(candidate))
    ? candidate
    : undefined;
}

function objectArgumentProperty(expression, propertyName, values) {
  let current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    const resolved = values.resolveAt(current.text, current);
    if (resolved) current = unwrapExpression(resolved);
  }
  if (!ts.isObjectLiteralExpression(current)) return undefined;
  for (const property of current.properties) {
    if (propertyNameText(property.name, values) !== propertyName) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
  return undefined;
}

function mapObjectParameter(parameter, argument, parameters, values) {
  for (const element of parameter.name.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
    const property = propertyNameText(
      element.propertyName ?? element.name,
      values,
    );
    const value = argument
      ? objectArgumentProperty(argument, property, values)
      : undefined;
    const mapped = value ?? element.initializer;
    if (mapped) parameters.set(element.name.text, mapped);
  }
}

function mapArrayParameter(parameter, argument, parameters) {
  const current = argument ? unwrapExpression(argument) : undefined;
  for (let index = 0; index < parameter.name.elements.length; index += 1) {
    const element = parameter.name.elements[index];
    if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name))
      continue;
    const mapped =
      current && ts.isArrayLiteralExpression(current)
        ? current.elements[index]
        : element.initializer;
    if (mapped) parameters.set(element.name.text, mapped);
  }
}

export function mappedParameters(functionNode, call, inherited, values) {
  const parameters = new Map(inherited);
  for (let index = 0; index < functionNode.parameters.length; index += 1) {
    const parameter = functionNode.parameters[index];
    const argument = call.arguments[index] ?? parameter.initializer;
    if (ts.isIdentifier(parameter.name)) {
      if (argument) parameters.set(parameter.name.text, argument);
    } else if (ts.isObjectBindingPattern(parameter.name)) {
      mapObjectParameter(parameter, argument, parameters, values);
    } else if (ts.isArrayBindingPattern(parameter.name)) {
      mapArrayParameter(parameter, argument, parameters);
    }
  }
  return parameters;
}

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name];
  const identifiers = [];
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      identifiers.push(...bindingIdentifiers(element.name));
    }
  }
  return identifiers;
}

export function mappedParameterBindings(functionNode, inherited = new Map()) {
  const bindings = new Map(inherited);
  for (const parameter of functionNode.parameters) {
    for (const identifier of bindingIdentifiers(parameter.name)) {
      bindings.set(identifier.text, identifier);
    }
  }
  return bindings;
}

export function directPropertyName(left, values) {
  const current = unwrapExpression(left);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    return staticString(current.argumentExpression, values);
  }
  return undefined;
}

export { callableAncestor };
