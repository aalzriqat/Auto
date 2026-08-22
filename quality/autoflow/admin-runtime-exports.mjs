import ts from "typescript";

import { RULE_IDS, diagnostic, unwrapExpression } from "./ast-utils.mjs";
import { expressionIsInert } from "./admin-parameters.mjs";
import { trustedAdminAuditHelperExport } from "./admin-runtime-provenance.mjs";

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function isTypeOnlyStatement(statement) {
  return (
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    (ts.isExportDeclaration(statement) && statement.isTypeOnly) ||
    hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
  );
}

function isDirectTrustedBuilder(expression, adminBindings) {
  const current = unwrapExpression(expression);
  return Boolean(
    ts.isCallExpression(current) &&
    adminBindings.builderKind(current.expression),
  );
}

function variableExportIsCanonical(statement, adminBindings) {
  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return false;
  return statement.declarationList.declarations.every(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      adminBindings.isStableValue(declaration.name) &&
      declaration.initializer &&
      (expressionIsInert(declaration.initializer) ||
        isDirectTrustedBuilder(declaration.initializer, adminBindings)),
  );
}

function exportDeclarationIsTypeOnly(statement) {
  return Boolean(
    statement.isTypeOnly ||
    (statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.every((element) => element.isTypeOnly)),
  );
}

function runtimeExportIsCanonical(statement, adminBindings) {
  if (isTypeOnlyStatement(statement)) return true;
  if (ts.isExportDeclaration(statement)) {
    return exportDeclarationIsTypeOnly(statement);
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    return !hasModifier(statement, ts.SyntaxKind.ExportKeyword);
  }
  if (ts.isExportAssignment(statement)) {
    return (
      !statement.isExportEquals &&
      (expressionIsInert(statement.expression) ||
        isDirectTrustedBuilder(statement.expression, adminBindings))
    );
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return true;
  return (
    ts.isVariableStatement(statement) &&
    variableExportIsCanonical(statement, adminBindings)
  );
}

function identifierIsPropertyName(identifier) {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) {
    return true;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent)) &&
    parent.name === identifier &&
    !ts.isComputedPropertyName(parent.name)
  ) {
    return true;
  }
  return false;
}

function containsAmbientCommonJs(statement, provenance) {
  const pending = [statement];
  while (pending.length > 0) {
    const node = pending.pop();
    if (ts.isTypeNode(node)) continue;
    if (
      ts.isIdentifier(node) &&
      (node.text === "module" || node.text === "exports") &&
      !identifierIsPropertyName(node) &&
      !provenance.hasBinding(node)
    ) {
      return true;
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Enforces a small, auditable runtime export surface for admin modules. */
export function scanAdminRuntimeExports(sourceFile, file, adminBindings) {
  const diagnostics = [];
  for (const statement of sourceFile.statements) {
    const allowedAuditHelper = trustedAdminAuditHelperExport(
      statement,
      sourceFile,
      file,
      adminBindings.provenance,
    );
    if (
      !allowedAuditHelper &&
      (!runtimeExportIsCanonical(statement, adminBindings) ||
        containsAmbientCommonJs(statement, adminBindings.provenance))
    ) {
      diagnostics.push(
        diagnostic({
          sourceFile,
          file,
          node: statement,
          ruleId: RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
          message:
            "Admin runtime re-exports must be immutable direct trusted Convex registrations or inert local constants; use type-only exports for types.",
        }),
      );
    }
  }
  return diagnostics;
}
