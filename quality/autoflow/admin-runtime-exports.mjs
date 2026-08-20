import ts from "typescript";

import {
  RULE_IDS,
  collectUniqueValueDeclarations,
  diagnostic,
  memberName,
  memberObject,
  staticString,
  unwrapExpression,
} from "./ast-utils.mjs";

function addImportBinding(bindings, identifier) {
  const existing = bindings.get(identifier.text);
  if (existing) existing.push(identifier);
  else bindings.set(identifier.text, [identifier]);
}

function runtimeImportBindings(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      if (!statement.isTypeOnly) addImportBinding(bindings, statement.name);
      continue;
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) addImportBinding(bindings, clause.name);
    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) addImportBinding(bindings, named.name);
    else {
      for (const element of named.elements) {
        if (!element.isTypeOnly) addImportBinding(bindings, element.name);
      }
    }
  }
  return bindings;
}

function isImportedUse(identifier, bindings, provenance) {
  return (bindings.get(identifier.text) ?? []).some((target) =>
    provenance.isUseOf(identifier, target),
  );
}

function runtimeModuleReExport(statement) {
  if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) {
    return false;
  }
  if (statement.isTypeOnly) return false;
  if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
    return true;
  }
  return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

function localImportedReExport(statement, imports, provenance) {
  if (
    !ts.isExportDeclaration(statement) ||
    statement.moduleSpecifier ||
    statement.isTypeOnly ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  ) {
    return false;
  }
  return statement.exportClause.elements.some((element) => {
    if (element.isTypeOnly) return false;
    const local = element.propertyName ?? element.name;
    return isImportedUse(local, imports, provenance);
  });
}

function importedExportValue(expression, imports, provenance) {
  let current = unwrapExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = memberObject(current);
  }
  return (
    ts.isIdentifier(current) && isImportedUse(current, imports, provenance)
  );
}

function esmRuntimeExport(statement, imports, provenance) {
  if (ts.isImportEqualsDeclaration(statement)) {
    return (
      !statement.isTypeOnly &&
      Boolean(
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ),
      )
    );
  }
  if (runtimeModuleReExport(statement)) return true;
  if (localImportedReExport(statement, imports, provenance)) return true;
  if (!ts.isExportAssignment(statement)) return false;
  return (
    statement.isExportEquals ||
    importedExportValue(statement.expression, imports, provenance)
  );
}

function expressionChain(expression) {
  const parts = [];
  let current = unwrapExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    const name = memberName(current);
    if (!name) return undefined;
    parts.unshift(name);
    current = memberObject(current);
  }
  return ts.isIdentifier(current) ? { root: current, parts } : undefined;
}

function directCommonJsExportReference(chain, provenance) {
  if (provenance.hasBinding(chain.root)) return undefined;
  if (chain.root.text === "module" && chain.parts[0] === "exports") {
    return { kind: "module.exports", remainingParts: chain.parts.length - 1 };
  }
  if (chain.root.text === "exports") {
    return { kind: "exports", remainingParts: chain.parts.length };
  }
  return undefined;
}

function commonJsExportReference(
  expression,
  provenance,
  seenBindings = new Set(),
) {
  const chain = expressionChain(expression);
  if (!chain) return undefined;
  const direct = directCommonJsExportReference(chain, provenance);
  if (direct) return direct;

  const binding = provenance.bindingOf(chain.root);
  const declaration = binding?.parent;
  if (
    !binding ||
    seenBindings.has(binding) ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.name !== binding ||
    !declaration.initializer ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    return undefined;
  }
  const nextSeen = new Set(seenBindings);
  nextSeen.add(binding);
  const target = commonJsExportReference(
    declaration.initializer,
    provenance,
    nextSeen,
  );
  return target
    ? {
        ...target,
        remainingParts: target.remainingParts + chain.parts.length,
      }
    : undefined;
}

function commonJsExportTarget(expression, provenance, allowExportsObject) {
  const target = commonJsExportReference(expression, provenance);
  if (!target) return false;
  return (
    target.kind === "module.exports" ||
    allowExportsObject ||
    target.remainingParts > 0
  );
}

function assignmentOperator(kind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function resolveImmutableAlias(expression, provenance, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (!ts.isIdentifier(current)) return current;
  const binding = provenance.bindingOf(current);
  if (!binding || seen.has(binding)) return current;
  const declaration = binding.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.name !== binding ||
    !declaration.initializer ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    return current;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(binding);
  return resolveImmutableAlias(declaration.initializer, provenance, nextSeen);
}

function unshadowedBuiltinMember(
  expression,
  objectName,
  operation,
  provenance,
  values,
) {
  const current = resolveImmutableAlias(expression, provenance);
  const object = memberObject(current);
  const operationName = ts.isElementAccessExpression(current)
    ? staticString(current.argumentExpression, values)
    : memberName(current);
  return (
    operationName === operation &&
    object &&
    ts.isIdentifier(object) &&
    object.text === objectName &&
    !provenance.hasBinding(object)
  );
}

function commonJsRuntimeExport(node, provenance, values) {
  if (
    ts.isBinaryExpression(node) &&
    assignmentOperator(node.operatorToken.kind)
  ) {
    return commonJsExportTarget(node.left, provenance, false);
  }
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return false;
  const mutatesTarget =
    unshadowedBuiltinMember(
      node.expression,
      "Object",
      "assign",
      provenance,
      values,
    ) ||
    unshadowedBuiltinMember(
      node.expression,
      "Object",
      "defineProperty",
      provenance,
      values,
    ) ||
    unshadowedBuiltinMember(
      node.expression,
      "Object",
      "defineProperties",
      provenance,
      values,
    ) ||
    unshadowedBuiltinMember(
      node.expression,
      "Reflect",
      "set",
      provenance,
      values,
    ) ||
    unshadowedBuiltinMember(
      node.expression,
      "Reflect",
      "defineProperty",
      provenance,
      values,
    );
  return (
    mutatesTarget && commonJsExportTarget(node.arguments[0], provenance, true)
  );
}

/** Rejects runtime re-export surfaces that cannot prove handler authentication. */
export function scanAdminRuntimeExports(sourceFile, file, provenance) {
  const imports = runtimeImportBindings(sourceFile);
  const values = collectUniqueValueDeclarations(sourceFile);
  const diagnostics = [];
  const report = (node) => {
    diagnostics.push(
      diagnostic({
        sourceFile,
        file,
        node,
        ruleId: RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
        message:
          "Admin modules may not runtime re-export imported or CommonJS values because super-admin authentication cannot be proven; export authenticated local Convex registrations or type-only symbols.",
      }),
    );
  };
  for (const statement of sourceFile.statements) {
    if (esmRuntimeExport(statement, imports, provenance)) report(statement);
  }
  const visit = (node) => {
    if (commonJsRuntimeExport(node, provenance, values)) report(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return diagnostics;
}
