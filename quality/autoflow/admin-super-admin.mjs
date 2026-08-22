import path from "node:path";
import ts from "typescript";

import {
  RULE_IDS,
  collectUniqueValueDeclarations,
  diagnostic,
  memberName,
  memberObject,
  moduleText,
  normalizePath,
  parseSource,
  propertyNameText,
  resolveValue,
  sortDiagnostics,
  unwrapExpression,
} from "./ast-utils.mjs";
import { collectDestructuredAdminAliases } from "./admin-aliases.mjs";
import { handlerAuthenticates } from "./admin-auth-flow.mjs";
import { exportedBuilderDeclarations } from "./admin-exported-builders.mjs";
import { createInternalReferenceResolver } from "./admin-internal-api.mjs";
import { isTrustedAdminModule } from "./admin-module-provenance.mjs";
import { createLexicalBindingProvenance } from "./lexical-binding-provenance.mjs";
import { scanAdminRuntimeExports } from "./admin-runtime-exports.mjs";

const PUBLIC_GENERATED_BUILDERS = new Set(["query", "mutation", "action"]);
const PUBLIC_WRAPPED_BUILDERS = new Set(["mutation", "socialBulkMutation"]);
const INTERNAL_WRAPPED_BUILDERS = new Set(["internalMutation"]);
const INTERNAL_GENERATED_BUILDERS = new Set([
  "internalQuery",
  "internalMutation",
  "internalAction",
]);

function unambiguousObjectProperty(object, name, values) {
  let matchingProperty;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return undefined;
    const propertyName = propertyNameText(property.name, values);
    if (
      propertyName === undefined &&
      ts.isComputedPropertyName(property.name)
    ) {
      return undefined;
    }
    if (propertyName !== name) continue;
    if (matchingProperty) return undefined;
    matchingProperty = property;
  }
  return matchingProperty;
}

function functionLikeFromProperty(property, values) {
  if (!property) return undefined;
  if (ts.isMethodDeclaration(property)) return property;
  if (ts.isPropertyAssignment(property)) {
    const value = resolveValue(property.initializer, values);
    if (
      ts.isArrowFunction(value) ||
      ts.isFunctionExpression(value) ||
      ts.isFunctionDeclaration(value)
    ) {
      return value;
    }
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    const value = values.resolveAt(property.name.text, property.name);
    if (
      value &&
      (ts.isArrowFunction(value) ||
        ts.isFunctionExpression(value) ||
        ts.isFunctionDeclaration(value))
    ) {
      return value;
    }
  }
  return undefined;
}

function handlerFromBuilderCall(call, values) {
  const config = call.arguments[0]
    ? unwrapExpression(call.arguments[0])
    : undefined;
  if (!config || !ts.isObjectLiteralExpression(config)) return undefined;
  return functionLikeFromProperty(
    unambiguousObjectProperty(config, "handler", values),
    values,
  );
}

function emptyAdminBindingState() {
  return {
    publicIdentifiers: new Map(),
    internalIdentifiers: new Map(),
    generatedNamespaces: new Set(),
    functionsNamespaces: new Set(),
    directAuthIdentifiers: new Map(),
    tenancyNamespaces: new Map(),
  };
}

function recordNamespaceBinding(
  namespaceImport,
  specifier,
  file,
  bindingState,
) {
  const local = namespaceImport.name.text;
  if (isTrustedAdminModule(file, specifier, "server")) {
    bindingState.generatedNamespaces.add(local);
  } else if (isTrustedAdminModule(file, specifier, "functions")) {
    bindingState.functionsNamespaces.add(local);
  } else if (isTrustedAdminModule(file, specifier, "tenancy")) {
    bindingState.tenancyNamespaces.set(local, namespaceImport.name);
  }
}

