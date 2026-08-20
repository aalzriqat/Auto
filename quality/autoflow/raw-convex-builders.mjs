import path from "node:path";
import ts from "typescript";

import { createLexicalBindingProvenance } from "./lexical-binding-provenance.mjs";
import { inspectNamespaceEscapes } from "./raw-namespace-escapes.mjs";
import { createGeneratedNamespaceResolver } from "./raw-namespace-provenance.mjs";

import {
  RULE_IDS,
  collectUniqueValueDeclarations,
  diagnostic,
  hasModifier,
  isGeneratedServerModule,
  memberName,
  memberObject,
  moduleText,
  normalizePath,
  parseSource,
  propertyNameText,
  sortDiagnostics,
  staticString,
  unwrapAwait,
} from "./ast-utils.mjs";

const RAW_MUTATION_BUILDERS = new Set(["mutation", "internalMutation"]);

function isAllowedRawBuilderFile(file) {
  const normalized = normalizePath(file);
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  return path.posix.normalize(normalized) === "convex/functions.ts";
}

function isInTypePosition(node) {
  let current = node;
  while (current.parent) {
    current = current.parent;
    if (ts.isTypeNode(current)) return true;
    if (
      ts.isExpressionStatement(current) ||
      ts.isVariableStatement(current) ||
      ts.isReturnStatement(current) ||
      ts.isSourceFile(current)
    ) {
      return false;
    }
  }
  return false;
}

function bindingImportedName(element, valueDeclarations) {
  if (element.dotDotDotToken) return "*";
  return propertyNameText(
    element.propertyName ?? element.name,
    valueDeclarations,
  );
}

function inspectForbiddenBindingPattern(
  pattern,
  report,
  context,
  valueDeclarations,
) {
  if (!ts.isObjectBindingPattern(pattern)) return;
  for (const element of pattern.elements) {
    const imported = bindingImportedName(element, valueDeclarations);
    if (
      imported === undefined ||
      imported === "*" ||
      RAW_MUTATION_BUILDERS.has(imported)
    ) {
      report(
        element,
        imported === undefined
          ? `${context} uses a computed binding that cannot exclude mutation/internalMutation; use a statically named query/action member.`
          : imported === "*"
            ? `${context} uses a rest binding that exposes raw mutation builders; import mutation/internalMutation from convex/functions.ts.`
            : `${context} takes raw ${imported}; import it from convex/functions.ts so aggregate triggers fire.`,
      );
    }
  }
}

function inspectForbiddenAssignmentPattern(
  pattern,
  report,
  context,
  valueDeclarations,
) {
  if (!ts.isObjectLiteralExpression(pattern)) {
    report(
      pattern,
      `${context} cannot prove that mutation/internalMutation is excluded from the generated-server assignment.`,
    );
    return;
  }
  for (const property of pattern.properties) {
    const imported = ts.isSpreadAssignment(property)
      ? "*"
      : propertyNameText(property.name, valueDeclarations);
    if (
      imported === undefined ||
      imported === "*" ||
      RAW_MUTATION_BUILDERS.has(imported)
    ) {
      report(
        property,
        imported === undefined
          ? `${context} uses a computed property that cannot exclude mutation/internalMutation.`
          : imported === "*"
            ? `${context} uses a rest target that exposes raw mutation builders.`
            : `${context} takes raw ${imported}; import it from convex/functions.ts so aggregate triggers fire.`,
      );
    }
  }
}

function inspectGeneratedImportEquals(statement, namespaceResolver, report) {
  const reference = statement.moduleReference;
  const specifier =
    ts.isExternalModuleReference(reference) && reference.expression
      ? moduleText(reference.expression)
      : undefined;
  if (
    !specifier ||
    !isGeneratedServerModule(specifier) ||
    statement.isTypeOnly
  ) {
    return;
  }
  if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    report(
      statement,
      `Exported import-equals binding from ${specifier} exposes raw mutation builders.`,
    );
    return;
  }
  namespaceResolver.addBinding(statement.name);
}

function inspectGeneratedImport(statement, namespaceResolver, report) {
  if (ts.isImportEqualsDeclaration(statement)) {
    inspectGeneratedImportEquals(statement, namespaceResolver, report);
    return;
  }
  if (!ts.isImportDeclaration(statement)) return;
  const specifier = moduleText(statement.moduleSpecifier);
  const clause = statement.importClause;
  if (
    !specifier ||
    !isGeneratedServerModule(specifier) ||
    !clause ||
    clause.isTypeOnly ||
    !clause.namedBindings
  ) {
    return;
  }
  if (ts.isNamespaceImport(clause.namedBindings)) {
    namespaceResolver.addBinding(clause.namedBindings.name);
    return;
  }
  for (const element of clause.namedBindings.elements) {
    const imported = (element.propertyName ?? element.name).text;
    if (!element.isTypeOnly && RAW_MUTATION_BUILDERS.has(imported)) {
      report(
        element,
        `Raw ${imported} is imported from ${specifier}; import it from convex/functions.ts so aggregate triggers fire.`,
      );
    }
  }
}

