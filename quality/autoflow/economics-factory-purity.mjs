import ts from "typescript";

import { staticString, unwrapExpression } from "./ast-utils.mjs";
import { moduleHasExecutableEffects } from "./economics-module-stability.mjs";
import { localFunction } from "./economics-payload-flow.mjs";

const GLOBAL_OBJECTS = new Set(["Object", "Reflect", "globalThis", "global"]);
const GLOBAL_WRITES = new WeakMap();

function staticMember(expression, values) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    return staticString(current.argumentExpression, values);
  }
  return undefined;
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

function directGlobalWrite(node, record) {
  let expression;
  if (
    ts.isBinaryExpression(node) &&
    assignmentOperator(node.operatorToken.kind)
  ) {
    expression = node.left;
  } else if (ts.isDeleteExpression(node)) expression = node.expression;
  else if (updateExpression(node)) {
    expression = node.operand;
  }
  const root = expression ? rootIdentifier(expression) : undefined;
  return root &&
    GLOBAL_OBJECTS.has(root.text) &&
    !record.lexical.hasBinding(root)
    ? root.text
    : undefined;
}

function mutatingLibraryCall(library, operation) {
  if (!ts.isIdentifier(library)) return false;
  if (library.text === "Object") {
    return operation === "assign" || operation === "defineProperty";
  }
  return (
    library.text === "Reflect" &&
    (operation === "set" || operation === "deleteProperty")
  );
}

function globalMutationCall(node, record) {
  if (!ts.isCallExpression(node) || !node.arguments[0]) return undefined;
  const callee = unwrapExpression(node.expression);
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return undefined;
  }
  const library = unwrapExpression(callee.expression);
  const target = rootIdentifier(node.arguments[0]);
  const operation = staticMember(callee, record.values);
  return ts.isIdentifier(library) &&
    !record.lexical.hasBinding(library) &&
    mutatingLibraryCall(library, operation) &&
    target &&
    GLOBAL_OBJECTS.has(target.text) &&
    !record.lexical.hasBinding(target)
    ? target.text
    : undefined;
}

function moduleGlobalWrites(record) {
  const cached = GLOBAL_WRITES.get(record);
  if (cached) return cached;
  const writes = new Set();
  const visit = (node) => {
    if (node !== record.sourceFile && ts.isFunctionLike(node)) return;
    const name =
      directGlobalWrite(node, record) ?? globalMutationCall(node, record);
    if (name) writes.add(name);
    ts.forEachChild(node, visit);
  };
  visit(record.sourceFile);
  GLOBAL_WRITES.set(record, writes);
  return writes;
}

function localInitializers(functionNode) {
  const initializers = new Map();
  const visit = (node) => {
    if (node !== functionNode.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode.body);
  return initializers;
}

function freshLocal(name, initializers, seen = new Set()) {
  if (seen.has(name)) return false;
  const initializer = initializers.get(name);
  if (!initializer) return false;
  const current = unwrapExpression(initializer);
  if (
    ts.isObjectLiteralExpression(current) ||
    ts.isArrayLiteralExpression(current)
  ) {
    return true;
  }
  return ts.isIdentifier(current)
    ? freshLocal(current.text, initializers, new Set([...seen, name]))
    : false;
}

function mutationLibrary(call, record) {
  const callee = unwrapExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return false;
  }
  const object = unwrapExpression(callee.expression);
  const operation = staticMember(callee, record.values);
  const globalWrites = moduleGlobalWrites(record);
  if (
    !ts.isIdentifier(object) ||
    record.lexical.hasBinding(object) ||
    globalWrites.has(object.text) ||
    globalWrites.has("globalThis") ||
    globalWrites.has("global")
  ) {
    return false;
  }
  if (object.text === "Object") {
    return operation === "assign" || operation === "defineProperty";
  }
  return (
    object.text === "Reflect" &&
    (operation === "set" || operation === "deleteProperty")
  );
}

