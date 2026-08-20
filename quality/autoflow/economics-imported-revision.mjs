import ts from "typescript";

import { staticString, unwrapExpression } from "./ast-utils.mjs";
import {
  functionReturns,
  localFunction,
  mappedParameterBindings,
  mappedParameters,
} from "./economics-payload-flow.mjs";

function parameterArgument(identifier, proof) {
  const binding = proof.parameterBindings.get(identifier.text);
  return binding && proof.lexical.isUseOf(identifier, binding)
    ? proof.parameters.get(identifier.text)
    : undefined;
}

function resolvedExpression(expression, proof, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (!ts.isIdentifier(current) || seen.has(current.text)) return current;
  const parameter = parameterArgument(current, proof);
  if (parameter) return { caller: parameter };
  const resolved = proof.values.resolveAt(current.text, current);
  return resolved
    ? resolvedExpression(resolved, proof, new Set([...seen, current.text]))
    : current;
}

function numericLiteral(expression, expected, proof) {
  const current = resolvedExpression(expression, proof);
  return (
    !current.caller &&
    ts.isNumericLiteral(current) &&
    Number(current.text) === expected
  );
}

function callerOwner(expression, proof, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (!ts.isIdentifier(current) || seen.has(current.text)) return undefined;
  const parameter = parameterArgument(current, proof);
  if (parameter) return parameter;
  const resolved = proof.values.resolveAt(current.text, current);
  return resolved
    ? callerOwner(resolved, proof, new Set([...seen, current.text]))
    : undefined;
}

function revisionRead(expression, proof) {
  const current = resolvedExpression(expression, proof);
  if (
    current.caller ||
    (!ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current))
  ) {
    return false;
  }
  const name = ts.isPropertyAccessExpression(current)
    ? current.name.text
    : current.argumentExpression
      ? staticString(current.argumentExpression, proof.values)
      : undefined;
  const owner = callerOwner(current.expression, proof);
  return (
    name === "economicsRevision" && Boolean(owner && proof.ownerMatches(owner))
  );
}

function revisionBase(expression, proof) {
  const current = resolvedExpression(expression, proof);
  return (
    !current.caller &&
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    revisionRead(current.left, proof) &&
    numericLiteral(current.right, 0, proof)
  );
}

function helperBumpsRevision(call, proof) {
  const functionNode = localFunction(call.expression, proof.values);
  if (!functionNode || proof.seenFunctions.has(functionNode)) return false;
  const returns = functionReturns(functionNode);
  if (returns.length === 0) return false;
  const parameters = mappedParameters(
    functionNode,
    call,
    proof.parameters,
    proof.values,
  );
  const parameterBindings = mappedParameterBindings(
    functionNode,
    proof.parameterBindings,
  );
  const next = {
    ...proof,
    parameters,
    parameterBindings,
    seenFunctions: new Set([...proof.seenFunctions, functionNode]),
  };
  return returns.every((returned) => provenRevisionBump(returned, next));
}

function provenRevisionBump(expression, proof) {
  const current = resolvedExpression(expression, proof);
  if (current.caller)
    return proof.callerRevisionStatus(current.caller) === "bump";
  if (ts.isConditionalExpression(current)) {
    return (
      provenRevisionBump(current.whenTrue, proof) &&
      provenRevisionBump(current.whenFalse, proof)
    );
  }
  if (ts.isCallExpression(current)) return helperBumpsRevision(current, proof);
  if (
    !ts.isBinaryExpression(current) ||
    current.operatorToken.kind !== ts.SyntaxKind.PlusToken
  ) {
    return false;
  }
  return (
    (revisionBase(current.left, proof) &&
      numericLiteral(current.right, 1, proof)) ||
    (numericLiteral(current.left, 1, proof) &&
      revisionBase(current.right, proof))
  );
}

/** Proves a revision bump inside an imported payload factory at its call site. */
export function importedRevisionStatus(
  expression,
  context,
  { values, lexical, ownerMatches, callerRevisionStatus },
) {
  if (!expression) return "unsafe";
  const proof = {
    values,
    lexical,
    parameters: context.parameters ?? new Map(),
    parameterBindings: context.parameterBindings ?? new Map(),
    seenFunctions: new Set(),
    ownerMatches,
    callerRevisionStatus,
  };
  return provenRevisionBump(expression, proof) ? "bump" : "unsafe";
}