function inspectGeneratedReExport(statement, report) {
  if (!ts.isExportDeclaration(statement)) return;
  const specifier = statement.moduleSpecifier
    ? moduleText(statement.moduleSpecifier)
    : undefined;
  if (
    !specifier ||
    !isGeneratedServerModule(specifier) ||
    statement.isTypeOnly
  ) {
    return;
  }
  if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
    report(
      statement,
      `Runtime star re-export from ${specifier} exposes raw mutation builders; export wrapped builders from convex/functions.ts instead.`,
    );
    return;
  }
  for (const element of statement.exportClause.elements) {
    const exportedFromModule = (element.propertyName ?? element.name).text;
    if (!element.isTypeOnly && RAW_MUTATION_BUILDERS.has(exportedFromModule)) {
      report(
        element,
        `Re-export of raw ${exportedFromModule} from ${specifier} bypasses convex/functions.ts.`,
      );
    }
  }
}

function collectStaticBindings(sourceFile, namespaceResolver, report) {
  for (const statement of sourceFile.statements) {
    inspectGeneratedImport(statement, namespaceResolver, report);
    inspectGeneratedReExport(statement, report);
  }
}

function collectNamespaceAliases(sourceFile, namespaceContext) {
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      namespaceContext.isNamespace(node.initializer)
    ) {
      if (ts.isIdentifier(node.name)) {
        namespaceContext.resolver.addBinding(node.name);
      } else {
        inspectForbiddenBindingPattern(
          node.name,
          namespaceContext.report,
          "Generated-server destructuring",
          namespaceContext.valueDeclarations,
        );
      }
    } else if (
      ts.isParameter(node) &&
      node.initializer &&
      namespaceContext.isNamespace(node.initializer)
    ) {
      if (ts.isIdentifier(node.name)) {
        namespaceContext.resolver.addBinding(node.name);
      } else {
        inspectForbiddenBindingPattern(
          node.name,
          namespaceContext.report,
          "Generated-server default parameter",
          namespaceContext.valueDeclarations,
        );
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      namespaceContext.isNamespace(node.right) &&
      !isUnshadowedModuleExports(node.left, namespaceContext.provenance)
    ) {
      inspectForbiddenAssignmentPattern(
        node.left,
        namespaceContext.report,
        "Generated-server destructuring assignment",
        namespaceContext.valueDeclarations,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function inspectNamespaceMember(node, namespaceScan) {
  if (
    (!ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)) ||
    isInTypePosition(node)
  ) {
    return;
  }
  const object = memberObject(node);
  if (!object || !namespaceScan.isNamespace(object)) return;
  const name = ts.isElementAccessExpression(node)
    ? staticString(node.argumentExpression, namespaceScan.valueDeclarations)
    : memberName(node);
  if (name && RAW_MUTATION_BUILDERS.has(name)) {
    namespaceScan.report(
      node,
      `Raw ${name} is accessed through the generated-server namespace; import it from convex/functions.ts so aggregate triggers fire.`,
    );
  } else if (ts.isElementAccessExpression(node) && name === undefined) {
    namespaceScan.report(
      node,
      "Computed generated-server access cannot prove that mutation/internalMutation is excluded; use a named query/action member or import wrapped mutations from convex/functions.ts.",
    );
  }
}

function callbackNamespaceResolver(parameter, namespaceScan) {
  const resolves = (expression, seen = new Set()) => {
    const current = unwrapAwait(expression);
    if (ts.isObjectLiteralExpression(current)) {
      return current.properties.some(
        (property) =>
          ts.isSpreadAssignment(property) &&
          resolves(property.expression, seen),
      );
    }
    if (!ts.isIdentifier(current)) return false;
    if (namespaceScan.provenance.isUseOf(current, parameter)) return true;
    if (seen.has(current.text)) return false;
    const resolved = namespaceScan.valueDeclarations.resolveAt(
      current.text,
      current,
    );
    const declaration = resolved?.parent;
    if (
      !resolved ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== resolved ||
      !ts.isIdentifier(declaration.name) ||
      !namespaceScan.provenance.isUseOf(current, declaration.name)
    ) {
      return false;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(current.text);
    return resolves(resolved, nextSeen);
  };
  return resolves;
}

function inspectCallbackNamespaceMember(
  node,
  isCallbackNamespace,
  namespaceScan,
) {
  if (
    (!ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)) ||
    isInTypePosition(node)
  ) {
    return;
  }
  const object = memberObject(node);
  if (!object || !isCallbackNamespace(object)) return;
  const name = ts.isElementAccessExpression(node)
    ? staticString(node.argumentExpression, namespaceScan.valueDeclarations)
    : memberName(node);
  if (name && RAW_MUTATION_BUILDERS.has(name)) {
    namespaceScan.report(
      node,
      `Raw ${name} is accessed through a generated dynamic-import namespace; import it from convex/functions.ts so aggregate triggers fire.`,
    );
  } else if (ts.isElementAccessExpression(node) && name === undefined) {
    namespaceScan.report(
      node,
      "Computed generated dynamic-import access cannot prove that mutation/internalMutation is excluded; use a named query/action member.",
    );
  }
}

function inspectDynamicImportCallback(node, namespaceScan) {
  if (!ts.isCallExpression(node) || memberName(node.expression) !== "then")
    return;
  const receiver = memberObject(node.expression);
  const specifier = receiver
    ? namespaceScan.namespaceResolver.generatedSpecifier(receiver)
    : undefined;
  const callbackExpression = node.arguments[0];
  if (
    !specifier ||
    !isGeneratedServerModule(specifier) ||
    !callbackExpression
  ) {
    return;
  }
  const callback =
    namespaceScan.namespaceResolver.resolveLocalFunction(callbackExpression);
  if (!callback) {
    namespaceScan.report(
      callbackExpression,
      "Generated-server dynamic import uses a callback whose handling of mutation/internalMutation cannot be verified.",
    );
    return;
  }
  if (!callback.parameters[0]) return;
  const parameter = callback.parameters[0].name;
  inspectForbiddenBindingPattern(
    parameter,
    namespaceScan.report,
    "Dynamic-import callback",
    namespaceScan.valueDeclarations,
  );
  if (!ts.isIdentifier(parameter)) {
    if (!ts.isObjectBindingPattern(parameter)) {
      namespaceScan.report(
        parameter,
        "Generated-server dynamic import callback must use an identifier or statically named object binding.",
      );
    }
    return;
  }

  const isCallbackNamespace = callbackNamespaceResolver(
    parameter,
    namespaceScan,
  );
  const visit = (candidate) => {
    inspectCallbackNamespaceMember(
      candidate,
      isCallbackNamespace,
      namespaceScan,
    );
    inspectNamespaceEscapes(candidate, {
      ...namespaceScan,
      isNamespace: isCallbackNamespace,
      namespaceLabel: "generated dynamic-import namespace",
    });
    if (
      ts.isVariableDeclaration(candidate) &&
      candidate.initializer &&
      isCallbackNamespace(candidate.initializer)
    ) {
      inspectForbiddenBindingPattern(
        candidate.name,
        namespaceScan.report,
        "Dynamic-import namespace destructuring",
        namespaceScan.valueDeclarations,
      );
    }
    ts.forEachChild(candidate, visit);
  };
  visit(callback.body);
}

function isUnshadowedModuleExports(expression, provenance) {
  const current = unwrapAwait(expression);
  const object = memberObject(current);
  return (
    memberName(current) === "exports" &&
    object &&
    ts.isIdentifier(object) &&
    object.text === "module" &&
    !provenance.hasBinding(object)
  );
}

function inspectCommonJsReExport(node, namespaceScan) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !isUnshadowedModuleExports(node.left, namespaceScan.provenance) ||
    !namespaceScan.isNamespace(node.right)
  ) {
    return;
  }
  namespaceScan.report(
    node,
    "CommonJS whole-module re-export exposes raw mutation builders; export wrapped builders from convex/functions.ts instead.",
  );
}

