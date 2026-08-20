import ts from "typescript";

import { unwrapExpression } from "./ast-utils.mjs";
import { verifiedReadOnlyImportedCall } from "./economics-imported-helper-proof.mjs";
import { localFunction } from "./economics-payload-flow.mjs";
import {
  declarationAliases,
  directAlias,
  isUseOfBinding,
  mutationTargetsAlias,
  valueContainsAlias,
} from "./economics-row-aliases.mjs";
import { createLexicalBindingProvenance } from "./lexical-binding-provenance.mjs";

const OBJECT_MUTATORS = new Set([
  "assign",
  "defineProperties",
  "defineProperty",
  "setPrototypeOf",
]);
const REFLECT_MUTATORS = new Set([
  "defineProperty",
  "deleteProperty",
  "set",
  "setPrototypeOf",
]);
const FUNCTION_INVOCATION_METHODS = new Set(["apply", "bind", "call"]);

function callableAncestor(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function variableBindingForUse(identifier, values, provenance) {
  const resolved = values.resolveAt(identifier.text, identifier);
  let current = resolved;
  while (current?.parent && !ts.isVariableDeclaration(current.parent)) {
    const parent = current.parent;
    if (unwrapExpression(parent) !== unwrapExpression(current)) break;
    current = parent;
  }
  const declaration = current?.parent;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !provenance.isUseOf(identifier, declaration.name)
  ) {
    return undefined;
  }
  return declaration.name;
}

function parameterBindingForUse(identifier, provenance) {
  const callable = callableAncestor(identifier);
  if (!callable) return undefined;
  for (const parameter of callable.parameters) {
    if (
      ts.isIdentifier(parameter.name) &&
      provenance.isUseOf(identifier, parameter.name)
    ) {
      return parameter.name;
    }
  }
  return undefined;
}

function bindingForUse(identifier, values, provenance) {
  return (
    variableBindingForUse(identifier, values, provenance) ??
    parameterBindingForUse(identifier, provenance)
  );
}

function collectAliases(scope, initialBindings, stop, provenance) {
  const bindings = new Set(initialBindings);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      if (node.pos >= stop.pos) return;
      if (declarationAliases(node, bindings, provenance)) {
        if (!bindings.has(node.name)) {
          bindings.add(node.name);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
  }
  return bindings;
}

function callbackForExpression(expression, state) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    for (const [binding, callback] of state.functionArguments ?? []) {
      if (state.provenance.isUseOf(current, binding)) return callback;
    }
  }
  return localFunction(current, state.values);
}

function localParameterBindings(arguments_, functionNode, bindings, state) {
  const parameters = new Set();
  const functionArguments = new Map(state.functionArguments);
  let unsupportedContainer = false;
  const parameterCount = Math.max(
    arguments_.length,
    functionNode.parameters.length,
  );
  for (let index = 0; index < parameterCount; index += 1) {
    const parameter = functionNode.parameters[index];
    const argument = arguments_[index] ?? parameter?.initializer;
    if (!argument) continue;
    const callback = callbackForExpression(argument, state);
    if (callback && parameter && ts.isIdentifier(parameter.name)) {
      functionArguments.set(parameter.name, callback);
    }
    if (!valueContainsAlias(argument, bindings, state.provenance)) continue;
    if (
      directAlias(argument, bindings, state.provenance) &&
      parameter &&
      ts.isIdentifier(parameter.name)
    ) {
      parameters.add(parameter.name);
    } else {
      unsupportedContainer = true;
    }
  }
  return { functionArguments, parameters, unsupportedContainer };
}

function arrayArguments(expression) {
  const current = expression ? unwrapExpression(expression) : undefined;
  if (!current || !ts.isArrayLiteralExpression(current)) return undefined;
  return current.elements.filter((element) => !ts.isOmittedExpression(element));
}

function appliedInvocation(functionNode, arguments_, fallback, thisArgument) {
  return arguments_
    ? { arguments: arguments_, functionNode, thisArgument }
    : {
        arguments: fallback,
        functionNode,
        thisArgument,
        unknownApply: true,
      };
}

function reflectApplyInvocation(call, operation, receiver, state) {
  if (
    operation !== "apply" ||
    !receiver ||
    !ts.isIdentifier(receiver) ||
    receiver.text !== "Reflect"
  ) {
    return undefined;
  }
  const functionNode = call.arguments[0]
    ? callbackForExpression(call.arguments[0], state)
    : undefined;
  if (!functionNode) return undefined;
  return appliedInvocation(
    functionNode,
    arrayArguments(call.arguments[2]),
    call.arguments.slice(2),
    call.arguments[1],
  );
}