function recordNamedBinding(element, specifier, file, bindingState) {
  if (element.isTypeOnly) return;
  const imported = (element.propertyName ?? element.name).text;
  const local = element.name.text;
  if (isTrustedAdminModule(file, specifier, "server")) {
    if (PUBLIC_GENERATED_BUILDERS.has(imported)) {
      bindingState.publicIdentifiers.set(local, imported);
    } else if (INTERNAL_GENERATED_BUILDERS.has(imported)) {
      bindingState.internalIdentifiers.set(local, imported);
    }
  } else if (
    isTrustedAdminModule(file, specifier, "functions") &&
    PUBLIC_WRAPPED_BUILDERS.has(imported)
  ) {
    bindingState.publicIdentifiers.set(local, imported);
  } else if (
    isTrustedAdminModule(file, specifier, "functions") &&
    INTERNAL_WRAPPED_BUILDERS.has(imported)
  ) {
    bindingState.internalIdentifiers.set(local, imported);
  } else if (
    isTrustedAdminModule(file, specifier, "tenancy") &&
    imported === "requireSuperAdmin"
  ) {
    bindingState.directAuthIdentifiers.set(local, element.name);
  }
}

function recordAdminImport(statement, file, bindingState) {
  if (!ts.isImportDeclaration(statement)) return;
  const specifier = moduleText(statement.moduleSpecifier);
  const clause = statement.importClause;
  if (!specifier || !clause || clause.isTypeOnly || !clause.namedBindings)
    return;
  if (ts.isNamespaceImport(clause.namedBindings)) {
    recordNamespaceBinding(clause.namedBindings, specifier, file, bindingState);
    return;
  }
  for (const element of clause.namedBindings.elements) {
    recordNamedBinding(element, specifier, file, bindingState);
  }
}

function builderKindFromSets(name, publicNames, internalNames) {
  if (publicNames.has(name)) return { visibility: "public", name };
  if (internalNames.has(name)) return { visibility: "internal", name };
  return undefined;
}

function namespaceBuilderKind(name, namespaceName, bindingState) {
  if (bindingState.generatedNamespaces.has(namespaceName)) {
    return builderKindFromSets(
      name,
      PUBLIC_GENERATED_BUILDERS,
      INTERNAL_GENERATED_BUILDERS,
    );
  }
  if (bindingState.functionsNamespaces.has(namespaceName)) {
    return builderKindFromSets(
      name,
      PUBLIC_WRAPPED_BUILDERS,
      INTERNAL_WRAPPED_BUILDERS,
    );
  }
  return undefined;
}

function identifierBuilderKind(current, bindingState, valueDeclarations, seen) {
  const publicName = bindingState.publicIdentifiers.get(current.text);
  if (publicName) return { visibility: "public", name: publicName };
  const internalName = bindingState.internalIdentifiers.get(current.text);
  if (internalName) return { visibility: "internal", name: internalName };
  if (seen.has(current.text)) return undefined;
  const resolved = resolveValue(current, valueDeclarations, new Set(seen));
  if (resolved === current) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(current.text);
  return builderKind(resolved, bindingState, valueDeclarations, nextSeen);
}

function builderKind(
  expression,
  bindingState,
  valueDeclarations,
  seen = new Set(),
) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return identifierBuilderKind(
      current,
      bindingState,
      valueDeclarations,
      seen,
    );
  }
  const name = memberName(current);
  const object = memberObject(current);
  const resolvedObject = object
    ? resolveValue(object, valueDeclarations)
    : undefined;
  if (!name || !resolvedObject || !ts.isIdentifier(resolvedObject))
    return undefined;
  return namespaceBuilderKind(name, resolvedObject.text, bindingState);
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
  if (ts.isFunctionDeclaration(value) && value.name) return value.name;
  return undefined;
}

