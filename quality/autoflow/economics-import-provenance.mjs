import ts from "typescript";

import {
  collectUniqueValueDeclarations,
  hasModifier,
  moduleText,
  parseSource,
  staticString,
  unwrapExpression,
} from "./ast-utils.mjs";
import { resolvedModuleSource } from "./economics-module-sources.mjs";
import { moduleHasExecutableEffects } from "./economics-module-stability.mjs";
import { createLexicalBindingProvenance } from "./lexical-binding-provenance.mjs";

function staticMember(expression, values) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    return staticString(current.argumentExpression, values);
  }
  return undefined;
}

function relativeReference(record, specifier, kind, exportName, binding) {
  return specifier?.startsWith(".")
    ? { status: "reference", record, specifier, kind, exportName, binding }
    : undefined;
}

function addNamedImports(bindings, named, record, specifier) {
  if (!named) return;
  if (ts.isNamespaceImport(named)) {
    bindings.set(
      named.name.text,
      relativeReference(record, specifier, "namespace", undefined, named.name),
    );
    return;
  }
  for (const element of named.elements) {
    if (element.isTypeOnly) continue;
    bindings.set(
      element.name.text,
      relativeReference(
        record,
        specifier,
        "export",
        (element.propertyName ?? element.name).text,
        element.name,
      ),
    );
  }
}

function addImportDeclaration(bindings, statement, record) {
  const specifier = moduleText(statement.moduleSpecifier);
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly || !specifier?.startsWith(".")) return;
  if (clause.name) {
    bindings.set(
      clause.name.text,
      relativeReference(record, specifier, "export", "default", clause.name),
    );
  }
  addNamedImports(bindings, clause.namedBindings, record, specifier);
}

function importEqualsSpecifier(statement) {
  if (
    !ts.isImportEqualsDeclaration(statement) ||
    statement.isTypeOnly ||
    !ts.isExternalModuleReference(statement.moduleReference)
  ) {
    return undefined;
  }
  return statement.moduleReference.expression
    ? moduleText(statement.moduleReference.expression)
    : undefined;
}

function importedBindings(record) {
  const bindings = new Map();
  for (const statement of record.sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      addImportDeclaration(bindings, statement, record);
      continue;
    }
    const specifier = importEqualsSpecifier(statement);
    const reference = relativeReference(
      record,
      specifier,
      "namespace",
      undefined,
      statement.name,
    );
    if (reference) bindings.set(statement.name.text, reference);
  }
  return bindings;
}

function assignmentRoot(node) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
    node.operatorToken.kind > ts.SyntaxKind.LastAssignment
  ) {
    return undefined;
  }
  let current = unwrapExpression(node.left);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function reassignedImports(record) {
  const reassigned = new Set();
  const visit = (node) => {
    const root = assignmentRoot(node);
    const binding = root ? record.lexical.bindingOf(root) : undefined;
    if (
      binding &&
      [...record.imports.values()].some((item) => item.binding === binding)
    ) {
      reassigned.add(binding);
    }
    ts.forEachChild(node, visit);
  };
  visit(record.sourceFile);
  return reassigned;
}

function moduleRecord(file, source, state) {
  const cached = state.records.get(file);
  if (cached) return cached;
  const sourceFile = parseSource(source, file);
  const record = {
    file,
    sourceFile,
    values: collectUniqueValueDeclarations(sourceFile),
    lexical: createLexicalBindingProvenance(sourceFile),
  };
  record.imports = importedBindings(record);
  record.reassignedImports = reassignedImports(record);
  state.records.set(file, record);
  return record;
}

function referencedModule(reference, state) {
  const resolved = resolvedModuleSource(
    state.moduleSources,
    reference.record.file,
    reference.specifier,
  );
  return resolved
    ? moduleRecord(resolved.file, resolved.source, state)
    : undefined;
}

function requireReference(expression, record) {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current) || current.arguments.length !== 1) {
    return undefined;
  }
  const callee = unwrapExpression(current.expression);
  if (
    !ts.isIdentifier(callee) ||
    callee.text !== "require" ||
    record.lexical.hasBinding(callee)
  ) {
    return undefined;
  }
  return relativeReference(
    record,
    moduleText(current.arguments[0]),
    "namespace",
  );
}

function identifierReference(identifier, record, state, seen) {
  if (seen.has(identifier.text)) return { status: "unsafe" };
  const declared = record.values.declaredValueAt(identifier.text, identifier);
  if (!declared || declared === identifier) {
    const imported = record.imports.get(identifier.text);
    return imported?.binding &&
      !record.reassignedImports.has(imported.binding) &&
      record.lexical.isUseOf(identifier, imported.binding)
      ? imported
      : imported?.binding &&
          record.lexical.isUseOf(identifier, imported.binding)
        ? { status: "unsafe" }
        : undefined;
  }
  const provenance = expressionReference(
    declared,
    record,
    state,
    new Set([...seen, identifier.text]),
  );
  return provenance && record.values.isInvalidAt(identifier.text, identifier)
    ? { status: "unsafe" }
    : provenance;
}

function memberReference(member, record, state, seen) {
  const object = expressionReference(member.expression, record, state, seen);
  if (!object) return undefined;
  if (object.status === "unsafe") return object;
  const name = staticMember(member, record.values);
  if (object.kind !== "namespace" || name === undefined) {
    return { status: "unsafe" };
  }
  return { ...object, kind: "export", exportName: name };
}

function expressionReference(expression, record, state, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return identifierReference(current, record, state, seen);
  }
  const required = requireReference(current, record);
  if (required) return required;
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return memberReference(current, record, state, seen);
  }
  if (!ts.isConditionalExpression(current)) return undefined;
  const left = expressionReference(current.whenTrue, record, state, seen);
  const right = expressionReference(current.whenFalse, record, state, seen);
  return left || right ? { status: "unsafe" } : undefined;
}

