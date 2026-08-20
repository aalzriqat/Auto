import ts from "typescript";

import {
  identifierName,
  memberObject,
  moduleText,
  propertyNameText,
  staticString,
  unwrapExpression,
} from "./ast-utils.mjs";

export function declarationIsConst(node) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    Boolean(node.parent.flags & ts.NodeFlags.Const)
  );
}

export function staticMemberName(expression, values) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    return staticString(current.argumentExpression, values);
  }
  return undefined;
}

function addBinding(set, name) {
  if (set.has(name)) return false;
  set.add(name);
  return true;
}

function propagateIdentifierAlias(node, initializer, bindings, values) {
  if (
    !ts.isIdentifier(node.name) ||
    !ts.isIdentifier(initializer) ||
    values.resolveAt(node.name.text, node.name) !== node.initializer
  ) {
    return false;
  }
  let changed = false;
  if (bindings.direct.has(initializer.text)) {
    changed = addBinding(bindings.direct, node.name.text) || changed;
  }
  if (bindings.namespaces.has(initializer.text)) {
    changed = addBinding(bindings.namespaces, node.name.text) || changed;
  }
  return changed;
}

function propagateNamespaceMember(node, initializer, bindings, values) {
  if (
    !ts.isIdentifier(node.name) ||
    staticMemberName(initializer, values) !== "TableAggregate" ||
    !bindings.namespaces.has(identifierName(memberObject(initializer)))
  ) {
    return false;
  }
  return addBinding(bindings.direct, node.name.text);
}

function propagateDestructuring(node, initializer, bindings, values) {
  if (
    !ts.isObjectBindingPattern(node.name) ||
    !ts.isIdentifier(initializer) ||
    !bindings.namespaces.has(initializer.text)
  ) {
    return false;
  }
  let changed = false;
  for (const element of node.name.elements) {
    const importsConstructor =
      !element.dotDotDotToken &&
      propertyNameText(element.propertyName ?? element.name, values) ===
        "TableAggregate" &&
      ts.isIdentifier(element.name);
    if (importsConstructor) {
      changed = addBinding(bindings.direct, element.name.text) || changed;
    }
  }
  return changed;
}

function propagateImmutableDeclaration(node, bindings, values) {
  if (!declarationIsConst(node) || !node.initializer) return false;
  const initializer = unwrapExpression(node.initializer);
  return (
    propagateIdentifierAlias(node, initializer, bindings, values) ||
    propagateNamespaceMember(node, initializer, bindings, values) ||
    propagateDestructuring(node, initializer, bindings, values)
  );
}

function propagateImmutableAliases(sourceFile, bindings, values) {
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      changed =
        propagateImmutableDeclaration(node, bindings, values) || changed;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function aggregateImportClause(statement) {
  if (!ts.isImportDeclaration(statement)) return undefined;
  if (moduleText(statement.moduleSpecifier) !== "@convex-dev/aggregate") {
    return undefined;
  }
  const clause = statement.importClause;
  return clause && !clause.isTypeOnly ? clause : undefined;
}

function addNamedAggregateImports(namedBindings, direct) {
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return;
  for (const element of namedBindings.elements) {
    const importedName = (element.propertyName ?? element.name).text;
    if (!element.isTypeOnly && importedName === "TableAggregate") {
      direct.add(element.name.text);
    }
  }
}

function addPackageImport(statement, direct, namespaces) {
  const clause = aggregateImportClause(statement);
  if (!clause?.namedBindings) return;
  if (ts.isNamespaceImport(clause.namedBindings)) {
    namespaces.add(clause.namedBindings.name.text);
    return;
  }
  addNamedAggregateImports(clause.namedBindings, direct);
}

function importedBindings(sourceFile, options) {
  const direct = new Set(options.constructorImports ?? []);
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    addPackageImport(statement, direct, namespaces);
  }
  return {
    direct,
    namespaces,
    reexportNamespaces: options.constructorNamespaces ?? new Map(),
    unsafe: new Set(),
  };
}

function directNamespaceMember(expression, bindings, values) {
  const object = memberObject(expression);
  if (!object || !ts.isIdentifier(object)) return false;
  const name = staticMemberName(expression, values);
  return (
    (name === "TableAggregate" && bindings.namespaces.has(object.text)) ||
    bindings.reexportNamespaces.get(object.text)?.has(name) === true
  );
}

function immutableObjectMember(expression, bindings, values) {
  const current = unwrapExpression(expression);
  if (
    !ts.isPropertyAccessExpression(current) &&
    !ts.isElementAccessExpression(current)
  ) {
    return undefined;
  }
  const object = unwrapExpression(current.expression);
  if (!ts.isIdentifier(object)) return undefined;
  const initializer = values.resolveAt(object.text, object);
  if (
    !initializer ||
    !ts.isObjectLiteralExpression(unwrapExpression(initializer))
  ) {
    return undefined;
  }
  const name = staticMemberName(current, values);
  const property = unwrapExpression(initializer).properties.find(
    (candidate) =>
      (ts.isPropertyAssignment(candidate) ||
        ts.isShorthandPropertyAssignment(candidate)) &&
      propertyNameText(candidate.name, values) === name,
  );
  const memberValue =
    property && ts.isPropertyAssignment(property)
      ? property.initializer
      : property && ts.isShorthandPropertyAssignment(property)
        ? property.name
        : undefined;
  return memberValue
    ? expressionProvenance(memberValue, bindings, values)
    : undefined;
}

