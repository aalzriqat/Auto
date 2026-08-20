import ts from "typescript";

import {
  propertyNameText,
  resolveValue,
  staticString,
  unwrapExpression,
} from "./ast-utils.mjs";
import {
  bindingAt,
  callableAncestor,
  collectBindingsAndMutations,
  conditionalMutation,
  directPropertyName,
  functionReturns,
  localFunction,
  mappedParameterBindings,
  mappedParameters,
  memberOperation,
} from "./economics-payload-flow.mjs";
import { createLexicalBindingProvenance } from "./lexical-binding-provenance.mjs";

const ECONOMICS_FIELDS = new Set([
  "approvedDealerPurchaseAmountMinor",
  "financeCompanyFundedPortionMinor",
  "dealerContributionMinor",
  "unfinancedPortionMinor",
]);

function resolvedCallExpression(expression, values) {
  const current = unwrapExpression(expression);
  if (!ts.isIdentifier(current)) return current;
  return unwrapExpression(values.resolveAt(current.text, current) ?? current);
}

const GLOBAL_OBJECT_PAYLOAD_OPERATIONS = new Set(["assign", "fromEntries"]);

function globalObjectPayloadOperation(callee, operation, lexical) {
  if (!GLOBAL_OBJECT_PAYLOAD_OPERATIONS.has(operation)) return undefined;
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return undefined;
  }
  const receiver = unwrapExpression(callee.expression);
  if (!ts.isIdentifier(receiver) || receiver.text !== "Object") {
    return undefined;
  }
  return lexical.hasBinding(receiver) ? undefined : operation;
}

export const UNRESOLVED_COMPUTED_FIELD = "<unresolved computed field>";

function emptyVariant(known = true) {
  return { fields: new Set(), revision: "absent", known };
}

function cloneVariant(variant) {
  return {
    fields: new Set(variant.fields),
    revision: variant.revision,
    known: variant.known,
  };
}

function overlayVariant(previous, overlay) {
  let revision = previous.revision;
  if (overlay.revision !== "absent") revision = overlay.revision;
  else if (!overlay.known && previous.fields.size > 0) revision = "unknown";
  return {
    fields: new Set([...previous.fields, ...overlay.fields]),
    revision,
    known: previous.known && overlay.known,
  };
}

function crossOverlay(previous, overlays) {
  return previous.flatMap((base) =>
    overlays.map((overlay) => overlayVariant(base, overlay)),
  );
}

function mutationApplies(binding, mutation, useNode) {
  const bindingCallable = callableAncestor(binding.node);
  const mutationCallable = callableAncestor(mutation.node);
  const useCallable = callableAncestor(useNode);
  const sameFlow =
    mutation.node.pos > binding.node.pos &&
    mutation.node.pos < useNode.pos &&
    mutationCallable === useCallable;
  const capturedModuleState =
    bindingCallable === undefined &&
    mutationCallable === undefined &&
    useCallable !== undefined &&
    mutation.node.pos > binding.node.pos;
  return sameFlow || capturedModuleState;
}

class PayloadAnalyzer {
  constructor(sourceFile, values, revisionStatus, importedCall) {
    this.values = values;
    this.revisionStatus = revisionStatus;
    this.importedCall = importedCall;
    this.lexical = createLexicalBindingProvenance(sourceFile);
    this.records = collectBindingsAndMutations(sourceFile, values);
  }

  property(variant, name, value, context, unknownIsRelevant = true) {
    const next = cloneVariant(variant);
    if (name === undefined) {
      if (unknownIsRelevant) {
        next.fields.add(UNRESOLVED_COMPUTED_FIELD);
        next.revision = "unknown";
      } else {
        // Dynamic patch builders are common for unrelated tables. With no
        // known protected field, an arbitrary key is not reliable evidence of
        // an economics write and would turn this narrow rule into a global ban.
        next.known = false;
      }
      return next;
    }
    if (ECONOMICS_FIELDS.has(name)) next.fields.add(name);
    if (name === "economicsRevision") {
      next.revision = this.revisionStatus(value, context);
    }
    return next;
  }