function functionMethodInvocation(call, operation, receiver, state) {
  if (!FUNCTION_INVOCATION_METHODS.has(operation) || !receiver) {
    return undefined;
  }
  const functionNode = callbackForExpression(receiver, state);
  if (!functionNode) return undefined;
  const arguments_ =
    operation === "apply"
      ? arrayArguments(call.arguments[1])
      : call.arguments.slice(1);
  return appliedInvocation(
    functionNode,
    arguments_,
    call.arguments.slice(1),
    call.arguments[0],
  );
}

function localInvocation(call, state) {
  const direct = callbackForExpression(call.expression, state);
  if (direct) return { arguments: call.arguments, functionNode: direct };
  const operation = memberName(call.expression);
  const receiver = callReceiver(call);
  return (
    reflectApplyInvocation(call, operation, receiver, state) ??
    functionMethodInvocation(call, operation, receiver, state)
  );
}

function returnEscapesAlias(node, bindings, provenance) {
  return (
    (ts.isReturnStatement(node) || ts.isYieldExpression(node)) &&
    node.expression &&
    valueContainsAlias(node.expression, bindings, provenance)
  );
}

function returnedCallbackHasUnsafeEffect(node, bindings, state) {
  if (
    (!ts.isReturnStatement(node) && !ts.isYieldExpression(node)) ||
    !node.expression
  ) {
    return false;
  }
  const callback = callbackForExpression(node.expression, state);
  return Boolean(
    callback && functionHasUnsafeEffect(callback, bindings, state),
  );
}

function assignmentEscapesAlias(node, bindings, provenance) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !valueContainsAlias(node.right, bindings, provenance)
  ) {
    return false;
  }
  const left = unwrapExpression(node.left);
  return !(ts.isIdentifier(left) && isUseOfBinding(left, bindings, provenance));
}

function callReceiver(call) {
  const callee = unwrapExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return undefined;
  }
  return unwrapExpression(callee.expression);
}

function memberName(expression) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    (ts.isStringLiteral(current.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(current.argumentExpression))
  ) {
    return current.argumentExpression.text;
  }
  return undefined;
}

function knownMutatorExposesAlias(call, bindings, state) {
  const receiver = callReceiver(call);
  if (!receiver || !ts.isIdentifier(receiver) || !call.arguments[0]) {
    return false;
  }
  const operation = memberName(call.expression);
  const objectMutation =
    receiver.text === "Object" && OBJECT_MUTATORS.has(operation);
  const reflectMutation =
    receiver.text === "Reflect" && REFLECT_MUTATORS.has(operation);
  return (
    (objectMutation || reflectMutation) &&
    valueContainsAlias(call.arguments[0], bindings, state.provenance)
  );
}

