import ts from "typescript";

export const RULE_IDS = Object.freeze({
  ADMIN_SUPER_ADMIN_FIRST: "admin-super-admin-first",
  ECONOMICS_REVISION: "economics-revision",
  RAW_CONVEX_MUTATION_BUILDER: "raw-convex-mutation-builder",
  AGGREGATE_REGISTRATION: "aggregate-registration",
});

export function normalizePath(filePath) {
  return String(filePath).replaceAll("\\", "/");
}

function scriptKindFor(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (
    filePath.endsWith(".js") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

export function parseSource(source, filePath) {
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
}

export function diagnostic({ sourceFile, file, node, ruleId, message }) {
  const start = node.getStart(sourceFile, false);
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    ruleId,
    file: normalizePath(file),
    line: position.line + 1,
    column: position.character + 1,
    message,
  };
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortDiagnostics(diagnostics) {
  return diagnostics.sort(
    (left, right) =>
      compareText(left.file, right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      compareText(left.ruleId, right.ruleId) ||
      compareText(left.message, right.message),
  );
}

export function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

export function unwrapAwait(node) {
  let current = unwrapExpression(node);
  while (current && ts.isAwaitExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return current;
}

function literalString(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function identifierString(node, valueDeclarations, seen) {
  if (!ts.isIdentifier(node) || !valueDeclarations || seen.has(node.text)) {
    return undefined;
  }
  const resolved = valueDeclarations.resolveAt(node.text, node);
  if (!resolved || resolved === node) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(node.text);
  return staticString(resolved, valueDeclarations, nextSeen);
}

function concatenatedString(node, valueDeclarations, seen) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.PlusToken
  ) {
    return undefined;
  }
  const left = staticString(node.left, valueDeclarations, new Set(seen));
  const right = staticString(node.right, valueDeclarations, new Set(seen));
  return left === undefined || right === undefined ? undefined : left + right;
}

function interpolatedString(node, valueDeclarations, seen) {
  if (!ts.isTemplateExpression(node)) return undefined;
  let folded = node.head.text;
  for (const span of node.templateSpans) {
    const value = staticString(
      span.expression,
      valueDeclarations,
      new Set(seen),
    );
    if (value === undefined) return undefined;
    folded += value + span.literal.text;
  }
  return folded;
}

export function staticString(expression, valueDeclarations, seen = new Set()) {
  const current = unwrapExpression(expression);
  return (
    literalString(current) ??
    identifierString(current, valueDeclarations, seen) ??
    concatenatedString(current, valueDeclarations, seen) ??
    interpolatedString(current, valueDeclarations, seen)
  );
}

export function propertyNameText(name, valueDeclarations) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return staticString(name.expression, valueDeclarations);
  }
  return undefined;
}

export function memberName(expression) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current)) {
    const argument = current.argumentExpression
      ? unwrapExpression(current.argumentExpression)
      : undefined;
    if (
      argument &&
      (ts.isStringLiteral(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      return argument.text;
    }
  }
  return undefined;
}

export function memberObject(expression) {
  const current = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return unwrapExpression(current.expression);
  }
  return undefined;
}

export function identifierName(expression) {
  const current = unwrapExpression(expression);
  return ts.isIdentifier(current) ? current.text : undefined;
}

export function moduleText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

export function withoutModuleExtension(specifier) {
  return specifier.replaceAll("\\", "/").replace(/\.(?:js|ts|mjs|cjs)$/, "");
}

export function isGeneratedServerModule(specifier) {
  return /(?:^|\/)\_generated\/server$/.test(withoutModuleExtension(specifier));
}

export function isFunctionsModule(specifier) {
  return /(?:^|\/)functions$/.test(withoutModuleExtension(specifier));
}

export function isTenancyModule(specifier) {
  return /(?:^|\/)utils\/tenancy$/.test(withoutModuleExtension(specifier));
}

export function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function addExportedVariables(statement, names) {
  if (
    !ts.isVariableStatement(statement) ||
    !hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  ) {
    return false;
  }
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
  }
  return true;
}

function addExportedFunction(statement, names) {
  if (
    !ts.isFunctionDeclaration(statement) ||
    !statement.name ||
    !hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  ) {
    return false;
  }
  names.add(statement.name.text);
  return true;
}

function addNamedExports(statement, names) {
  if (
    !ts.isExportDeclaration(statement) ||
    statement.moduleSpecifier ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  ) {
    return false;
  }
  for (const element of statement.exportClause.elements) {
    names.add((element.propertyName ?? element.name).text);
  }
  return true;
}

function addDefaultExportName(statement, names) {
  if (!ts.isExportAssignment(statement) || statement.isExportEquals) return;
  const expression = unwrapExpression(statement.expression);
  if (ts.isIdentifier(expression)) names.add(expression.text);
}

export function collectExportedNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (addExportedVariables(statement, names)) continue;
    if (addExportedFunction(statement, names)) continue;
    if (addNamedExports(statement, names)) continue;
    addDefaultExportName(statement, names);
  }
  return names;
}

function bindingScope(declaration, sourceFile) {
  let current = declaration.parent;
  while (current && !ts.isBlock(current) && !ts.isSourceFile(current)) {
    current = current.parent;
  }
  return current ?? sourceFile;
}

function addValueDeclaration(state, name, value, declaration) {
  const record = {
    value,
    declaration,
    scope: bindingScope(declaration, state.sourceFile),
    invalid: false,
  };
  const existing = state.declarations.get(name);
  if (existing) existing.push(record);
  else state.declarations.set(name, [record]);
  return record;
}

