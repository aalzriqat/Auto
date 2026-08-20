import ts from "typescript";

import {
  RULE_IDS,
  collectUniqueValueDeclarations,
  diagnostic,
  memberObject,
  normalizePath,
  parseSource,
  sortDiagnostics,
  staticString,
  unwrapExpression,
} from "./ast-utils.mjs";
import {
  canonicalExpression,
  createDatabaseBindings,
  databaseCall,
  staticMemberName,
} from "./economics-database.mjs";
import { callDominatesWrite, callExpressions } from "./economics-dominance.mjs";
import {
  UNRESOLVED_COMPUTED_FIELD,
  createPayloadAnalyzer,
} from "./economics-payload.mjs";
import {
  UNSTABLE_IMPORTED_PAYLOAD_FIELD,
  createImportedPayloadResolver,
} from "./economics-payload-imports.mjs";
import { importedRevisionStatus as proveImportedRevision } from "./economics-imported-revision.mjs";
import { mappedParameterBindings } from "./economics-payload-flow.mjs";
import { createRowEscapeAnalyzer } from "./economics-row-provenance.mjs";
import { createTrustedLoaderBindings } from "./economics-trusted-loaders.mjs";
import { economicsWriteSites } from "./economics-write-sites.mjs";
import { createLexicalBindingProvenance } from "./lexical-binding-provenance.mjs";

function expressionText(expression, proof) {
  return unwrapExpression(expression)
    .getText(proof.sourceFile)
    .replaceAll(/\s+/g, "");
}

function parameterValue(identifier, proof) {
  const binding = proof.parameterBindings?.get(identifier.text);
  return binding && proof.lexical.isUseOf(identifier, binding)
    ? proof.parameters.get(identifier.text)
    : undefined;
}

function proofExpression(expression, proof) {
  const current = unwrapExpression(expression);
  if (!ts.isIdentifier(current) || proof.seenIdentifiers.has(current.text)) {
    return current;
  }
  const mappedParameter = parameterValue(current, proof);
  const resolved =
    mappedParameter ?? proof.values.resolveAt(current.text, current);
  if (!resolved || resolved === current) return current;
  return proofExpression(resolved, {
    ...proof,
    seenIdentifiers: new Set([...proof.seenIdentifiers, current.text]),
  });
}

function sameExpression(left, right, proof) {
  return (
    expressionText(proofExpression(left, proof), proof) ===
    expressionText(proofExpression(right, proof), proof)
  );
}

function numericLiteral(expression, expected, proof) {
  const current = proofExpression(expression, proof);
  return ts.isNumericLiteral(current) && Number(current.text) === expected;
}

function trustedLoaderCall(call, proof) {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee))
    return proof.trustedLoaders.importedIdentifier(callee);
  const receiver = memberObject(callee);
  return (
    staticMemberName(callee, proof.values) === "requireOwnedRow" &&
    receiver &&
    ts.isIdentifier(receiver) &&
    proof.trustedLoaders.importedNamespace(receiver)
  );
}

function contextDatabaseKey(expression, proof) {
  const key = canonicalExpression(
    proofExpression(expression, proof),
    proof.values,
  );
  return key ? `${key}.db` : undefined;
}

function loadInfoFromCall(call, proof) {
  const database = databaseCall(call, proof);
  const callArguments = database?.arguments ?? call.arguments;
  if (database?.operation === "get" && callArguments[0]) {
    return {
      databaseKey: database.databaseKey,
      target: callArguments[0],
      table: undefined,
      trusted: database.databaseKey === proof.writeDatabaseKey,
    };
  }
  if (
    trustedLoaderCall(call, proof) &&
    call.arguments[0] &&
    call.arguments[2] &&
    call.arguments[3]
  ) {
    if (
      staticString(call.arguments[2], proof.values) !== "financeApplications"
    ) {
      return undefined;
    }
    const databaseKey = contextDatabaseKey(call.arguments[0], proof);
    return {
      databaseKey,
      target: call.arguments[3],
      table: "financeApplications",
      trusted: databaseKey === proof.writeDatabaseKey,
    };
  }
  return undefined;
}

function containingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function functionCalls(sourceFile, functionName) {
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(unwrapExpression(node.expression)) &&
      unwrapExpression(node.expression).text === functionName
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function argumentLoadInfo(argument, call, expectedDatabaseKey, proof) {
  const resolved = proofExpression(argument, {
    ...proof,
    parameters: new Map(),
    seenIdentifiers: new Set(),
    writeDatabaseKey: expectedDatabaseKey,
  });
  const awaited = unwrapExpression(resolved);
  if (!ts.isAwaitExpression(awaited)) return undefined;
  const loaded = unwrapExpression(awaited.expression);
  if (!ts.isCallExpression(loaded)) return undefined;
  return loadInfoFromCall(loaded, {
    ...proof,
    parameters: new Map(),
    seenIdentifiers: new Set(),
    writeDatabaseKey: expectedDatabaseKey,
    useNode: call,
  });
}

function trustedRecordParameter(identifier, proof) {
  const functionNode = containingFunction(identifier);
  if (
    !functionNode ||
    !ts.isFunctionDeclaration(functionNode) ||
    !functionNode.name
  ) {
    return false;
  }
  const recordIndex = functionNode.parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === identifier.text,
  );
  if (recordIndex < 0) return false;
  const contextName = proof.writeDatabaseKey.endsWith(".db")
    ? proof.writeDatabaseKey.slice(0, -3)
    : undefined;
  const contextIndex = functionNode.parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === contextName,
  );
  if (contextIndex < 0) return false;
  const calls = functionCalls(proof.sourceFile, functionNode.name.text);
  if (calls.length === 0) return false;
  return calls.every((call) => {
    const recordArgument = call.arguments[recordIndex];
    const contextArgument = call.arguments[contextIndex];
    if (!recordArgument || !contextArgument) return false;
    const actualContext = canonicalExpression(contextArgument, proof.values);
    if (!actualContext) return false;
    const expectedDatabaseKey = `${actualContext}.db`;
    return Boolean(
      argumentLoadInfo(recordArgument, call, expectedDatabaseKey, proof)
        ?.trusted,
    );
  });
}

function ownerRootIdentifier(expression) {
  let current = unwrapExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function stableOwner(expression, proof, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return undefined;
    const mappedParameter = parameterValue(current, proof);
    if (mappedParameter) {
      const parameters = new Map(proof.parameters);
      parameters.delete(current.text);
      const parameterBindings = new Map(proof.parameterBindings);
      parameterBindings.delete(current.text);
      return stableOwner(
        mappedParameter,
        { ...proof, parameters, parameterBindings },
        seen,
      );
    }
    const resolved = proof.values.resolveAt(current.text, current);
    if (resolved && ts.isIdentifier(unwrapExpression(resolved))) {
      return stableOwner(resolved, proof, new Set([...seen, current.text]));
    }
    return current;
  }
  if (ts.isPropertyAccessExpression(current)) {
    return stableOwner(current.expression, proof, seen) ? current : undefined;
  }
  if (ts.isElementAccessExpression(current)) {
    return staticString(current.argumentExpression, proof.values) !==
      undefined && stableOwner(current.expression, proof, seen)
      ? current
      : undefined;
  }
  return undefined;
}

function ownerLoadInfo(owner, proof) {
  const root = ownerRootIdentifier(owner);
  if (!root) return undefined;
  const initializer = proof.values.resolveAt(root.text, root);
  if (!initializer) {
    return trustedRecordParameter(root, proof) &&
      proof.rowEscapes.remainsTrusted(root, proof.writeNode)
      ? {
          trusted: true,
          target: undefined,
          databaseKey: proof.writeDatabaseKey,
        }
      : undefined;
  }
  const awaited = unwrapExpression(initializer);
  if (!ts.isAwaitExpression(awaited)) return undefined;
  const loaded = unwrapExpression(awaited.expression);
  if (!ts.isCallExpression(loaded)) return undefined;
  const load = loadInfoFromCall(loaded, proof);
  return load?.trusted &&
    !proof.rowEscapes.remainsTrusted(root, proof.writeNode)
    ? { ...load, trusted: false }
    : load;
}