function functionHasUnsafeEffect(functionNode, inheritedBindings, state) {
  if (state.seenFunctions.has(functionNode)) return true;
  const seenFunctions = new Set([...state.seenFunctions, functionNode]);
  const bindings = collectAliases(
    functionNode,
    inheritedBindings,
    functionNode.end,
    state.provenance,
  );
  if (
    functionNode.body &&
    !ts.isBlock(functionNode.body) &&
    valueContainsAlias(functionNode.body, bindings, state.provenance)
  ) {
    return true;
  }
  let unsafe = false;
  const visit = (node) => {
    if (unsafe) return;
    if (node !== functionNode && ts.isFunctionLike(node)) return;
    if (
      mutationTargetsAlias(node, bindings, state.provenance, functionNode) ||
      assignmentEscapesAlias(node, bindings, state.provenance) ||
      returnEscapesAlias(node, bindings, state.provenance) ||
      returnedCallbackHasUnsafeEffect(node, bindings, {
        ...state,
        seenFunctions,
      })
    ) {
      unsafe = true;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      valueContainsAlias(node.initializer, bindings, state.provenance) &&
      !declarationAliases(node, bindings, state.provenance)
    ) {
      unsafe = true;
      return;
    }
    if (
      invocationHasUnsafeEffect(node, bindings, {
        ...state,
        seenFunctions,
      })
    ) {
      unsafe = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode.body ?? functionNode);
  return unsafe;
}

function callbackHasUnsafeEffect(argument, bindings, state) {
  const callback = callbackForExpression(argument, state);
  return Boolean(
    callback && functionHasUnsafeEffect(callback, bindings, state),
  );
}

function verifiedImportedRowCall(call, callee, bindings, state) {
  return (
    !call.questionDotToken &&
    ts.isIdentifier(callee) &&
    call.arguments.length === 1 &&
    directAlias(call.arguments[0], bindings, state.provenance) &&
    verifiedReadOnlyImportedCall(callee, state)
  );
}

function unknownCallExposesAlias(call, bindings, state) {
  const receiver = callReceiver(call);
  if (receiver && valueContainsAlias(receiver, bindings, state.provenance)) {
    return true;
  }
  if (knownMutatorExposesAlias(call, bindings, state)) return true;
  const carriesAlias = call.arguments.some((argument) =>
    valueContainsAlias(argument, bindings, state.provenance),
  );
  const callee = unwrapExpression(call.expression);
  if (carriesAlias && !verifiedImportedRowCall(call, callee, bindings, state))
    return true;
  if (
    receiver &&
    ts.isIdentifier(receiver) &&
    receiver.text === "Reflect" &&
    memberName(call.expression) === "construct" &&
    call.arguments[1] &&
    valueContainsAlias(call.arguments[1], bindings, state.provenance)
  ) {
    return true;
  }
  return call.arguments.some((argument) =>
    callbackHasUnsafeEffect(argument, bindings, state),
  );
}

function callHasUnsafeEffect(call, bindings, state) {
  const invocation = localInvocation(call, state);
  if (!invocation) return unknownCallExposesAlias(call, bindings, state);
  if (
    invocation.thisArgument &&
    valueContainsAlias(invocation.thisArgument, bindings, state.provenance)
  ) {
    return true;
  }
  if (
    invocation.unknownApply &&
    invocation.arguments.some((argument) =>
      valueContainsAlias(argument, bindings, state.provenance),
    )
  ) {
    return true;
  }
  const mapped = localParameterBindings(
    invocation.arguments,
    invocation.functionNode,
    bindings,
    state,
  );
  if (mapped.unsupportedContainer) return true;
  return functionHasUnsafeEffect(
    invocation.functionNode,
    new Set([...bindings, ...mapped.parameters]),
    { ...state, functionArguments: mapped.functionArguments },
  );
}

function newHasUnsafeEffect(node, bindings, state) {
  const arguments_ = node.arguments ?? [];
  const functionNode = callbackForExpression(node.expression, state);
  if (!functionNode) {
    return arguments_.some(
      (argument) =>
        valueContainsAlias(argument, bindings, state.provenance) ||
        callbackHasUnsafeEffect(argument, bindings, state),
    );
  }
  const mapped = localParameterBindings(
    arguments_,
    functionNode,
    bindings,
    state,
  );
  return (
    mapped.unsupportedContainer ||
    functionHasUnsafeEffect(
      functionNode,
      new Set([...bindings, ...mapped.parameters]),
      { ...state, functionArguments: mapped.functionArguments },
    )
  );
}

function taggedTemplateHasUnsafeEffect(node, bindings, state) {
  if (ts.isNoSubstitutionTemplateLiteral(node.template)) return false;
  return node.template.templateSpans.some(
    (span) =>
      valueContainsAlias(span.expression, bindings, state.provenance) ||
      callbackHasUnsafeEffect(span.expression, bindings, state),
  );
}

function invocationHasUnsafeEffect(node, bindings, state) {
  if (ts.isCallExpression(node)) {
    return callHasUnsafeEffect(node, bindings, state);
  }
  if (ts.isNewExpression(node)) {
    return newHasUnsafeEffect(node, bindings, state);
  }
  return (
    ts.isTaggedTemplateExpression(node) &&
    taggedTemplateHasUnsafeEffect(node, bindings, state)
  );
}

function bindingScope(binding, useNode) {
  return (
    callableAncestor(binding) ??
    callableAncestor(useNode) ??
    binding.getSourceFile()
  );
}

/** Proves that a loaded row and its direct aliases did not escape before use. */
export function createRowEscapeAnalyzer(sourceFile, values, options = {}) {
  const provenance = createLexicalBindingProvenance(sourceFile);
  return {
    remainsTrusted(identifier, useNode) {
      const binding = bindingForUse(identifier, values, provenance);
      if (!binding || !useNode) return false;
      const scope = bindingScope(binding, useNode);
      const bindings = collectAliases(scope, [binding], useNode, provenance);
      const state = {
        functionArguments: new Map(),
        moduleSources: options.moduleSources,
        provenance,
        seenFunctions: new Set(),
        sourceFile,
        values,
        verifiedImports: new Map(),
      };
      let unsafe = false;
      const visit = (node) => {
        if (unsafe || node.pos >= useNode.pos) return;
        if (node.end <= binding.end) return;
        if (callableAncestor(node) !== callableAncestor(useNode)) {
          ts.forEachChild(node, visit);
          return;
        }
        if (
          mutationTargetsAlias(node, bindings, provenance) ||
          assignmentEscapesAlias(node, bindings, provenance)
        ) {
          unsafe = true;
          return;
        }
        if (invocationHasUnsafeEffect(node, bindings, state)) {
          unsafe = true;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(scope);
      return !unsafe;
    },
  };
}
