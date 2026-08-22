import ts from "typescript";

function bindingHasAdditionalUses(sourceFile, binding, provenance) {
  const pending = [sourceFile];
  while (pending.length > 0) {
    const node = pending.pop();
    if (
      node !== binding &&
      ts.isIdentifier(node) &&
      provenance.isUseOf(node, binding)
    ) {
      return true;
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Allows the repository's one reviewed plain admin helper alias. */
export function trustedAdminAuditHelperExport(
  statement,
  sourceFile,
  file,
  provenance,
) {
  if (
    file !== "convex/adminAudit.ts" ||
    !ts.isVariableStatement(statement) ||
    !statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    statement.declarationList.declarations.length !== 1
  ) {
    return false;
  }
  const declaration = statement.declarationList.declarations[0];
  if (
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== "logAdminAction" ||
    !declaration.initializer ||
    !ts.isIdentifier(declaration.initializer) ||
    declaration.initializer.text !== "writeAuditLog"
  ) {
    return false;
  }
  if (bindingHasAdditionalUses(sourceFile, declaration.name, provenance)) {
    return false;
  }
  return sourceFile.statements.some((candidate) => {
    const clause = ts.isImportDeclaration(candidate)
      ? candidate.importClause
      : undefined;
    return (
      clause &&
      !clause.isTypeOnly &&
      ts.isStringLiteral(candidate.moduleSpecifier) &&
      candidate.moduleSpecifier.text === "./utils/auditLog" &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          !element.propertyName &&
          element.name.text === "writeAuditLog" &&
          provenance.isUseOf(declaration.initializer, element.name),
      )
    );
  });
}