function ownerMatchesWriteTarget(owner, proof) {
  const stable = stableOwner(owner, proof);
  if (
    !stable ||
    !ts.isIdentifier(unwrapExpression(stable)) ||
    !proof.writeTarget
  ) {
    return false;
  }
  const load = ownerLoadInfo(stable, proof);
  if (!load?.trusted) return false;
  const target = proofExpression(proof.writeTarget, proof);
  if (
    (ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)) &&
    staticMemberName(target, proof.values) === "_id" &&
    sameExpression(memberObject(target), stable, proof)
  ) {
    return true;
  }
  return Boolean(load.target && sameExpression(load.target, target, proof));
}

function callIsAwaited(call) {
  let current = call;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  return ts.isAwaitExpression(current.parent);
}

function financeTargetProven(proof) {
  if (!proof.writeTarget) return false;
  const target = proofExpression(proof.writeTarget, proof);
  if (
    (ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)) &&
    staticMemberName(target, proof.values) === "_id"
  ) {
    const owner = stableOwner(memberObject(target), proof);
    const load = owner ? ownerLoadInfo(owner, proof) : undefined;
    if (load?.trusted && load.table === "financeApplications") return true;
  }
  return callExpressions(proof.sourceFile).some((call) => {
    const load = loadInfoFromCall(call, proof);
    return (
      load?.trusted &&
      load.table === "financeApplications" &&
      load.target &&
      callIsAwaited(call) &&
      sameExpression(load.target, target, proof) &&
      callDominatesWrite(call, proof.writeNode)
    );
  });
}

function revisionRead(expression, proof) {
  const current = proofExpression(expression, proof);
  if (
    !ts.isPropertyAccessExpression(current) &&
    !ts.isElementAccessExpression(current)
  ) {
    return false;
  }
  return (
    staticMemberName(current, proof.values) === "economicsRevision" &&
    ownerMatchesWriteTarget(memberObject(current), proof)
  );
}

function revisionBase(expression, proof) {
  const current = proofExpression(expression, proof);
  return (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    revisionRead(current.left, proof) &&
    numericLiteral(current.right, 0, proof)
  );
}

function functionReturnExpression(functionNode) {
  if (!functionNode.body) return undefined;
  if (!ts.isBlock(functionNode.body)) return functionNode.body;
  const runtimeStatements = functionNode.body.statements.filter(
    (statement) =>
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isEmptyStatement(statement),
  );
  return runtimeStatements.length === 1 &&
    ts.isReturnStatement(runtimeStatements[0])
    ? runtimeStatements[0].expression
    : undefined;
}

function helperBumpsRevision(call, proof) {
  const callee = proofExpression(call.expression, proof);
  if (
    (!ts.isFunctionDeclaration(callee) &&
      !ts.isFunctionExpression(callee) &&
      !ts.isArrowFunction(callee)) ||
    proof.seenFunctions.has(callee)
  ) {
    return false;
  }
  const returned = functionReturnExpression(callee);
  if (!returned || callee.parameters.length !== call.arguments.length)
    return false;
  const parameters = new Map(proof.parameters);
  const parameterBindings = mappedParameterBindings(
    callee,
    proof.parameterBindings,
  );
  for (let index = 0; index < callee.parameters.length; index += 1) {
    const parameter = callee.parameters[index];
    if (!ts.isIdentifier(parameter.name) || parameter.initializer) return false;
    parameters.set(parameter.name.text, call.arguments[index]);
  }
  return provenRevisionBump(returned, {
    ...proof,
    parameters,
    parameterBindings,
    seenFunctions: new Set([...proof.seenFunctions, callee]),
  });
}

