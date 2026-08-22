import path from "node:path";

import ts from "typescript";

import { createLexicalBindingProvenance } from "./lexical-binding-provenance.mjs";
import {
  RULE_IDS,
  diagnostic,
  hasModifier,
  moduleText,
  normalizePath,
  parseSource,
  sortDiagnostics,
  unwrapExpression,
} from "./ast-utils.mjs";

const CANONICAL_GENERATED_SERVER = "convex/_generated/server";
const RAW_MUTATION_BUILDERS = new Set(["mutation", "internalMutation"]);
const SAFE_RUNTIME_MEMBERS = new Set([
  "action",
  "httpAction",
  "internalAction",
  "internalQuery",
  "query",
]);
const SAFE_REQUIRE_METADATA = new Set(["extensions", "resolve"]);

function repositoryPath(file) {
  const normalized = path.posix.normalize(normalizePath(file));
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    return undefined;
  }
  return normalized.replace(/^\.\//u, "");
}

function moduleWithoutExtension(modulePath) {
  return modulePath.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/u, "");
}

function resolvedModulePath(specifier, file) {
  const sourcePath = path.posix.normalize(normalizePath(file));
  if (!specifier.startsWith(".")) return undefined;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePath), normalizePath(specifier)),
  );
  return moduleWithoutExtension(resolved);
}

function canonicalGeneratedServerPath(file) {
  const sourcePath = path.posix.normalize(normalizePath(file));
  if (repositoryPath(sourcePath)?.startsWith("convex/")) {
    return CANONICAL_GENERATED_SERVER;
  }
  if (!path.posix.isAbsolute(sourcePath) && !/^[A-Za-z]:\//u.test(sourcePath)) {
    return undefined;
  }
  const markerIndex = sourcePath.indexOf("/convex/");
  return markerIndex < 0
    ? undefined
    : `${sourcePath.slice(0, markerIndex)}/${CANONICAL_GENERATED_SERVER}`;
}

function isCanonicalGeneratedServer(specifier, file) {
  return (
    resolvedModulePath(specifier, file) === canonicalGeneratedServerPath(file)
  );
}

function isCanonicalWrapperFile(file) {
  return repositoryPath(file) === "convex/functions.ts";
}

function hasExportModifier(node) {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isInTypePosition(node) {
  let current = node;
  while (current.parent) {
    current = current.parent;
    if (ts.isTypeNode(current)) return true;
    if (
      ts.isExportSpecifier(current) &&
      (current.isTypeOnly || current.parent?.parent?.isTypeOnly)
    ) {
      return true;
    }
    if (ts.isExpressionStatement(current) || ts.isSourceFile(current)) {
      return false;
    }
  }
  return false;
}

function expressionEnvelope(node) {
  let current = node;
  while (
    current.parent &&
    current.parent !== current &&
    unwrapExpression(current.parent) === current
  ) {
    current = current.parent;
  }
  return current;
}

function isIdentifierReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isExportSpecifier(parent)) {
    return !parent.propertyName || parent.propertyName === node;
  }
  if (parent.name === node && !ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }
  if (parent.propertyName === node) return false;
  if (ts.isQualifiedName(parent) || ts.isTypeNode(parent)) return false;
  if (
    (ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
    parent.label === node
  ) {
    return false;
  }
  return true;
}

