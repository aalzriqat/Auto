import ts from "typescript";

import {
  RULE_IDS,
  collectUniqueValueDeclarations,
  diagnostic,
  identifierName,
  memberObject,
  normalizePath,
  parseSource,
  sortDiagnostics,
  staticString,
  unwrapExpression,
} from "./ast-utils.mjs";
import {
  declarationIsConst,
  findAggregateInstances,
  staticMemberName,
} from "./aggregate-provenance.mjs";

const REQUIRED_TRIGGER_WRITERS = [
  "aggregateTriggers",
  "deferredThreadTriggers",
];

function instanceAliases(sourceFile, instances, values) {
  const aliases = new Map(
    instances.map((instance) => [instance.name, instance.name]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      if (
        declarationIsConst(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(unwrapExpression(node.initializer)) &&
        values.resolveAt(node.name.text, node.name) === node.initializer
      ) {
        const canonical = aliases.get(unwrapExpression(node.initializer).text);
        if (canonical && !aliases.has(node.name.text)) {
          aliases.set(node.name.text, canonical);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return aliases;
}

function directCallFromStatement(statement) {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const expression = unwrapExpression(statement.expression);
  return ts.isCallExpression(expression) ? expression : undefined;
}

function stringArgument(call, index, values) {
  return call.arguments[index]
    ? staticString(call.arguments[index], values)
    : undefined;
}

function countingRegistrar(sourceFile) {
  return sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "registerCountingTriggers",
  );
}

function assignmentTargetsName(node, name) {
  if (ts.isBinaryExpression(node)) {
    return (
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(unwrapExpression(node.left)) &&
      unwrapExpression(node.left).text === name
    );
  }
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    ts.isIdentifier(unwrapExpression(node.operand)) &&
    unwrapExpression(node.operand).text === name
  );
}

function bindingIsReassigned(sourceFile, name) {
  let reassignment;
  const visit = (node) => {
    if (!reassignment && assignmentTargetsName(node, name)) reassignment = node;
    if (!reassignment) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reassignment;
}

function aggregateRegistration(statement, analysis) {
  const call = directCallFromStatement(statement);
  if (
    !call ||
    staticMemberName(call.expression, analysis.values) !== "register" ||
    identifierName(memberObject(call.expression)) !== analysis.registryName
  ) {
    return undefined;
  }
  const triggerCall = call.arguments[1]
    ? unwrapExpression(call.arguments[1])
    : undefined;
  if (
    !triggerCall ||
    !ts.isCallExpression(triggerCall) ||
    staticMemberName(triggerCall.expression, analysis.values) !==
      "idempotentTrigger"
  ) {
    return undefined;
  }
  const aggregateAlias = identifierName(memberObject(triggerCall.expression));
  const aggregateName = aggregateAlias
    ? analysis.instanceAliases.get(aggregateAlias)
    : undefined;
  if (!aggregateName) return undefined;
  return {
    aggregateName,
    table: stringArgument(call, 0, analysis.values),
    node: call,
  };
}

function registrationsByAggregate(
  sourceFile,
  instances,
  values,
  reportViolation,
) {
  const registrations = new Map(
    instances.map((instance) => [instance.name, []]),
  );
  const registrar = countingRegistrar(sourceFile);
  if (!registrar?.body) {
    reportViolation(
      sourceFile,
      "registerCountingTriggers must exist and unconditionally register every TableAggregate instance.",
    );
    return registrations;
  }
  const reassignment = bindingIsReassigned(
    sourceFile,
    "registerCountingTriggers",
  );
  if (reassignment) {
    reportViolation(
      reassignment,
      "registerCountingTriggers must never be reassigned after its verified declaration.",
    );
  }

  const registryParameter = registrar.parameters[0]?.name;
  const analysis = {
    values,
    registryName: registryParameter
      ? identifierName(registryParameter)
      : undefined,
    instanceAliases: instanceAliases(sourceFile, instances, values),
  };
  for (const statement of registrar.body.statements) {
    const entry = aggregateRegistration(statement, analysis);
    if (!entry) continue;
    registrations.get(entry.aggregateName).push(entry);
  }
  return registrations;
}

function checkInstanceRegistrations(instances, registrations, reportViolation) {
  for (const instance of instances) {
    if (!instance.table) {
      reportViolation(
        instance.node,
        `TableAggregate "${instance.name}" must declare a statically resolvable string-literal TableName type.`,
      );
    }
    const entries = registrations.get(instance.name) ?? [];
    if (entries.length === 0) {
      reportViolation(
        instance.node,
        `TableAggregate "${instance.name}" must be registered with ${instance.name}.idempotentTrigger() in registerCountingTriggers.`,
      );
      continue;
    }
    if (
      instance.table &&
      entries.every((entry) => entry.table !== instance.table)
    ) {
      const registeredTables = entries
        .map((entry) => JSON.stringify(entry.table))
        .join(", ");
      reportViolation(
        entries[0].node,
        `TableAggregate "${instance.name}" counts "${instance.table}" but is registered for ${registeredTables}.`,
      );
    }
    if (entries.length > 1) {
      reportViolation(
        entries[1].node,
        `TableAggregate "${instance.name}" is registered ${entries.length} times; register each instance exactly once.`,
      );
    }
  }
}

function writerCalls(sourceFile) {
  const callsByWriter = new Map(
    REQUIRED_TRIGGER_WRITERS.map((writer) => [writer, []]),
  );
  for (const statement of sourceFile.statements) {
    const call = directCallFromStatement(statement);
    if (
      !call ||
      identifierName(call.expression) !== "registerCountingTriggers" ||
      call.arguments.length !== 1
    ) {
      continue;
    }
    const writer = identifierName(call.arguments[0]);
    if (callsByWriter.has(writer)) callsByWriter.get(writer).push(call);
  }
  return callsByWriter;
}

function directRegistryInitializer(writer, values) {
  const initializer = values.resolve(writer);
  const current = initializer ? unwrapExpression(initializer) : undefined;
  return Boolean(
    current && (ts.isCallExpression(current) || ts.isNewExpression(current)),
  );
}

function checkWriterRegistrations(
  sourceFile,
  callsByWriter,
  values,
  reportViolation,
) {
  for (const writer of REQUIRED_TRIGGER_WRITERS) {
    const calls = callsByWriter.get(writer);
    if (!directRegistryInitializer(writer, values)) {
      reportViolation(
        sourceFile,
        `${writer} must be an immutable, directly constructed trigger registry rather than an alias.`,
      );
    } else if (calls.length === 0) {
      reportViolation(
        sourceFile,
        `${writer} must be passed to registerCountingTriggers in an unconditional top-level statement.`,
      );
    } else if (calls.length > 1) {
      reportViolation(
        calls[1],
        `${writer} is wired ${calls.length} times; call registerCountingTriggers(${writer}) exactly once.`,
      );
    }
  }
}

/** Correlates every package-proven aggregate instance with its own registration. */
export function scanAggregateWiring(
  source,
  file = "convex/aggregates.ts",
  options = {},
) {
  const normalizedFile = normalizePath(file);
  const sourceFile = parseSource(source, normalizedFile);
  const values = collectUniqueValueDeclarations(sourceFile);
  const instances = findAggregateInstances(sourceFile, values, options);

  // This scanner runs for every Convex executable. Most files have no aggregate;
  // returning here avoids imposing aggregate-module structure on ordinary code.
  if (instances.supported.length === 0 && instances.unsupported.length === 0) {
    return [];
  }

  const diagnostics = [];
  const reportViolation = (node, message) => {
    diagnostics.push(
      diagnostic({
        sourceFile,
        file: normalizedFile,
        node,
        ruleId: RULE_IDS.AGGREGATE_REGISTRATION,
        message,
      }),
    );
  };
  for (const unsupported of instances.unsupported) {
    reportViolation(unsupported.node, unsupported.message);
  }
  const registrations = registrationsByAggregate(
    sourceFile,
    instances.supported,
    values,
    reportViolation,
  );
  checkInstanceRegistrations(
    instances.supported,
    registrations,
    reportViolation,
  );
  checkWriterRegistrations(
    sourceFile,
    writerCalls(sourceFile),
    values,
    reportViolation,
  );

  return sortDiagnostics(diagnostics);
}