function resolveVisibleValue(
  expression,
  bindingState,
  valueDeclarations,
  seen = new Set(),
) {
  let current = unwrapExpression(expression);
  const visited = new Set(seen);
  while (ts.isIdentifier(current)) {
    const resolved = valueDeclarations.resolveAt(current.text, current);
    const aliasBinding = resolved && declarationBindingForValue(resolved);
    if (
      !resolved ||
      !aliasBinding ||
      visited.has(aliasBinding) ||
      !bindingState.provenance.isUseOf(current, aliasBinding)
    ) {
      break;
    }
    visited.add(aliasBinding);
    current = unwrapExpression(resolved);
  }
  return current;
}

function namespaceAuthTarget(current, bindingState, valueDeclarations) {
  const object = memberObject(current);
  const resolvedObject = object
    ? resolveVisibleValue(object, bindingState, valueDeclarations)
    : undefined;
  const trustedNamespace =
    resolvedObject && ts.isIdentifier(resolvedObject)
      ? bindingState.tenancyNamespaces.get(resolvedObject.text)
      : undefined;
  return (
    memberName(current) === "requireSuperAdmin" &&
    resolvedObject &&
    ts.isIdentifier(resolvedObject) &&
    trustedNamespace &&
    bindingState.provenance.isUseOf(resolvedObject, trustedNamespace)
  );
}

function directAuthTarget(
  expression,
  bindingState,
  valueDeclarations,
  seen = new Set(),
) {
  let current = unwrapExpression(expression);
  const visited = new Set(seen);
  while (ts.isIdentifier(current)) {
    const trustedBinding = bindingState.directAuthIdentifiers.get(current.text);
    if (
      trustedBinding &&
      bindingState.provenance.isUseOf(current, trustedBinding)
    ) {
      return true;
    }
    const resolved = valueDeclarations.resolveAt(current.text, current);
    const aliasBinding = resolved && declarationBindingForValue(resolved);
    if (
      !resolved ||
      !aliasBinding ||
      visited.has(aliasBinding) ||
      !bindingState.provenance.isUseOf(current, aliasBinding)
    ) {
      return false;
    }
    visited.add(aliasBinding);
    current = unwrapExpression(resolved);
  }
  return namespaceAuthTarget(current, bindingState, valueDeclarations);
}

function collectAdminBindings(sourceFile, valueDeclarations, file) {
  const bindingState = emptyAdminBindingState();
  bindingState.provenance = createLexicalBindingProvenance(sourceFile);
  for (const statement of sourceFile.statements) {
    recordAdminImport(statement, file, bindingState);
  }
  collectDestructuredAdminAliases(sourceFile, valueDeclarations, bindingState, {
    publicGenerated: PUBLIC_GENERATED_BUILDERS,
    internalGenerated: INTERNAL_GENERATED_BUILDERS,
    publicWrapped: PUBLIC_WRAPPED_BUILDERS,
    internalWrapped: INTERNAL_WRAPPED_BUILDERS,
  });
  const internalReference = createInternalReferenceResolver(
    sourceFile,
    valueDeclarations,
    bindingState.provenance,
    file,
  );
  return {
    builderKind: (expression) =>
      builderKind(expression, bindingState, valueDeclarations),
    isStableValue: (identifier) =>
      !valueDeclarations.isInvalidAt(identifier.text, identifier),
    isDirectAuthTarget: (expression) =>
      directAuthTarget(expression, bindingState, valueDeclarations),
    provenance: bindingState.provenance,
    internalReference,
  };
}

function authenticatedDelegateNames(declarations, authScan) {
  const names = new Set();
  for (const declaration of declarations) {
    if (
      declaration.kind.visibility !== "internal" ||
      declaration.kind.name !== "internalQuery" ||
      declaration.immutable === false
    ) {
      continue;
    }
    const handler = handlerFromBuilderCall(declaration.call, authScan.values);
    if (
      handler &&
      handlerAuthenticates(
        handler,
        authScan.adminBindings,
        new Set(),
        authScan.currentModuleName,
      )
    ) {
      names.add(declaration.name);
    }
  }
  return names;
}