function literalMemberName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!ts.isElementAccessExpression(expression)) return undefined;
  const argument = expression.argumentExpression
    ? unwrapExpression(expression.argumentExpression)
    : undefined;
  return argument &&
    (ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function directMemberUse(namespaceExpression) {
  const envelope = expressionEnvelope(namespaceExpression);
  const parent = envelope.parent;
  if (
    (!ts.isPropertyAccessExpression(parent) &&
      !ts.isElementAccessExpression(parent)) ||
    unwrapExpression(parent.expression) !== unwrapExpression(envelope)
  ) {
    return undefined;
  }
  return { member: literalMemberName(parent), node: parent };
}

function addNamespaceBinding(identifier, state) {
  const existing = state.bindings.get(identifier.text);
  if (existing) existing.push(identifier);
  else state.bindings.set(identifier.text, [identifier]);
}

function report(state, node, message) {
  state.diagnostics.push(
    diagnostic({
      sourceFile: state.sourceFile,
      file: state.file,
      node,
      ruleId: RULE_IDS.RAW_CONVEX_MUTATION_BUILDER,
      message,
    }),
  );
}

function reportRawBuilder(state, node, name) {
  report(
    state,
    node,
    `Raw ${name} comes from convex/_generated/server; import it from convex/functions.ts so aggregate triggers fire.`,
  );
}

function reportNamespaceEscape(state, node) {
  report(
    state,
    node,
    "Generated-server namespace escapes its direct safe-member boundary; replace the namespace with a static named import.",
  );
}

function inspectDirectNamespaceUse(namespaceExpression, state) {
  const access = directMemberUse(namespaceExpression);
  if (!access) {
    reportNamespaceEscape(state, expressionEnvelope(namespaceExpression));
    return;
  }
  if (access.member && RAW_MUTATION_BUILDERS.has(access.member)) {
    reportRawBuilder(state, access.node, access.member);
    return;
  }
  if (!access.member || !SAFE_RUNTIME_MEMBERS.has(access.member)) {
    report(
      state,
      access.node,
      "Generated-server namespace access is not an approved static safe member; use query, action, internalQuery, internalAction, or httpAction.",
    );
  }
}

function inspectNamedImports(elements, state) {
  for (const element of elements) {
    const imported = (element.propertyName ?? element.name).text;
    if (
      !element.isTypeOnly &&
      RAW_MUTATION_BUILDERS.has(imported) &&
      !state.allowRawImport
    ) {
      reportRawBuilder(state, element, imported);
    }
  }
}

function inspectImportDeclaration(statement, state) {
  const specifier = moduleText(statement.moduleSpecifier);
  if (!specifier || !isCanonicalGeneratedServer(specifier, state.file)) return;
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) return;
  if (clause.name) reportNamespaceEscape(state, clause.name);
  if (!clause.namedBindings) return;
  if (ts.isNamespaceImport(clause.namedBindings)) {
    addNamespaceBinding(clause.namedBindings.name, state);
    return;
  }
  inspectNamedImports(clause.namedBindings.elements, state);
}

function inspectImportEquals(statement, state) {
  const reference = statement.moduleReference;
  const specifier =
    ts.isExternalModuleReference(reference) && reference.expression
      ? moduleText(reference.expression)
      : undefined;
  if (
    !specifier ||
    !isCanonicalGeneratedServer(specifier, state.file) ||
    statement.isTypeOnly
  ) {
    return;
  }
  addNamespaceBinding(statement.name, state);
  if (hasExportModifier(statement)) reportNamespaceEscape(state, statement);
}

function inspectExportDeclaration(statement, state) {
  const specifier = statement.moduleSpecifier
    ? moduleText(statement.moduleSpecifier)
    : undefined;
  if (
    !specifier ||
    !isCanonicalGeneratedServer(specifier, state.file) ||
    statement.isTypeOnly
  ) {
    return;
  }
  if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
    reportNamespaceEscape(state, statement);
    return;
  }
  for (const element of statement.exportClause.elements) {
    const imported = (element.propertyName ?? element.name).text;
    if (!element.isTypeOnly && RAW_MUTATION_BUILDERS.has(imported)) {
      reportRawBuilder(state, element, imported);
    }
  }
}

function inspectStaticModules(sourceFile, state) {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      inspectImportDeclaration(statement, state);
    } else if (ts.isImportEqualsDeclaration(statement)) {
      inspectImportEquals(statement, state);
    } else if (ts.isExportDeclaration(statement)) {
      inspectExportDeclaration(statement, state);
    }
  }
}

function directRequireCall(node, provenance) {
  const callee = unwrapExpression(node.expression);
  return (
    ts.isIdentifier(callee) &&
    callee.text === "require" &&
    !provenance.hasBinding(callee)
  );
}

function directModuleRequireCall(node, provenance) {
  const callee = unwrapExpression(node.expression);
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return false;
  }
  const receiver = unwrapExpression(callee.expression);
  return (
    literalMemberName(callee) === "require" &&
    ts.isIdentifier(receiver) &&
    receiver.text === "module" &&
    !provenance.hasBinding(receiver)
  );
}

function literalLoaderSpecifier(node) {
  return node.arguments.length === 1 && !node.questionDotToken
    ? moduleText(node.arguments[0])
    : undefined;
}

function constLoaderDeclaration(node) {
  const envelope = expressionEnvelope(node);
  const declaration = envelope.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    unwrapExpression(declaration.initializer) !== unwrapExpression(envelope) ||
    !ts.isIdentifier(declaration.name) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    return undefined;
  }
  return declaration;
}