  object(object, context) {
    let variants = [emptyVariant()];
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        variants = crossOverlay(
          variants,
          this.expression(property.expression, {
            ...context,
            useNode: property,
          }),
        );
        continue;
      }
      let value;
      if (ts.isPropertyAssignment(property)) value = property.initializer;
      else if (ts.isShorthandPropertyAssignment(property))
        value = property.name;
      variants = variants.map((variant) =>
        this.property(
          variant,
          propertyNameText(property.name, this.values),
          value,
          context,
        ),
      );
    }
    return variants;
  }

  deleteProperty(variants, name) {
    return variants.map((variant) => {
      const next = cloneVariant(variant);
      if (name === undefined) {
        if (next.fields.size > 0) next.revision = "unknown";
        return next;
      }
      if (ECONOMICS_FIELDS.has(name)) next.fields.delete(name);
      if (name === "economicsRevision") next.revision = "absent";
      return next;
    });
  }

  assignMutation(variants, mutation, context) {
    let overlaid = variants;
    for (const argument of mutation.call.arguments.slice(1)) {
      overlaid = crossOverlay(
        overlaid,
        this.expression(argument, { ...context, useNode: mutation.node }),
      );
    }
    return overlaid;
  }

  definePropertyMutation(variants, mutation, context) {
    const name = mutation.call.arguments[1]
      ? staticString(mutation.call.arguments[1], this.values)
      : undefined;
    const descriptor = mutation.call.arguments[2]
      ? unwrapExpression(mutation.call.arguments[2])
      : undefined;
    const valueProperty =
      descriptor && ts.isObjectLiteralExpression(descriptor)
        ? descriptor.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              propertyNameText(property.name, this.values) === "value",
          )
        : undefined;
    return variants.map((variant) =>
      this.property(
        variant,
        name,
        valueProperty?.initializer,
        context,
        variant.fields.size > 0,
      ),
    );
  }

  definePropertiesMutation(variants, mutation, context) {
    const descriptors = mutation.call.arguments[1]
      ? unwrapExpression(mutation.call.arguments[1])
      : undefined;
    if (!descriptors || !ts.isObjectLiteralExpression(descriptors)) {
      return variants.map((variant) => ({ ...variant, known: false }));
    }
    let updated = variants;
    for (const descriptorProperty of descriptors.properties) {
      if (!ts.isPropertyAssignment(descriptorProperty)) continue;
      const descriptor = unwrapExpression(descriptorProperty.initializer);
      const valueProperty = ts.isObjectLiteralExpression(descriptor)
        ? descriptor.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              propertyNameText(property.name, this.values) === "value",
          )
        : undefined;
      updated = updated.map((variant) =>
        this.property(
          variant,
          propertyNameText(descriptorProperty.name, this.values),
          valueProperty?.initializer,
          context,
          variant.fields.size > 0,
        ),
      );
    }
    return updated;
  }

  reflectMutation(variants, mutation, context) {
    const name = mutation.call.arguments[1]
      ? staticString(mutation.call.arguments[1], this.values)
      : undefined;
    if (mutation.kind === "reflectDelete") {
      return this.deleteProperty(variants, name);
    }
    const value = mutation.call.arguments[2];
    return variants.map((variant) =>
      this.property(variant, name, value, context, variant.fields.size > 0),
    );
  }

  mutation(variants, mutation, context) {
    if (mutation.kind === "reset") {
      return this.expression(mutation.value, {
        ...context,
        useNode: mutation.node,
      });
    }
    if (mutation.kind === "property") {
      return variants.map((variant) =>
        this.property(
          variant,
          directPropertyName(mutation.left, this.values),
          mutation.value,
          context,
          variant.fields.size > 0,
        ),
      );
    }
    if (mutation.kind === "delete") {
      return this.deleteProperty(
        variants,
        directPropertyName(mutation.left, this.values),
      );
    }
    if (mutation.kind === "assign") {
      return this.assignMutation(variants, mutation, context);
    }
    if (mutation.kind === "defineProperty") {
      return this.definePropertyMutation(variants, mutation, context);
    }
    if (mutation.kind === "defineProperties") {
      return this.definePropertiesMutation(variants, mutation, context);
    }
    return this.reflectMutation(variants, mutation, context);
  }

  identifier(identifier, context) {
    const parameterBinding = context.parameterBindings.get(identifier.text);
    if (
      context.parameters.has(identifier.text) &&
      parameterBinding &&
      this.lexical.isUseOf(identifier, parameterBinding)
    ) {
      const parameters = new Map(context.parameters);
      const parameterBindings = new Map(context.parameterBindings);
      parameters.delete(identifier.text);
      parameterBindings.delete(identifier.text);
      const mapped = context.parameters.get(identifier.text);
      return this.expression(mapped, {
        ...context,
        parameters,
        parameterBindings,
        useNode: mapped,
      });
    }
    const binding = bindingAt(
      this.records,
      identifier.text,
      context.useNode ?? identifier,
    );
    if (!binding || context.seenBindings.has(binding))
      return [emptyVariant(false)];
    const nextContext = {
      ...context,
      seenBindings: new Set([...context.seenBindings, binding]),
      useNode: binding.node,
    };
    let variants = binding.initializer
      ? this.expression(binding.initializer, nextContext)
      : [emptyVariant(false)];
    const useNode = context.useNode ?? identifier;
    const callable = callableAncestor(useNode);
    for (const mutation of this.records.mutations) {
      if (
        bindingAt(this.records, mutation.name, mutation.node) !== binding ||
        !mutationApplies(binding, mutation, useNode)
      ) {
        continue;
      }
      const before = variants.map(cloneVariant);
      variants = this.mutation(variants, mutation, {
        ...context,
        useNode: mutation.node,
      });
      if (conditionalMutation(mutation.node, callable)) {
        variants = [...before, ...variants];
      }
    }
    return variants;
  }

  objectAssign(call, context) {
    let variants = this.expression(call.arguments[0], {
      ...context,
      useNode: call,
    });
    for (const argument of call.arguments.slice(1)) {
      variants = crossOverlay(
        variants,
        this.expression(argument, { ...context, useNode: call }),
      );
    }
    return variants;
  }

  objectFromEntries(call, context) {
    const entries = call.arguments[0]
      ? resolveValue(call.arguments[0], this.values)
      : undefined;
    if (!entries || !ts.isArrayLiteralExpression(entries)) {
      return [emptyVariant(false)];
    }
    let variants = [emptyVariant()];
    for (const entry of entries.elements) {
      const tuple = unwrapExpression(entry);
      const name =
        ts.isArrayLiteralExpression(tuple) && tuple.elements[0]
          ? staticString(tuple.elements[0], this.values)
          : undefined;
      const value =
        ts.isArrayLiteralExpression(tuple) && tuple.elements[1]
          ? tuple.elements[1]
          : undefined;
      variants = variants.map((variant) =>
        this.property(variant, name, value, context),
      );
    }
    return variants;
  }

  call(call, context) {
    const callee = resolvedCallExpression(call.expression, this.values);
    const operation = memberOperation(callee, this.values);
    const objectOperation = globalObjectPayloadOperation(
      callee,
      operation,
      this.lexical,
    );
    if (objectOperation === "assign" && call.arguments.length > 0) {
      return this.objectAssign(call, context);
    }
    if (objectOperation === "fromEntries") {
      return this.objectFromEntries(call, context);
    }
    const functionNode = localFunction(call.expression, this.values);
    if (!functionNode) {
      return this.importedCall?.(call, context) ?? [emptyVariant(false)];
    }
    if (context.seenFunctions.has(functionNode)) return [emptyVariant(false)];
    const parameters = mappedParameters(
      functionNode,
      call,
      context.parameters,
      this.values,
    );
    const parameterBindings = mappedParameterBindings(
      functionNode,
      context.parameterBindings,
    );
    const returns = functionReturns(functionNode);
    if (returns.length === 0) return [emptyVariant(false)];
    return returns.flatMap((returned) =>
      this.expression(returned, {
        ...context,
        parameters,
        parameterBindings,
        useNode: returned,
        seenFunctions: new Set([...context.seenFunctions, functionNode]),
      }),
    );
  }

  expression(expression, context) {
    if (!expression) return [emptyVariant(false)];
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      if (context.seenIdentifiers.has(current.text))
        return [emptyVariant(false)];
      return this.identifier(current, context);
    }
    if (ts.isConditionalExpression(current)) {
      return [
        ...this.expression(current.whenTrue, {
          ...context,
          useNode: current.whenTrue,
        }),
        ...this.expression(current.whenFalse, {
          ...context,
          useNode: current.whenFalse,
        }),
      ];
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return [
        ...this.expression(current.left, { ...context, useNode: current.left }),
        ...this.expression(current.right, {
          ...context,
          useNode: current.right,
        }),
      ];
    }
    if (ts.isCallExpression(current)) return this.call(current, context);
    if (ts.isObjectLiteralExpression(current))
      return this.object(current, context);
    return [emptyVariant(false)];
  }

  analyze(expression, context) {
    return this.expression(expression, {
      parameters: context.parameters ?? new Map(),
      parameterBindings: context.parameterBindings ?? new Map(),
      seenBindings: new Set(),
      seenFunctions: new Set(),
      seenIdentifiers: new Set(),
      seenImportedFactories: new Set(),
      useNode: context.useNode ?? expression,
      ...context,
    });
  }
}

/** Builds a conservative, flow-aware payload interpreter for one source file. */
export function createPayloadAnalyzer({
  sourceFile,
  values,
  revisionStatus,
  importedCall,
}) {
  const analyzer = new PayloadAnalyzer(
    sourceFile,
    values,
    revisionStatus,
    importedCall,
  );
  return (expression, context) => analyzer.analyze(expression, context);
}
