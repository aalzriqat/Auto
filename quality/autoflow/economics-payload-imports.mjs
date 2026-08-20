import ts from "typescript";

import { unwrapExpression } from "./ast-utils.mjs";
import { createImportProvenance } from "./economics-import-provenance.mjs";
import { factoryIsPure } from "./economics-factory-purity.mjs";
import {
  functionReturns,
  mappedParameterBindings,
  mappedParameters,
} from "./economics-payload-flow.mjs";
import { createPayloadAnalyzer } from "./economics-payload.mjs";

export const UNSTABLE_IMPORTED_PAYLOAD_FIELD =
  "<unstable imported payload factory>";

function unknownPayload() {
  return [{ fields: new Set(), revision: "absent", known: false }];
}

function unstableImportedPayload() {
  return [
    {
      fields: new Set([UNSTABLE_IMPORTED_PAYLOAD_FIELD]),
      revision: "unsafe",
      known: false,
    },
  ];
}

function substituteParameter(expression, context, record, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (!ts.isIdentifier(current)) return expression;
  const binding = context.parameterBindings?.get(current.text);
  if (!binding || !record.lexical.isUseOf(current, binding)) return expression;
  const mapped = context.parameters?.get(current.text);
  if (!mapped || seen.has(current.text)) return expression;
  return substituteParameter(
    mapped,
    context,
    record,
    new Set([...seen, current.text]),
  );
}

function mappedCallParameters(functionNode, call, record, context) {
  const parameters = mappedParameters(
    functionNode,
    call,
    new Map(),
    record.values,
  );
  for (const [name, expression] of parameters) {
    parameters.set(name, substituteParameter(expression, context, record));
  }
  return parameters;
}

function factoryKey(target) {
  return `${target.record.file}:${target.functionNode.pos}`;
}

function callableTarget(call, record, provenance) {
  const reference = provenance.expressionReference(call.expression, record);
  return reference ? provenance.resolveReference(reference) : undefined;
}

function usableTarget(call, target, context) {
  return Boolean(
    !call.questionDotToken &&
    target?.status === "resolved" &&
    !context.seenImportedFactories?.has(factoryKey(target)),
  );
}

function distrustVariants(variants) {
  return variants.map((variant) => ({
    ...variant,
    fields:
      variant.fields.size > 0
        ? variant.fields
        : new Set([UNSTABLE_IMPORTED_PAYLOAD_FIELD]),
    revision: "unsafe",
    known: false,
  }));
}

/** Resolves and interprets relative imported payload factories. */
export function createImportedPayloadResolver({
  sourceFile,
  file,
  values,
  moduleSources,
  importedRevisionStatus,
  importedReadSourceIsSafe,
}) {
  const provenance = createImportProvenance({
    sourceFile,
    file,
    values,
    moduleSources,
  });

  const analyzeCall = (record, call, context) => {
    const target = callableTarget(call, record, provenance);
    if (!target) return undefined;
    if (target.status === "opaque") return unknownPayload();
    if (!usableTarget(call, target, context)) {
      return unstableImportedPayload();
    }
    const key = factoryKey(target);
    const parameters = mappedCallParameters(
      target.functionNode,
      call,
      record,
      context,
    );
    const trustedParameters = new Set(
      [...parameters]
        .filter(([, expression]) =>
          importedReadSourceIsSafe?.(expression, context),
        )
        .map(([name]) => name),
    );
    const pure = factoryIsPure(target, provenance, new Set(), {
      trustedParameters,
    });
    const parameterBindings = mappedParameterBindings(target.functionNode);
    const analyze = createPayloadAnalyzer({
      sourceFile: target.record.sourceFile,
      values: target.record.values,
      revisionStatus: (expression, childContext) =>
        pure
          ? importedRevisionStatus(expression, childContext, target.record)
          : "unsafe",
      importedCall: (nestedCall, nestedContext) =>
        analyzeCall(target.record, nestedCall, nestedContext),
    });
    const returns = functionReturns(target.functionNode);
    if (returns.length === 0) return unknownPayload();
    const seenImportedFactories = new Set([
      ...(context.seenImportedFactories ?? []),
      key,
    ]);
    const variants = returns.flatMap((returned) =>
      analyze(returned, {
        ...context,
        parameters,
        parameterBindings,
        rootParameters: context.rootParameters ?? context.parameters,
        rootParameterBindings:
          context.rootParameterBindings ?? context.parameterBindings,
        seenImportedFactories,
        useNode: returned,
      }),
    );
    return pure ? variants : distrustVariants(variants);
  };

  return (call, context) => analyzeCall(provenance.root, call, context);
}