function inspectRuntimeNamespaceUses(sourceFile, namespaceScan) {
  const visit = (node) => {
    inspectNamespaceMember(node, namespaceScan);
    inspectDynamicImportCallback(node, namespaceScan);
    inspectCommonJsReExport(node, namespaceScan);
    inspectNamespaceEscapes(node, namespaceScan);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * Rejects raw mutation builders by module provenance, not spelling. Actions,
 * queries and type-only references are intentionally allowed: actions have no
 * ctx.db, and the aggregate wrapper exists only for mutation builders.
 */
export function scanRawConvexBuilders(source, file = "convex/module.ts") {
  const normalizedFile = normalizePath(file);
  if (isAllowedRawBuilderFile(normalizedFile)) return [];

  const sourceFile = parseSource(source, normalizedFile);
  const valueDeclarations = collectUniqueValueDeclarations(sourceFile);
  const diagnostics = [];
  const report = (node, message) => {
    diagnostics.push(
      diagnostic({
        sourceFile,
        file: normalizedFile,
        node,
        ruleId: RULE_IDS.RAW_CONVEX_MUTATION_BUILDER,
        message,
      }),
    );
  };
  const provenance = createLexicalBindingProvenance(sourceFile);
  const namespaceResolver = createGeneratedNamespaceResolver(
    valueDeclarations,
    provenance,
  );
  collectStaticBindings(sourceFile, namespaceResolver, report);
  const isNamespace = namespaceResolver.isNamespace;
  collectNamespaceAliases(sourceFile, {
    isNamespace,
    resolver: namespaceResolver,
    provenance,
    report,
    valueDeclarations,
  });
  inspectRuntimeNamespaceUses(sourceFile, {
    isNamespace,
    namespaceResolver,
    valueDeclarations,
    provenance,
    report,
  });

  return sortDiagnostics(diagnostics);
}
