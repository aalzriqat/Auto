import ts from "typescript";

import { isTenancyModule, moduleText, unwrapExpression } from "./ast-utils.mjs";

function loaderImports(sourceFile) {
  const identifiers = new Map();
  const namespaces = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = moduleText(statement.moduleSpecifier);
    const clause = statement.importClause;
    if (!specifier || !isTenancyModule(specifier) || !clause?.namedBindings) {
      continue;
    }
    if (ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.set(clause.namedBindings.name.text, clause.namedBindings.name);
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && importedName === "requireOwnedRow") {
        identifiers.set(element.name.text, element.name);
      }
    }
  }
  return { identifiers, namespaces };
}

function importedBindingResolver(bindings, values, provenance) {
  const resolve = (identifier, seen = new Set()) => {
    if (seen.has(identifier.text)) return false;
    const declared = values.resolveAt(identifier.text, identifier);
    if (declared && declared !== identifier) {
      const current = unwrapExpression(declared);
      return ts.isIdentifier(current)
        ? resolve(current, new Set([...seen, identifier.text]))
        : false;
    }
    const binding = bindings.get(identifier.text);
    return Boolean(binding && provenance.isUseOf(identifier, binding));
  };
  return resolve;
}

/** Finds lexically proven imports of the reviewed requireOwnedRow loader. */
export function createTrustedLoaderBindings(sourceFile, values, provenance) {
  const imports = loaderImports(sourceFile);
  return {
    importedIdentifier: importedBindingResolver(
      imports.identifiers,
      values,
      provenance,
    ),
    importedNamespace: importedBindingResolver(
      imports.namespaces,
      values,
      provenance,
    ),
  };
}
