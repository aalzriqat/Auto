import ts from "typescript";

import {
  memberName,
  memberObject,
  moduleText,
  propertyNameText,
  unwrapExpression,
} from "./ast-utils.mjs";
import { isTrustedAdminModule } from "./admin-module-provenance.mjs";

function addBinding(bindings, identifier) {
  const existing = bindings.get(identifier.text);
  if (existing) existing.push(identifier);
  else bindings.set(identifier.text, [identifier]);
}

function assignmentOperator(kind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function rootIdentifier(expression) {
  let current = unwrapExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = memberObject(current);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function mutatingCallTarget(node, provenance) {
  if (!ts.isCallExpression(node) || !node.arguments[0]) return undefined;
  const object = memberObject(node.expression);
  const operation = memberName(node.expression);
  if (!object || !ts.isIdentifier(object) || provenance.hasBinding(object)) {
    return undefined;
  }
  const mutates =
    (object.text === "Object" &&
      [
        "assign",
        "defineProperty",
        "defineProperties",
        "setPrototypeOf",
      ].includes(operation)) ||
    (object.text === "Reflect" &&
      ["set", "deleteProperty", "defineProperty", "setPrototypeOf"].includes(
        operation,
      ));
  return mutates ? rootIdentifier(node.arguments[0]) : undefined;
}

function writtenRoot(node, provenance) {
  if (
    ts.isBinaryExpression(node) &&
    assignmentOperator(node.operatorToken.kind)
  ) {
    return rootIdentifier(node.left);
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return rootIdentifier(node.operand);
  }
  if (ts.isDeleteExpression(node)) return rootIdentifier(node.expression);
  return mutatingCallTarget(node, provenance);
}

function invalidateWrittenBindings(sourceFile, bindingState) {
  const visit = (node) => {
    const root = writtenRoot(node, bindingState.provenance);
    if (root) {
      for (const bindings of [bindingState.internal, bindingState.namespaces]) {
        for (const target of bindings.get(root.text) ?? []) {
          if (bindingState.provenance.isUseOf(root, target)) {
            bindingState.invalid.add(target);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function declarationBindingForValue(value) {
  if (
    value.parent &&
    ts.isVariableDeclaration(value.parent) &&
    value.parent.initializer === value &&
    ts.isIdentifier(value.parent.name)
  ) {
    return value.parent.name;
  }
  return undefined;
}

function importedKind(identifier, bindingState) {
  const direct = (bindingState.internal.get(identifier.text) ?? []).some(
    (target) =>
      !bindingState.invalid.has(target) &&
      bindingState.provenance.isUseOf(identifier, target),
  );
  if (direct) return "internal";
  const namespace = (bindingState.namespaces.get(identifier.text) ?? []).some(
    (target) =>
      !bindingState.invalid.has(target) &&
      bindingState.provenance.isUseOf(identifier, target),
  );
  return namespace ? "namespace" : undefined;
}

function referenceChain(expression, bindingState, seen = new Set()) {
  let current = unwrapExpression(expression);
  const parts = [];
  const visited = new Set(seen);
  while (true) {
    while (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      const name = memberName(current);
      if (!name) return undefined;
      parts.unshift(name);
      current = unwrapExpression(memberObject(current));
    }
    if (!ts.isIdentifier(current)) return undefined;
    const kind = importedKind(current, bindingState);
    if (kind) return { kind, parts };
    const resolved = bindingState.values.resolveAt(current.text, current);
    const binding = resolved && declarationBindingForValue(resolved);
    if (
      !resolved ||
      !binding ||
      visited.has(binding) ||
      !bindingState.provenance.isUseOf(current, binding)
    ) {
      return undefined;
    }
    visited.add(binding);
    current = unwrapExpression(resolved);
  }
}

function recordApiImports(sourceFile, file, bindingState) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = moduleText(statement.moduleSpecifier);
    const clause = statement.importClause;
    if (
      !specifier ||
      !isTrustedAdminModule(file, specifier, "api") ||
      !clause ||
      clause.isTypeOnly
    ) {
      continue;
    }
    const namedBindings = clause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      addBinding(bindingState.namespaces, namedBindings.name);
      continue;
    }
    for (const element of namedBindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && imported === "internal") {
        addBinding(bindingState.internal, element.name);
      }
    }
  }
}

function recordDestructuredInternalAliases(sourceFile, bindingState) {
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVarConst(node)
    ) {
      const base = referenceChain(node.initializer, bindingState);
      if (base?.kind === "namespace" && base.parts.length === 0) {
        for (const element of node.name.elements) {
          if (
            !element.dotDotDotToken &&
            ts.isIdentifier(element.name) &&
            propertyNameText(element.propertyName ?? element.name) ===
              "internal"
          ) {
            addBinding(bindingState.internal, element.name);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Proves FunctionReference roots originate from immutable generated-api bindings. */
export function createInternalReferenceResolver(
  sourceFile,
  values,
  provenance,
  file,
) {
  const bindingState = {
    internal: new Map(),
    namespaces: new Map(),
    invalid: new Set(),
    provenance,
    values,
  };
  recordApiImports(sourceFile, file, bindingState);
  invalidateWrittenBindings(sourceFile, bindingState);
  recordDestructuredInternalAliases(sourceFile, bindingState);
  invalidateWrittenBindings(sourceFile, bindingState);

  return (expression) => {
    const reference = referenceChain(expression, bindingState);
    if (!reference) return undefined;
    const parts =
      reference.kind === "namespace" && reference.parts[0] === "internal"
        ? reference.parts.slice(1)
        : reference.kind === "internal"
          ? reference.parts
          : [];
    if (parts.length < 2) return undefined;
    return {
      moduleName: parts.slice(0, -1).join("/"),
      functionName: parts.at(-1),
    };
  };
}
