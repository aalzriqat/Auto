import ts from "typescript";

import {
  collectExportedNames,
  hasModifier,
  resolveValue,
  unwrapExpression,
} from "./ast-utils.mjs";

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name];
  const identifiers = [];
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      identifiers.push(...bindingIdentifiers(element.name));
    }
  }
  return identifiers;
}

function containsPublicBuilder(initializer, adminBindings) {
  let found = false;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      adminBindings.builderKind(node.expression)?.visibility === "public"
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(initializer);
  return found;
}

function recordInitializer({
  declarations,
  name,
  initializer,
  node,
  immutable,
  adminBindings,
}) {
  const current = unwrapExpression(initializer);
  if (!ts.isCallExpression(current)) {
    if (containsPublicBuilder(current, adminBindings)) {
      declarations.push({
        name,
        call: undefined,
        node,
        immutable,
        kind: { visibility: "unknown", name: "wrapped-public-builder" },
      });
    }
    return;
  }
  const kind = adminBindings.builderKind(current.expression) ?? {
    visibility: "unknown",
    name: "unrecognized",
  };
  declarations.push({ name, call: current, node, immutable, kind });
}

function declarationIsExported(statement, names, exportedNames) {
  return (
    hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
    names.some((name) => exportedNames.has(name))
  );
}

function recordVariableStatement({
  statement,
  exportedNames,
  exportedTargets,
  declarations,
  adminBindings,
  values,
}) {
  const immutable = Boolean(
    statement.declarationList.flags & ts.NodeFlags.Const,
  );
  for (const declaration of statement.declarationList.declarations) {
    const identifiers = bindingIdentifiers(declaration.name);
    const names = identifiers.map((identifier) => identifier.text);
    if (!declarationIsExported(statement, names, exportedNames)) continue;
    for (const identifier of identifiers) {
      const targets = exportedTargets.get(identifier.text);
      if (targets) targets.push(identifier);
      else exportedTargets.set(identifier.text, [identifier]);
    }
    if (!declaration.initializer) continue;
    const initializer = resolveValue(declaration.initializer, values);
    if (ts.isIdentifier(declaration.name)) {
      recordInitializer({
        declarations,
        name: declaration.name.text,
        initializer,
        node: declaration,
        immutable,
        adminBindings,
      });
    } else if (
      containsPublicBuilder(initializer, adminBindings) ||
      containsPublicBuilder(declaration.name, adminBindings)
    ) {
      declarations.push({
        name: names.join(", ") || "destructured",
        call: undefined,
        node: declaration,
        immutable,
        kind: { visibility: "unknown", name: "destructured-public-builder" },
      });
    }
  }
}

function assignedIdentifiers(expression) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return [current];
  if (
    ts.isBinaryExpression(current) &&
    assignmentOperator(current.operatorToken.kind)
  ) {
    return assignedIdentifiers(current.left);
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : assignedIdentifiers(element),
    );
  }
  if (!ts.isObjectLiteralExpression(current)) return [];
  return current.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return [property.name];
    if (ts.isPropertyAssignment(property)) {
      return assignedIdentifiers(property.initializer);
    }
    return ts.isSpreadAssignment(property)
      ? assignedIdentifiers(property.expression)
      : [];
  });
}

function assignmentOperator(kind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function recordExportAssignments(
  sourceFile,
  exportedTargets,
  declarations,
  adminBindings,
) {
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperator(node.operatorToken.kind)
    ) {
      for (const identifier of assignedIdentifiers(node.left)) {
        const targets = exportedTargets.get(identifier.text) ?? [];
        const isExportedTarget = targets.some((target) =>
          adminBindings.provenance.isUseOf(identifier, target),
        );
        const assignsPublicBuilder =
          containsPublicBuilder(node.right, adminBindings) ||
          containsPublicBuilder(node.left, adminBindings);
        if (!isExportedTarget || !assignsPublicBuilder) {
          continue;
        }
        const existing = declarations.find(
          (declaration) => declaration.name === identifier.text,
        );
        if (existing) existing.immutable = false;
        else {
          declarations.push({
            name: identifier.text,
            call: undefined,
            node,
            immutable: false,
            kind: { visibility: "unknown", name: "assigned-public-builder" },
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Discovers exported registrations, including named and destructured exports. */
export function exportedBuilderDeclarations(sourceFile, values, adminBindings) {
  const exportedNames = collectExportedNames(sourceFile);
  const exportedTargets = new Map();
  const declarations = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      recordVariableStatement({
        statement,
        exportedNames,
        exportedTargets,
        declarations,
        adminBindings,
        values,
      });
    } else if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      !ts.isIdentifier(unwrapExpression(statement.expression))
    ) {
      recordInitializer({
        declarations,
        name: "default",
        initializer: statement.expression,
        node: statement,
        immutable: true,
        adminBindings,
      });
    }
  }
  recordExportAssignments(
    sourceFile,
    exportedTargets,
    declarations,
    adminBindings,
  );
  return declarations;
}