function provenRevisionBump(expression, proof) {
  const current = proofExpression(expression, proof);
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

function revisionProof(context, analysis) {
  return {
    ...analysis,
    parameters: context.parameters ?? new Map(),
    parameterBindings: context.parameterBindings ?? new Map(),
    seenIdentifiers: new Set(),
    seenFunctions: new Set(),
    writeTarget: context.writeTarget,
    writeDatabaseKey: context.writeDatabaseKey,
    writeNode: context.writeNode ?? context.useNode,
  };
}

function revisionStatus(expression, context, analysis) {
  if (!expression) return "unsafe";
  const proof = revisionProof(context, analysis);
  return provenRevisionBump(expression, proof) ? "bump" : "unsafe";
}

function displayedFields(variants) {
  return [
    ...new Set(
      variants.flatMap((variant) =>
        variant.fields.size === 0 && !variant.known
          ? ["an unresolved payload"]
          : [...variant.fields].map((field) =>
              field === UNRESOLVED_COMPUTED_FIELD
                ? "an unresolved computed field"
                : field === UNSTABLE_IMPORTED_PAYLOAD_FIELD
                  ? "an unstable imported payload factory"
                  : field,
            ),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right, "en"));
}

/** Finds economics writes without a statically proven revision increment. */
export function scanEconomicsRevision(
  source,
  file = "convex/module.ts",
  options = {},
) {
  const normalizedFile = normalizePath(file);
  const sourceFile = parseSource(source, normalizedFile);
  const values = collectUniqueValueDeclarations(sourceFile);
  const lexical = createLexicalBindingProvenance(sourceFile);
  const analysis = {
    sourceFile,
    values,
    lexical,
    databaseBindings: createDatabaseBindings(sourceFile, values),
    rowEscapes: createRowEscapeAnalyzer(sourceFile, values, {
      moduleSources: options.moduleSources,
    }),
    trustedLoaders: createTrustedLoaderBindings(sourceFile, values, lexical),
  };
  const analyzeImportedPayload = createImportedPayloadResolver({
    sourceFile,
    file: normalizedFile,
    values,
    moduleSources: options.moduleSources,
    importedReadSourceIsSafe: (expression, context) => {
      const rootContext = {
        ...context,
        parameters: context.rootParameters ?? new Map(),
        parameterBindings: context.rootParameterBindings ?? new Map(),
      };
      return ownerMatchesWriteTarget(
        expression,
        revisionProof(rootContext, analysis),
      );
    },
    importedRevisionStatus: (expression, context, record) => {
      const rootContext = {
        ...context,
        parameters: context.rootParameters ?? new Map(),
        parameterBindings: context.rootParameterBindings ?? new Map(),
      };
      const proof = revisionProof(rootContext, analysis);
      return proveImportedRevision(expression, context, {
        values: record.values,
        lexical: record.lexical,
        ownerMatches: (owner) => ownerMatchesWriteTarget(owner, proof),
        callerRevisionStatus: (callerExpression) =>
          revisionStatus(callerExpression, rootContext, analysis),
      });
    },
  });
  const analyzePayload = createPayloadAnalyzer({
    sourceFile,
    values,
    revisionStatus: (expression, context) =>
      revisionStatus(expression, context, analysis),
    importedCall: analyzeImportedPayload,
  });
  const diagnostics = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      for (const write of economicsWriteSites(node, analysis)) {
        const variants = analyzePayload(write.payload, write.context);
        const financeTarget = financeTargetProven(
          revisionProof(write.context, analysis),
        );
        const unsafe = variants.filter(
          (variant) =>
            (variant.fields.size > 0 && variant.revision !== "bump") ||
            (financeTarget && variant.fields.size === 0 && !variant.known),
        );
        if (unsafe.length > 0) {
          diagnostics.push(
            diagnostic({
              sourceFile,
              file: normalizedFile,
              node: write.context.writeNode,
              ruleId: RULE_IDS.ECONOMICS_REVISION,
              message: `${write.operation} writes ${displayedFields(unsafe).join(", ")} without a statically proven economicsRevision increment from the same database record.`,
            }),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sortDiagnostics(diagnostics);
}
