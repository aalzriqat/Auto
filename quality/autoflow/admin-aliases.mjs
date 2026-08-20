import ts from "typescript";

import {
  identifierName,
  propertyNameText,
  resolveValue,
} from "./ast-utils.mjs";

function recordGeneratedAlias(element, imported, bindings, builderNames) {
  if (builderNames.publicGenerated.has(imported)) {
    bindings.publicIdentifiers.set(element.name.text, imported);
  } else if (builderNames.internalGenerated.has(imported)) {
    bindings.internalIdentifiers.set(element.name.text, imported);
  }
}

function recordWrappedAlias(element, imported, bindings, builderNames) {
  if (builderNames.publicWrapped.has(imported)) {
    bindings.publicIdentifiers.set(element.name.text, imported);
  } else if (builderNames.internalWrapped.has(imported)) {
    bindings.internalIdentifiers.set(element.name.text, imported);
  }
}

function recordDestructuredAlias(element, namespace, bindings, builderNames) {
  if (element.dotDotDotToken || !ts.isIdentifier(element.name) || !namespace) {
    return;
  }
  const imported = propertyNameText(element.propertyName ?? element.name);
  if (bindings.generatedNamespaces.has(namespace)) {
    recordGeneratedAlias(element, imported, bindings, builderNames);
    return;
  }
  if (bindings.functionsNamespaces.has(namespace)) {
    recordWrappedAlias(element, imported, bindings, builderNames);
    return;
  }
  if (
    bindings.tenancyNamespaces.has(namespace) &&
    imported === "requireSuperAdmin"
  ) {
    bindings.directAuthIdentifiers.set(element.name.text, element.name);
  }
}

function recordConstDestructuring(node, values, bindings, builderNames) {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isObjectBindingPattern(node.name) ||
    !node.initializer ||
    !ts.isVariableDeclarationList(node.parent) ||
    !Boolean(node.parent.flags & ts.NodeFlags.Const)
  ) {
    return;
  }
  const namespace = identifierName(resolveValue(node.initializer, values));
  for (const element of node.name.elements) {
    recordDestructuredAlias(element, namespace, bindings, builderNames);
  }
}

/** Adds immutable destructured aliases whose imported namespace is proven. */
export function collectDestructuredAdminAliases(
  sourceFile,
  values,
  bindings,
  builderNames,
) {
  const visit = (node) => {
    recordConstDestructuring(node, values, bindings, builderNames);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