function rootIdentifier(expression) {
  let current = unwrapExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function isAssignmentOperator(kind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function recordConstDeclaration(node, state) {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    !node.initializer ||
    !ts.isVariableDeclarationList(node.parent) ||
    !ts.isVarConst(node)
  ) {
    return false;
  }
  const record = addValueDeclaration(
    state,
    node.name.text,
    node.initializer,
    node,
  );
  const initializer = unwrapExpression(node.initializer);
  if (ts.isIdentifier(initializer)) state.aliases.push([record, initializer]);
  return true;
}

function recordFunctionDeclaration(node, state) {
  if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) return false;
  addValueDeclaration(state, node.name.text, node, node);
  return true;
}

function recordAssignmentWrite(node, state) {
  if (
    !ts.isBinaryExpression(node) ||
    !isAssignmentOperator(node.operatorToken.kind)
  ) {
    return false;
  }
  state.pendingWrites.push(rootIdentifier(node.left));
  return true;
}

function recordUnaryWrite(node, state) {
  if (!ts.isPrefixUnaryExpression(node) && !ts.isPostfixUnaryExpression(node)) {
    return false;
  }
  if (
    node.operator !== ts.SyntaxKind.PlusPlusToken &&
    node.operator !== ts.SyntaxKind.MinusMinusToken
  ) {
    return false;
  }
  state.pendingWrites.push(rootIdentifier(node.operand));
  return true;
}

function isMutatingObjectCall(objectName, operation) {
  if (objectName === "Object") {
    return operation === "assign" || operation === "defineProperty";
  }
  if (objectName === "Reflect") {
    return operation === "set" || operation === "deleteProperty";
  }
  return false;
}

function recordCallWrite(node, state) {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrapExpression(node.expression);
  const object = memberObject(callee);
  const objectName =
    object && ts.isIdentifier(object) ? object.text : undefined;
  if (!isMutatingObjectCall(objectName, memberName(callee))) return false;
  if (node.arguments[0]) {
    state.pendingWrites.push(rootIdentifier(node.arguments[0]));
  }
  return true;
}

function recordValueNode(node, state) {
  if (recordConstDeclaration(node, state)) return;
  if (recordFunctionDeclaration(node, state)) return;
  if (recordAssignmentWrite(node, state)) return;
  if (recordUnaryWrite(node, state)) return;
  if (ts.isDeleteExpression(node)) {
    state.pendingWrites.push(rootIdentifier(node.expression));
    return;
  }
  recordCallWrite(node, state);
}

function collectValueDeclarationState(sourceFile) {
  const state = {
    sourceFile,
    declarations: new Map(),
    pendingWrites: [],
    aliases: [],
  };
  const visit = (node) => {
    recordValueNode(node, state);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return state;
}

function isWithinScope(scope, node) {
  let current = node;
  while (current) {
    if (current === scope) return true;
    current = current.parent;
  }
  return false;
}

function scopeDepth(scope) {
  let depth = 0;
  let current = scope;
  while (current.parent) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

function isRecordVisible(record, node, includeInvalid) {
  if (!isWithinScope(record.scope, node)) return false;
  const declaredBeforeUse =
    ts.isFunctionDeclaration(record.declaration) ||
    record.declaration.pos <= node.pos;
  return declaredBeforeUse && (includeInvalid || !record.invalid);
}

function recordAt(declarations, name, node, includeInvalid = false) {
  const records = (declarations.get(name) ?? []).filter((record) =>
    isRecordVisible(record, node, includeInvalid),
  );
  if (records.length === 0) return undefined;
  const deepest = Math.max(
    ...records.map((record) => scopeDepth(record.scope)),
  );
  const nearest = records.filter(
    (record) => scopeDepth(record.scope) === deepest,
  );
  return nearest.length === 1 ? nearest[0] : undefined;
}

function applyPendingWrites(state) {
  for (const written of state.pendingWrites) {
    if (!written) continue;
    const record = recordAt(state.declarations, written.text, written, true);
    if (record) record.invalid = true;
  }
}

function synchronizeAliasInvalidity(left, right) {
  if (left.invalid === right.invalid) return false;
  left.invalid = true;
  right.invalid = true;
  return true;
}

function propagateInvalidAliases(state) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, rightNode] of state.aliases) {
      const right = recordAt(
        state.declarations,
        rightNode.text,
        rightNode,
        true,
      );
      if (right && synchronizeAliasInvalidity(left, right)) changed = true;
    }
  }
}

function singleRecord(declarations, name) {
  const records = declarations.get(name);
  return records?.length === 1 ? records[0] : undefined;
}

function valueDeclarationApi(declarations) {
  return {
    declaredValue(name) {
      return singleRecord(declarations, name)?.value;
    },
    declaredValueAt(name, node) {
      return recordAt(declarations, name, node, true)?.value;
    },
    isInvalid(name) {
      return Boolean(singleRecord(declarations, name)?.invalid);
    },
    isInvalidAt(name, node) {
      return Boolean(recordAt(declarations, name, node, true)?.invalid);
    },
    resolve(name) {
      const record = singleRecord(declarations, name);
      return record && !record.invalid ? record.value : undefined;
    },
    resolveAt(name, node) {
      return recordAt(declarations, name, node)?.value;
    },
  };
}

export function collectUniqueValueDeclarations(sourceFile) {
  const state = collectValueDeclarationState(sourceFile);
  applyPendingWrites(state);
  propagateInvalidAliases(state);
  return valueDeclarationApi(state.declarations);
}

export function resolveValue(expression, values, seen = new Set()) {
  let current = unwrapExpression(expression);
  const visited = new Set(seen);
  while (ts.isIdentifier(current) && !visited.has(current.text)) {
    visited.add(current.text);
    const resolved = values.resolveAt(current.text, current);
    if (!resolved) break;
    current = unwrapExpression(resolved);
  }
  return current;
}
