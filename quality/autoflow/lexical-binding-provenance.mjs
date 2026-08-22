import ts from "typescript";

const BINDING_DECLARATION_KINDS = new Set([
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumDeclaration,
]);

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

function nearestAncestor(node, predicate) {
  let current = node.parent;
  while (current && !predicate(current)) current = current.parent;
  return current;
}

function lexicalScope(declaration, sourceFile) {
  if (
    ts.isImportClause(declaration) ||
    ts.isImportSpecifier(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportEqualsDeclaration(declaration)
  ) {
    return sourceFile;
  }
  if (ts.isParameter(declaration)) {
    return nearestAncestor(declaration, ts.isFunctionLike) ?? sourceFile;
  }
  if (ts.isCatchClause(declaration.parent)) return declaration.parent;
  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent;
    const isBlockScoped = Boolean(list.flags & ts.NodeFlags.BlockScoped);
    return isBlockScoped
      ? (nearestAncestor(
          declaration,
          (node) =>
            ts.isBlock(node) ||
            ts.isSourceFile(node) ||
            ts.isCaseBlock(node) ||
            ts.isForStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isForOfStatement(node),
        ) ?? sourceFile)
      : (nearestAncestor(
          declaration,
          (node) => ts.isFunctionLike(node) || ts.isSourceFile(node),
        ) ?? sourceFile);
  }
  if (
    ts.isFunctionExpression(declaration) ||
    ts.isClassExpression(declaration)
  ) {
    return declaration;
  }
  return (
    nearestAncestor(
      declaration,
      (node) =>
        ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseBlock(node),
    ) ?? sourceFile
  );
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function isAmbientDeclaration(node) {
  let current = node;
  while (current && !ts.isSourceFile(current)) {
    if (
      Boolean(current.flags & ts.NodeFlags.Ambient) ||
      hasModifier(current, ts.SyntaxKind.DeclareKeyword)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isTypeOnlyImportBinding(node) {
  if (ts.isImportEqualsDeclaration(node)) return node.isTypeOnly;
  if (ts.isImportClause(node) || ts.isImportSpecifier(node)) {
    if (node.isTypeOnly) return true;
  }
  let current = node.parent;
  while (current && !ts.isImportDeclaration(current)) {
    if (ts.isImportClause(current) && current.isTypeOnly) return true;
    current = current.parent;
  }
  return false;
}

function declarationBindings(node) {
  if (isAmbientDeclaration(node) || isTypeOnlyImportBinding(node)) return [];
  if (!BINDING_DECLARATION_KINDS.has(node.kind) || !node.name) return [];
  return bindingIdentifiers(node.name);
}

function contains(scope, node) {
  let current = node;
  while (current) {
    if (current === scope) return true;
    current = current.parent;
  }
  return false;
}

function depth(node) {
  let result = 0;
  let current = node;
  while (current.parent) {
    result += 1;
    current = current.parent;
  }
  return result;
}

/** Resolves identifier uses to lexical bindings without relying on name equality. */
export function createLexicalBindingProvenance(sourceFile) {
  const bindings = new Map();
  const visit = (node) => {
    for (const identifier of declarationBindings(node)) {
      const record = { identifier, scope: lexicalScope(node, sourceFile) };
      const existing = bindings.get(identifier.text);
      if (existing) existing.push(record);
      else bindings.set(identifier.text, [record]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const bindingsAt = (identifier) =>
    (bindings.get(identifier.text) ?? []).filter((record) =>
      contains(record.scope, identifier),
    );

  const bindingAt = (identifier) => {
    const candidates = bindingsAt(identifier);
    if (candidates.length === 0) return undefined;
    const deepest = Math.max(
      ...candidates.map((record) => depth(record.scope)),
    );
    const nearest = candidates.filter(
      (record) => depth(record.scope) === deepest,
    );
    return nearest.length === 1 ? nearest[0].identifier : undefined;
  };

  return {
    bindingOf(identifier) {
      return ts.isIdentifier(identifier) ? bindingAt(identifier) : undefined;
    },
    hasBinding(identifier) {
      return ts.isIdentifier(identifier) && bindingsAt(identifier).length > 0;
    },
    isUseOf(identifier, target) {
      if (!ts.isIdentifier(identifier) || identifier.text !== target.text)
        return false;
      return bindingAt(identifier) === target;
    },
  };
}