function publicAdminDiagnostics(declarations, authScan) {
  const diagnostics = [];
  for (const declaration of declarations) {
    if (declaration.kind.visibility === "internal") continue;
    if (declaration.kind.visibility === "unknown") {
      diagnostics.push(
        diagnostic({
          sourceFile: authScan.sourceFile,
          file: authScan.normalizedFile,
          node: declaration.node,
          ruleId: RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
          message: `Exported admin call "${declaration.name}" has unrecognized Convex builder provenance; export a direct generated/wrapped builder call so super-admin authentication can be verified.`,
        }),
      );
      continue;
    }
    if (declaration.immutable === false) {
      diagnostics.push(
        diagnostic({
          sourceFile: authScan.sourceFile,
          file: authScan.normalizedFile,
          node: declaration.node,
          ruleId: RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
          message: `Public admin function "${declaration.name}" must use an immutable const registration so authenticated handlers cannot be reassigned.`,
        }),
      );
      continue;
    }
    const handler = handlerFromBuilderCall(declaration.call, authScan.values);
    if (
      handler &&
      handlerAuthenticates(
        handler,
        authScan.adminBindings,
        authScan.delegatedAuthFunctions,
        authScan.currentModuleName,
      )
    ) {
      continue;
    }
    diagnostics.push(
      diagnostic({
        sourceFile: authScan.sourceFile,
        file: authScan.normalizedFile,
        node: handler ?? declaration.node,
        ruleId: RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
        message: `Public admin function "${declaration.name}" must await requireSuperAdmin(ctx), or a same-module authenticated internal query, in its first executable statement.`,
      }),
    );
  }
  return diagnostics;
}

function statementLocationKey(node, sourceFile) {
  let statement = node;
  while (statement.parent && statement.parent !== sourceFile) {
    statement = statement.parent;
  }
  const position = sourceFile.getLineAndCharacterOfPosition(
    statement.getStart(sourceFile, false),
  );
  return `${position.line + 1}:${position.character + 1}`;
}

function runtimeDiagnosticsWithoutBuilderDeclarations(
  runtimeDiagnostics,
  declarations,
  sourceFile,
) {
  const declarationLocations = new Set(
    declarations.map((declaration) =>
      statementLocationKey(declaration.node, sourceFile),
    ),
  );
  return runtimeDiagnostics.filter(
    (entry) => !declarationLocations.has(`${entry.line}:${entry.column}`),
  );
}

/** Enforces the /admin boundary for public Convex functions. */
export function scanAdminSuperAdmin(source, file = "convex/admin.ts") {
  const normalizedFile = normalizePath(file);
  const sourceFile = parseSource(source, normalizedFile);
  const values = collectUniqueValueDeclarations(sourceFile);
  const adminBindings = collectAdminBindings(
    sourceFile,
    values,
    normalizedFile,
  );
  const declarations = exportedBuilderDeclarations(
    sourceFile,
    values,
    adminBindings,
  );
  const convexRelativeFile = normalizedFile.startsWith("convex/")
    ? normalizedFile.slice("convex/".length)
    : path.posix.basename(normalizedFile);
  const currentModuleName = convexRelativeFile.replace(/\.[^.]+$/, "");
  const authScan = {
    sourceFile,
    normalizedFile,
    values,
    adminBindings,
    currentModuleName,
  };
  const delegatedAuthFunctions = authenticatedDelegateNames(
    declarations,
    authScan,
  );
  const runtimeExportDiagnostics = scanAdminRuntimeExports(
    sourceFile,
    normalizedFile,
    adminBindings,
  );
  const uniqueRuntimeDiagnostics = runtimeDiagnosticsWithoutBuilderDeclarations(
    runtimeExportDiagnostics,
    declarations,
    sourceFile,
  );
  return sortDiagnostics([
    ...uniqueRuntimeDiagnostics,
    ...publicAdminDiagnostics(declarations, {
      ...authScan,
      delegatedAuthFunctions,
    }),
  ]);
}
