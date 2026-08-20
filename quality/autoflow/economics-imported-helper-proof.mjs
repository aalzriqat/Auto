import ts from "typescript";

import {
  hasModifier,
  memberName,
  moduleText,
  parseSource,
  unwrapExpression,
} from "./ast-utils.mjs";
import { moduleCandidates } from "./economics-module-sources.mjs";
import { createLexicalBindingProvenance } from "./lexical-binding-provenance.mjs";
const READ_ONLY_ROUTE_KEY =
  "convex/utils/vehicleOwnership.ts#consignedSettlementRoute";
const OBJECT_PROTOTYPE_MUTATORS = new Set([
  "assign",
  "defineProperties",
  "defineProperty",
  "setPrototypeOf",
]);
const REFLECT_PROTOTYPE_MUTATORS = new Set([
  "defineProperty",
  "deleteProperty",
  "set",
  "setPrototypeOf",
]);

function importedReference(identifier, state) {
  const binding = state.provenance.bindingOf(identifier);
  if (!binding || !ts.isImportSpecifier(binding.parent)) return undefined;
  const specifier = binding.parent;
  const clause = specifier.parent.parent;
  const declaration = clause.parent;
  const importedModule = ts.isImportDeclaration(declaration)
    ? moduleText(declaration.moduleSpecifier)
    : undefined;
  if (
    !importedModule ||
    specifier.isTypeOnly ||
    clause.isTypeOnly ||
    specifier.propertyName
  ) {
    return undefined;
  }
  return { exportName: specifier.name.text, importedModule };
}

function directExportedFunction(sourceFile, exportName) {
  const matches = sourceFile.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.body &&
      statement.name?.text === exportName &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      !hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
  );
  if (matches.length !== 1) return undefined;
  const competingExport = sourceFile.statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (element) => element.name.text === exportName,
      ),
  );
  return competingExport ? undefined : matches[0];
}

function containsBinding(node, binding, provenance) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (ts.isIdentifier(current) && provenance.isUseOf(current, binding)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function assignmentTarget(node) {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return node.left;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }
  return ts.isForInStatement(node) || ts.isForOfStatement(node)
    ? node.initializer
    : undefined;
}

function exportBindingIsStable(sourceFile, functionNode) {
  const binding = functionNode.name;
  if (!binding) return false;
  const provenance = createLexicalBindingProvenance(sourceFile);
  let stable = true;
  const visit = (node) => {
    if (!stable) return;
    const target = assignmentTarget(node);
    if (target && containsBinding(target, binding, provenance)) {
      stable = false;
      return;
    }
    const callee = ts.isCallExpression(node)
      ? unwrapExpression(node.expression)
      : undefined;
    if (
      callee &&
      ts.isIdentifier(callee) &&
      callee.text === "eval" &&
      !provenance.hasBinding(callee)
    ) {
      stable = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return stable;
}

function objectPrototype(expression) {
  const current = unwrapExpression(expression);
  if (
    (!ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)) ||
    memberName(current) !== "prototype"
  ) {
    return false;
  }
  const owner = unwrapExpression(current.expression);
  return ts.isIdentifier(owner) && owner.text === "Object";
}

function targetTouchesObjectPrototype(expression) {
  let current = unwrapExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    if (objectPrototype(current)) return true;
    current = unwrapExpression(current.expression);
  }
  return false;
}

function knownPrototypeMutator(call) {
  const callee = unwrapExpression(call.expression);
  if (
    (!ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)) ||
    !call.arguments[0]
  ) {
    return false;
  }
  const receiver = unwrapExpression(callee.expression);
  const operation = memberName(callee);
  const knownObjectMutator =
    ts.isIdentifier(receiver) &&
    receiver.text === "Object" &&
    OBJECT_PROTOTYPE_MUTATORS.has(operation);
  const knownReflectMutator =
    ts.isIdentifier(receiver) &&
    receiver.text === "Reflect" &&
    REFLECT_PROTOTYPE_MUTATORS.has(operation);
  return (
    (knownObjectMutator || knownReflectMutator) &&
    objectPrototype(call.arguments[0])
  );
}

function hasKnownPrototypePoisoning(sourceFile) {
  let poisoned = false;
  const visit = (node) => {
    if (poisoned) return;
    const target = assignmentTarget(node);
    if (
      (target && targetTouchesObjectPrototype(target)) ||
      (ts.isDeleteExpression(node) &&
        targetTouchesObjectPrototype(node.expression)) ||
      (ts.isCallExpression(node) && knownPrototypeMutator(node))
    ) {
      poisoned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return poisoned;
}

function soleOrdinaryReturn(functionNode) {
  const modifiers = functionNode.modifiers ?? [];
  const statement = functionNode.body?.statements[0];
  if (
    modifiers.length !== 1 ||
    modifiers[0].kind !== ts.SyntaxKind.ExportKeyword ||
    functionNode.asteriskToken ||
    functionNode.body?.statements.length !== 1 ||
    !statement ||
    !ts.isReturnStatement(statement) ||
    !statement.expression
  ) {
    return undefined;
  }
  return statement.expression;
}

function solePlainParameter(functionNode) {
  const parameter = functionNode.parameters[0];
  return functionNode.parameters.length === 1 &&
    parameter &&
    ts.isIdentifier(parameter.name) &&
    !parameter.dotDotDotToken &&
    !parameter.initializer
    ? parameter.name
    : undefined;
}

function exactRouteProjection(expression) {
  const returned = unwrapExpression(expression);
  return !ts.isBinaryExpression(returned) ||
    returned.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !ts.isStringLiteral(returned.right) ||
    returned.right.text !== "THROUGH_DEALERSHIP"
    ? undefined
    : unwrapExpression(returned.left);
}

function exactReadOnlyRoute(functionNode, sourceFile) {
  const returned = soleOrdinaryReturn(functionNode);
  const parameter = solePlainParameter(functionNode);
  const property = returned ? exactRouteProjection(returned) : undefined;
  if (
    !parameter ||
    !property ||
    !ts.isPropertyAccessExpression(property) ||
    property.questionDotToken ||
    property.name.text !== "supplierSettlementRoute"
  ) {
    return false;
  }
  const owner = unwrapExpression(property.expression);
  const provenance = createLexicalBindingProvenance(sourceFile);
  return ts.isIdentifier(owner) && provenance.isUseOf(owner, parameter);
}

/** Allows only the exact reviewed, read-only settlement-route projection. */
export function verifiedReadOnlyImportedCall(callee, state) {
  const reference = importedReference(callee, state);
  if (!reference || !state.moduleSources) return false;
  const moduleFile = moduleCandidates(
    state.sourceFile.fileName,
    reference.importedModule,
  ).find((candidate) => state.moduleSources.has(candidate));
  if (!moduleFile) return false;
  const key = `${moduleFile}#${reference.exportName}`;
  if (key !== READ_ONLY_ROUTE_KEY) return false;
  if (state.verifiedImports.has(key)) return state.verifiedImports.get(key);
  const moduleSource = state.moduleSources.get(moduleFile);
  if (typeof moduleSource !== "string") return false;
  const moduleSourceFile = parseSource(moduleSource, moduleFile);
  const exported = directExportedFunction(
    moduleSourceFile,
    reference.exportName,
  );
  const verified = Boolean(
    exported &&
    exportBindingIsStable(moduleSourceFile, exported) &&
    !hasKnownPrototypePoisoning(moduleSourceFile) &&
    exactReadOnlyRoute(exported, moduleSourceFile),
  );
  state.verifiedImports.set(key, verified);
  return verified;
}
