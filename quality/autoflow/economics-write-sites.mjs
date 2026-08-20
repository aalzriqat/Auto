import ts from "typescript";

import { unwrapExpression } from "./ast-utils.mjs";
import { canonicalExpression, databaseCall } from "./economics-database.mjs";
import {
  localFunction,
  mappedParameterBindings,
  mappedParameters,
} from "./economics-payload-flow.mjs";

function writeOperation(call, analysis) {
  const write = databaseCall(call, analysis);
  return write &&
    (write.operation === "patch" || write.operation === "replace") &&
    write.arguments?.length > 1
    ? write
    : undefined;
}

function helperPayloadIsParameter(payload, parameterBindings, lexical) {
  const identifier = unwrapExpression(payload);
  const binding = ts.isIdentifier(identifier)
    ? parameterBindings.get(identifier.text)
    : undefined;
  return Boolean(binding && lexical.isUseOf(identifier, binding));
}

function callerDatabaseKey(databaseKey, parameters, analysis) {
  for (const [name, argument] of parameters) {
    if (databaseKey !== name && !databaseKey.startsWith(`${name}.`)) continue;
    const caller = canonicalExpression(argument, analysis.values);
    if (!caller) return databaseKey;
    return `${caller}${databaseKey.slice(name.length)}`;
  }
  return databaseKey;
}

function writeSite(write, node, parameters, parameterBindings, analysis) {
  const writeTarget = write.arguments[0];
  return {
    operation: write.operation,
    payload: write.arguments.at(-1),
    context: {
      useNode: node,
      writeNode: node,
      writeTarget,
      writeDatabaseKey: callerDatabaseKey(
        write.databaseKey,
        parameters,
        analysis,
      ),
      parameters,
      parameterBindings,
    },
  };
}

function helperWriteSites(call, analysis) {
  const functionNode = localFunction(call.expression, analysis.values);
  if (!functionNode?.body) return [];
  const parameters = mappedParameters(
    functionNode,
    call,
    new Map(),
    analysis.values,
  );
  const parameterBindings = mappedParameterBindings(functionNode);
  const sites = [];
  const visit = (node) => {
    if (node !== functionNode.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const write = writeOperation(node, analysis);
      const payload = write?.arguments.at(-1);
      if (
        write &&
        helperPayloadIsParameter(payload, parameterBindings, analysis.lexical)
      ) {
        sites.push(
          writeSite(write, call, parameters, parameterBindings, analysis),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode.body);
  return sites;
}

/** Returns direct writes plus local call sites that forward a payload parameter. */
export function economicsWriteSites(call, analysis) {
  const direct = writeOperation(call, analysis);
  return direct
    ? [writeSite(direct, call, new Map(), new Map(), analysis)]
    : helperWriteSites(call, analysis);
}