function expressionProvenance(expression, bindings, values) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    if (bindings.unsafe.has(current.text)) return "unsafe";
    if (bindings.direct.has(current.text)) return "direct";
    return undefined;
  }
  if (directNamespaceMember(current, bindings, values)) return "direct";
  const contained = immutableObjectMember(current, bindings, values);
  if (contained) return contained;
  if (ts.isConditionalExpression(current)) {
    return expressionProvenance(current.whenTrue, bindings, values) ||
      expressionProvenance(current.whenFalse, bindings, values)
      ? "unsafe"
      : undefined;
  }
  if (ts.isBinaryExpression(current)) {
    return expressionProvenance(current.left, bindings, values) ||
      expressionProvenance(current.right, bindings, values)
      ? "unsafe"
      : undefined;
  }
  return undefined;
}

function immutableDirectAlias(node, initializer, bindings, values) {
  if (!declarationIsConst(node) || !ts.isIdentifier(node.name)) return false;
  if (values.resolveAt(node.name.text, node.name) !== node.initializer)
    return false;
  if (ts.isIdentifier(initializer))
    return bindings.direct.has(initializer.text);
  return directNamespaceMember(initializer, bindings, values);
}

function propagateUnsafeDeclaration(node, bindings, values) {
  if (!ts.isVariableDeclaration(node) || !node.initializer) return false;
  const initializer = unwrapExpression(node.initializer);
  const provenance = expressionProvenance(initializer, bindings, values);
  if (!provenance || !ts.isIdentifier(node.name)) return false;
  if (immutableDirectAlias(node, initializer, bindings, values)) return false;
  bindings.direct.delete(node.name.text);
  return addBinding(bindings.unsafe, node.name.text);
}

function propagateUnsafeSubclass(node, bindings, values) {
  if (!ts.isClassDeclaration(node) || !node.name) return false;
  const heritage = node.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  )?.types[0]?.expression;
  if (!heritage || !expressionProvenance(heritage, bindings, values))
    return false;
  return addBinding(bindings.unsafe, node.name.text);
}

function propagateUnsafeConstructors(sourceFile, bindings, values) {
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      changed = propagateUnsafeDeclaration(node, bindings, values) || changed;
      changed = propagateUnsafeSubclass(node, bindings, values) || changed;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function constructorBindings(sourceFile, values, options) {
  const bindings = importedBindings(sourceFile, options);
  propagateImmutableAliases(sourceFile, bindings, values);
  propagateUnsafeConstructors(sourceFile, bindings, values);
  return bindings;
}

function typeAliases(sourceFile) {
  const aliases = new Map();
  const visit = (node) => {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function literalStringFromType(node, aliases, seen) {
  if (ts.isParenthesizedTypeNode(node)) {
    return literalStringFromType(node.type, aliases, seen);
  }
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return node.literal.text;
  }
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) {
    return undefined;
  }
  if (seen.has(node.typeName.text)) return undefined;
  const alias = aliases.get(node.typeName.text);
  return alias
    ? literalStringFromType(
        alias,
        aliases,
        new Set([...seen, node.typeName.text]),
      )
    : undefined;
}

function tableNameFromType(node, aliases, seen = new Set()) {
  if (ts.isParenthesizedTypeNode(node)) {
    return tableNameFromType(node.type, aliases, seen);
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    if (seen.has(node.typeName.text)) return undefined;
    const alias = aliases.get(node.typeName.text);
    return alias
      ? tableNameFromType(
          alias,
          aliases,
          new Set([...seen, node.typeName.text]),
        )
      : undefined;
  }
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      if (
        ts.isPropertySignature(member) &&
        propertyNameText(member.name) === "TableName" &&
        member.type
      ) {
        return literalStringFromType(member.type, aliases, seen);
      }
    }
  }
  if (ts.isIntersectionTypeNode(node)) {
    const names = new Set(
      node.types
        .map((type) => tableNameFromType(type, aliases, seen))
        .filter(Boolean),
    );
    return names.size === 1 ? [...names][0] : undefined;
  }
  return undefined;
}

function supportedInstanceDeclaration(node) {
  let current = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  const declaration = current.parent;
  return declarationIsConst(declaration) &&
    ts.isIdentifier(declaration.name) &&
    unwrapExpression(declaration.initializer) === node
    ? declaration
    : undefined;
}

/** Finds direct aggregate instances and constructor flows that cannot be proven safe. */
export function findAggregateInstances(sourceFile, values, options = {}) {
  const bindings = constructorBindings(sourceFile, values, options);
  const aliases = typeAliases(sourceFile);
  const supported = [];
  const unsupported = [];
  const visit = (node) => {
    if (ts.isNewExpression(node)) {
      const provenance = expressionProvenance(
        node.expression,
        bindings,
        values,
      );
      if (provenance === "unsafe") {
        unsupported.push({
          node,
          message:
            "TableAggregate constructors must use a direct immutable package-proven binding; mutable, conditional, or subclass aliases cannot be verified.",
        });
      } else if (provenance === "direct") {
        const declaration = supportedInstanceDeclaration(node);
        if (!declaration) {
          unsupported.push({
            node,
            message:
              "TableAggregate instances must be assigned directly to a named const so their trigger registration can be proven.",
          });
        } else {
          const table = node.typeArguments
            ?.map((type) => tableNameFromType(type, aliases))
            .find(Boolean);
          supported.push({
            name: declaration.name.text,
            table,
            node: declaration,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { supported, unsupported };
}