function parameterName(identifier, target) {
  const binding = target.record.lexical.bindingOf(identifier);
  let current = binding?.parent;
  while (current && current !== target.functionNode) {
    if (ts.isParameter(current) && current.parent === target.functionNode) {
      return ts.isIdentifier(current.name) ? current.name.text : undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function trustedParameter(identifier, target, context) {
  const parameter = parameterName(identifier, target);
  return Boolean(parameter && context.trustedParameters.has(parameter));
}

function freshReadSource(expression, context) {
  const current = unwrapExpression(expression);
  if (freshLiteral(current)) return true;
  const root = rootIdentifier(current);
  return Boolean(root && freshLocal(root.text, context.initializers));
}

function safePropertyRead(node, target, context) {
  const owner = unwrapExpression(node.expression);
  const root = rootIdentifier(node);
  if (!root) return freshLiteral(owner);
  if (freshLocal(root.text, context.initializers)) return true;
  return (
    owner === root &&
    trustedParameter(root, target, context) &&
    staticMember(node, target.record.values) === "economicsRevision"
  );
}

function safeCallArgument(expression, target, context) {
  const current = unwrapExpression(expression);
  return (
    freshReadSource(current, context) ||
    (ts.isIdentifier(current) && trustedParameter(current, target, context))
  );
}

function safeObjectMutation(call, record, context) {
  if (!mutationLibrary(call, record)) return false;
  const operation = staticMember(call.expression, record.values);
  if (operation === "defineProperty") return false;
  const targetExpression = call.arguments[0];
  if (!targetExpression) return false;
  if (
    operation === "assign" &&
    call.arguments.slice(1).some((source) => !freshReadSource(source, context))
  ) {
    return false;
  }
  if (freshLiteral(targetExpression)) return true;
  const targetRoot = rootIdentifier(targetExpression);
  return Boolean(
    targetRoot && freshLocal(targetRoot.text, context.initializers),
  );
}

function assignmentOperator(kind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function freshLiteral(expression) {
  const current = unwrapExpression(expression);
  return (
    ts.isObjectLiteralExpression(current) ||
    ts.isArrayLiteralExpression(current)
  );
}

function safeAssignment(node, initializers) {
  const root = rootIdentifier(node.left);
  if (!root) return false;
  const direct = ts.isIdentifier(unwrapExpression(node.left));
  if (!direct) return freshLocal(root.text, initializers);
  if (
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !initializers.has(root.text)
  ) {
    return false;
  }
  const assignedRoot = rootIdentifier(node.right);
  return (
    freshLiteral(node.right) ||
    Boolean(assignedRoot && freshLocal(assignedRoot.text, initializers))
  );
}

function updateExpression(node) {
  const update =
    ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node);
  return (
    update &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function loopTargetWrite(node) {
  return (
    (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    !ts.isVariableDeclarationList(node.initializer)
  );
}

function prohibitedNode(node) {
  return (
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isThrowStatement(node) ||
    updateExpression(node) ||
    loopTargetWrite(node)
  );
}

function functionBinding(functionNode) {
  if (ts.isFunctionDeclaration(functionNode)) return functionNode.name;
  let current = functionNode;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  const declaration = current.parent;
  return ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name)
    ? declaration.name
    : undefined;
}

function provenLocalCall(call, target) {
  const local = localFunction(call.expression, target.record.values);
  if (!local) return undefined;
  const callee = unwrapExpression(call.expression);
  const binding = functionBinding(local);
  return !ts.isIdentifier(callee) ||
    (binding && target.record.lexical.isUseOf(callee, binding))
    ? local
    : undefined;
}

function resolvedCallTarget(call, target, provenance) {
  const local = provenLocalCall(call, target);
  if (local) {
    return { status: "resolved", record: target.record, functionNode: local };
  }
  const reference = provenance.expressionReference(
    call.expression,
    target.record,
  );
  return reference ? provenance.resolveReference(reference) : undefined;
}

function safeCall(call, target, context) {
  if (safeObjectMutation(call, target.record, context)) {
    return true;
  }
  const called = resolvedCallTarget(call, target, context.provenance);
  const trustedParameters = new Set();
  for (
    let index = 0;
    index < (called?.functionNode.parameters.length ?? 0);
    index += 1
  ) {
    const parameter = called.functionNode.parameters[index];
    const argument = call.arguments[index];
    if (
      argument &&
      ts.isIdentifier(parameter.name) &&
      safeCallArgument(argument, target, context)
    ) {
      trustedParameters.add(parameter.name.text);
    }
  }
  return Boolean(
    called?.status === "resolved" &&
    factoryIsPure(called, context.provenance, context.seen, {
      trustedParameters,
    }),
  );
}

function safeDelete(node, initializers) {
  const root = rootIdentifier(node.expression);
  return Boolean(root && freshLocal(root.text, initializers));
}

function directWriteTarget(node) {
  const parent = node.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      assignmentOperator(parent.operatorToken.kind) &&
      unwrapExpression(parent.left) === node) ||
    (ts.isDeleteExpression(parent) &&
      unwrapExpression(parent.expression) === node) ||
    (updateExpression(parent) && unwrapExpression(parent.operand) === node)
  );
}

function safeMutationMember(node, target, context) {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    unwrapExpression(parent.expression) === node &&
    safeObjectMutation(parent, target.record, context)
  );
}

function unsafeImplicitRead(node, target, context) {
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    return (
      !directWriteTarget(node) &&
      !safeMutationMember(node, target, context) &&
      !safePropertyRead(node, target, context)
    );
  }
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
    return !freshReadSource(node.expression, context);
  }
  return (
    ts.isVariableDeclaration(node) &&
    !ts.isIdentifier(node.name) &&
    Boolean(node.initializer) &&
    !freshReadSource(node.initializer, context)
  );
}

function unsafeEffect(node, target, context) {
  if (prohibitedNode(node) || unsafeImplicitRead(node, target, context)) {
    return true;
  }
  if (ts.isDeleteExpression(node)) {
    return !safeDelete(node, context.initializers);
  }
  if (
    ts.isBinaryExpression(node) &&
    assignmentOperator(node.operatorToken.kind)
  ) {
    return !safeAssignment(node, context.initializers);
  }
  return ts.isCallExpression(node) && !safeCall(node, target, context);
}

/** Rejects imported factories whose execution can have unproven side effects. */
export function factoryIsPure(
  target,
  provenance,
  seen = new Set(),
  options = {},
) {
  const key = `${target.record.file}:${target.functionNode.pos}`;
  if (seen.has(key) || moduleHasExecutableEffects(target.record)) return false;
  const context = {
    initializers: localInitializers(target.functionNode),
    provenance,
    seen: new Set([...seen, key]),
    trustedParameters: options.trustedParameters ?? new Set(),
  };
  let safe = true;
  const visit = (node) => {
    if (!safe) return;
    if (
      node !== target.functionNode &&
      (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
    ) {
      safe = false;
      return;
    }
    if (node !== target.functionNode.body && ts.isFunctionLike(node)) return;
    safe = !unsafeEffect(node, target, context);
    if (safe) ts.forEachChild(node, visit);
  };
  for (const parameter of target.functionNode.parameters) {
    if (parameter.initializer) visit(parameter.initializer);
  }
  visit(target.functionNode.body);
  return safe;
}