function declarationIsExported(declaration) {
  const statement = declaration.parent?.parent;
  return Boolean(statement && hasExportModifier(statement));
}

function inspectGeneratedRequire(node, state) {
  const declaration = constLoaderDeclaration(node);
  if (declaration) {
    addNamespaceBinding(declaration.name, state);
    if (declarationIsExported(declaration)) {
      reportNamespaceEscape(state, declaration);
    }
    return;
  }
  inspectDirectNamespaceUse(node, state);
}

function inspectRequireCall(node, state) {
  if (directModuleRequireCall(node, state.provenance)) {
    report(
      state,
      node,
      "module.require is not an auditable generated-server access; use a static named import.",
    );
    return;
  }
  if (!directRequireCall(node, state.provenance)) return;
  const specifier = literalLoaderSpecifier(node);
  if (specifier === undefined) {
    report(
      state,
      node,
      "CommonJS loader target cannot be verified; use a static named import with a literal module specifier.",
    );
  } else if (isCanonicalGeneratedServer(specifier, state.file)) {
    inspectGeneratedRequire(node, state);
  }
}

function inspectDynamicImport(node, state) {
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
  const specifier = literalLoaderSpecifier(node);
  if (specifier === undefined) {
    report(
      state,
      node,
      "Dynamic import target cannot be verified; use a static named import with a literal module specifier.",
    );
  } else if (isCanonicalGeneratedServer(specifier, state.file)) {
    report(
      state,
      node,
      "Generated-server dynamic imports are forbidden; use a static named import.",
    );
  }
}

function collectRuntimeLoaders(node, state) {
  if (ts.isCallExpression(node)) {
    inspectDynamicImport(node, state);
    inspectRequireCall(node, state);
  }
  ts.forEachChild(node, (child) => collectRuntimeLoaders(child, state));
}

function trackedBinding(identifier, state) {
  return (state.bindings.get(identifier.text) ?? []).find((target) =>
    state.provenance.isUseOf(identifier, target),
  );
}

function isDirectCallee(identifier) {
  const envelope = expressionEnvelope(identifier);
  return (
    ts.isCallExpression(envelope.parent) &&
    unwrapExpression(envelope.parent.expression) === unwrapExpression(envelope)
  );
}

function isSafeRequireMetadata(identifier) {
  const access = directMemberUse(identifier);
  return Boolean(access?.member && SAFE_REQUIRE_METADATA.has(access.member));
}

function inspectIndirectRequire(identifier, state) {
  if (
    identifier.text !== "require" ||
    state.provenance.hasBinding(identifier) ||
    !isIdentifierReference(identifier) ||
    isDirectCallee(identifier) ||
    isSafeRequireMetadata(identifier) ||
    ts.isTypeOfExpression(expressionEnvelope(identifier).parent)
  ) {
    return;
  }
  report(
    state,
    identifier,
    "Indirect CommonJS loading cannot be audited; call require directly with a literal specifier or use a static named import.",
  );
}

function inspectIdentifier(identifier, state) {
  inspectIndirectRequire(identifier, state);
  if (!isIdentifierReference(identifier) || isInTypePosition(identifier)) {
    return;
  }
  const binding = trackedBinding(identifier, state);
  if (!binding || binding === identifier) return;
  inspectDirectNamespaceUse(identifier, state);
}

function inspectNamespaceUses(node, state) {
  if (ts.isIdentifier(node)) inspectIdentifier(node, state);
  ts.forEachChild(node, (child) => inspectNamespaceUses(child, state));
}

/** Enforces static named access to the canonical generated Convex server API. */
export function scanRawConvexBuilders(source, file = "convex/module.ts") {
  const normalizedFile = normalizePath(file);
  const sourceFile = parseSource(source, normalizedFile);
  const state = {
    allowRawImport: isCanonicalWrapperFile(normalizedFile),
    bindings: new Map(),
    diagnostics: [],
    file: normalizedFile,
    provenance: createLexicalBindingProvenance(sourceFile),
    sourceFile,
  };
  inspectStaticModules(sourceFile, state);
  collectRuntimeLoaders(sourceFile, state);
  inspectNamespaceUses(sourceFile, state);
  return sortDiagnostics(state.diagnostics);
}