function functionTarget(expression, record, state, seen) {
  const current = unwrapExpression(expression);
  if (
    ts.isFunctionDeclaration(current) ||
    ts.isFunctionExpression(current) ||
    ts.isArrowFunction(current)
  ) {
    return { status: "resolved", record, functionNode: current };
  }
  if (ts.isIdentifier(current)) {
    const localKey = `${record.file}#local:${current.text}`;
    const local = record.values.declaredValueAt(current.text, current);
    if (local && !seen.has(localKey)) {
      if (record.values.isInvalidAt(current.text, current)) {
        return { status: "unsafe" };
      }
      return functionTarget(local, record, state, new Set([...seen, localKey]));
    }
  }
  const reference = expressionReference(current, record, state);
  return reference
    ? resolveReference(reference, state, seen)
    : { status: "unsafe" };
}

function localExport(name, record, state, seen) {
  const value = record.values.declaredValue(name);
  if (!value || record.values.isInvalid(name)) return { status: "unsafe" };
  return functionTarget(value, record, state, seen);
}

function functionExport(statement, exportName, record, state, seen) {
  if (
    !ts.isFunctionDeclaration(statement) ||
    !hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  ) {
    return [];
  }
  const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
  if (isDefault && exportName === "default") {
    return statement.name && record.values.isInvalid(statement.name.text)
      ? [{ status: "unsafe" }]
      : [{ status: "resolved", record, functionNode: statement }];
  }
  if (!isDefault && statement.name?.text === exportName) {
    return [localExport(statement.name.text, record, state, seen)];
  }
  return [];
}

function variableExports(statement, exportName, record, state, seen) {
  if (
    !ts.isVariableStatement(statement) ||
    !hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  ) {
    return [];
  }
  return statement.declarationList.declarations
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === exportName,
    )
    .map((declaration) =>
      localExport(declaration.name.text, record, state, seen),
    );
}

function assignmentExports(statement, exportName, record, state, seen) {
  if (
    !ts.isExportAssignment(statement) ||
    statement.isExportEquals ||
    exportName !== "default"
  ) {
    return [];
  }
  return [functionTarget(statement.expression, record, state, seen)];
}

function namedExportTarget(element, statement, record, state, seen) {
  const localName = (element.propertyName ?? element.name).text;
  const specifier = statement.moduleSpecifier
    ? moduleText(statement.moduleSpecifier)
    : undefined;
  const reference = specifier
    ? relativeReference(record, specifier, "export", localName)
    : undefined;
  return reference
    ? resolveReference(reference, state, seen)
    : localExport(localName, record, state, seen);
}

function namedExports(statement, exportName, record, state, seen) {
  if (
    !ts.isExportDeclaration(statement) ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  ) {
    return [];
  }
  return statement.exportClause.elements
    .filter(
      (element) => !element.isTypeOnly && element.name.text === exportName,
    )
    .map((element) =>
      namedExportTarget(element, statement, record, state, seen),
    );
}

function statementExports(statement, exportName, record, state, seen) {
  return [
    ...functionExport(statement, exportName, record, state, seen),
    ...variableExports(statement, exportName, record, state, seen),
    ...assignmentExports(statement, exportName, record, state, seen),
    ...namedExports(statement, exportName, record, state, seen),
  ];
}

function directExports(exportName, record, state, seen) {
  return record.sourceFile.statements.flatMap((statement) =>
    statementExports(statement, exportName, record, state, seen),
  );
}

function starExports(exportName, record, state, seen) {
  if (exportName === "default") return [];
  return record.sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.exportClause ||
      !statement.moduleSpecifier
    ) {
      return [];
    }
    const reference = relativeReference(
      record,
      moduleText(statement.moduleSpecifier),
      "export",
      exportName,
    );
    return reference ? [resolveReference(reference, state, seen)] : [];
  });
}

function singleTarget(targets) {
  const resolved = targets.filter((target) => target.status === "resolved");
  if (targets.some((target) => target.status === "unsafe")) {
    return { status: "unsafe" };
  }
  return resolved.length === 1
    ? resolved[0]
    : resolved.length > 1
      ? { status: "unsafe" }
      : { status: "absent" };
}

function resolveExport(record, exportName, state, seen) {
  const key = `${record.file}#${exportName}`;
  if (seen.has(key)) return { status: "unsafe" };
  const nextSeen = new Set([...seen, key]);
  const direct = directExports(exportName, record, state, nextSeen);
  const target =
    direct.length > 0
      ? singleTarget(direct)
      : singleTarget(starExports(exportName, record, state, nextSeen));
  return target.status === "resolved" &&
    target.record !== record &&
    moduleHasExecutableEffects(record)
    ? { status: "unsafe" }
    : target;
}

function resolveReference(reference, state, seen = new Set()) {
  if (reference.status === "unsafe" || reference.kind !== "export") {
    return { status: "unsafe" };
  }
  const record = referencedModule(reference, state);
  return record
    ? resolveExport(record, reference.exportName, state, seen)
    : { status: "opaque" };
}

/** Builds stable relative-import and re-export provenance for payload calls. */
export function createImportProvenance({
  sourceFile,
  file,
  values,
  moduleSources,
}) {
  const state = { moduleSources, records: new Map() };
  const root = { file, sourceFile, values };
  root.lexical = createLexicalBindingProvenance(sourceFile);
  root.imports = importedBindings(root);
  root.reassignedImports = reassignedImports(root);
  state.records.set(file, root);
  return {
    root,
    expressionReference(expression, record = root) {
      return expressionReference(expression, record, state);
    },
    resolveReference(reference) {
      return resolveReference(reference, state);
    },
  };
}
