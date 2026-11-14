// SCRUM-426 (SCRUM-418 section 6) — AST counters for the ratchet guardrails.
// Everything here parses with the TypeScript compiler API (no type checking, no
// regex over source text), so strings, comments, template literals and
// identifiers that merely look like the construct are never counted.
// API: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
import ts from "typescript";

const K = ts.SyntaxKind;

export function parseSource(filePath, text) {
  let scriptKind = ts.ScriptKind.TS;
  if (filePath.endsWith(".tsx")) scriptKind = ts.ScriptKind.TSX;
  else if (filePath.endsWith(".jsx")) scriptKind = ts.ScriptKind.JSX;
  else if (/\.[cm]?js$/u.test(filePath)) scriptKind = ts.ScriptKind.JS;
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, false, scriptKind);
}

export function skipWrappers(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

// ------------------------------------------------------------- type escapes

/** `<unknown>x`, `x as unknown`, parenthesised: the first half of a double cast. */
function isCastToUnknown(expression) {
  const inner = skipWrappers(expression);
  return (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) && inner.type.kind === K.UnknownKeyword;
}

/**
 * The compiler's own record of `// @ts-ignore` and `// @ts-expect-error`: the
 * parser fills `commentDirectives` from exactly the comments it honours (line
 * comments starting with the directive, block comments whose LAST line starts
 * with it), JSX and template literals included. It is not in the public typings,
 * so a probe proves it still works and the checker refuses to run otherwise.
 */
let directivesVerified = false;
function verifyDirectiveSupport() {
  if (directivesVerified) return;
  const probe = parseSource("probe.ts", "// @ts-ignore\nconst a = 1;\n// @ts-expect-error\nconst b = 2;\n");
  const types = (probe.commentDirectives ?? []).map((d) => d.type);
  if (types.length !== 2 || types[0] !== ts.CommentDirectiveType.Ignore || types[1] !== ts.CommentDirectiveType.ExpectError) {
    throw new Error("RATCHET-UNAVAILABLE: this TypeScript version does not expose commentDirectives; update astCounts.mjs.");
  }
  directivesVerified = true;
}

/** @returns {{ any: number, "as-unknown-as": number, "ts-ignore": number, "ts-expect-error": number }} */
export function countTypeEscapes(sourceFile) {
  verifyDirectiveSupport();
  const counts = { any: 0, "as-unknown-as": 0, "ts-ignore": 0, "ts-expect-error": 0 };
  const visit = (node) => {
    if (node.kind === K.AnyKeyword) counts.any += 1;
    else if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && isCastToUnknown(node.expression)) {
      counts["as-unknown-as"] += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const directive of sourceFile.commentDirectives ?? []) {
    if (directive.type === ts.CommentDirectiveType.Ignore) counts["ts-ignore"] += 1;
    else counts["ts-expect-error"] += 1;
  }
  return counts;
}

// ------------------------------------------------------------ bounded reads

// Query methods that return another query, so the receiver is still a query.
// Anything else (collect, take, first, unique, paginate, then, ...) yields data.
const QUERY_CONTINUATIONS = new Set(["withIndex", "withSearchIndex", "order", "filter"]);

/** `x.db.query(...)` or `db.query(...)`: the root of a Convex database query. */
function isDbQueryCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const callee = node.expression;
  if (callee.name.text !== "query") return false;
  const owner = skipWrappers(callee.expression);
  return (ts.isPropertyAccessExpression(owner) && owner.name.text === "db") || (ts.isIdentifier(owner) && owner.text === "db");
}

function isQueryChain(node, aliases) {
  const current = skipWrappers(node);
  if (ts.isIdentifier(current)) return aliases.has(current.text);
  if (isDbQueryCall(current)) return true;
  if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    return QUERY_CONTINUATIONS.has(current.expression.name.text) && isQueryChain(current.expression.expression, aliases);
  }
  return false;
}

/** Variables initialised with a query chain, followed through `const r = q.order(...)`. */
function queryAliases(sourceFile) {
  const declarations = [];
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  const aliases = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const declaration of declarations) {
      const name = declaration.name.text;
      if (!aliases.has(name) && isQueryChain(declaration.initializer, aliases)) {
        aliases.add(name);
        grew = true;
      }
    }
  }
  return aliases;
}

/** `.filter((q) => q.eq(q.field("a"), 1))`: the callback is Convex's filter builder. */
function usesFilterBuilder(call) {
  const callback = call.arguments[0];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return false;
  const first = callback.parameters[0];
  if (!first || !ts.isIdentifier(first.name)) return false;
  const builder = first.name.text;
  let found = false;
  const search = (node) => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "field" && ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === builder) {
      found = true;
      return;
    }
    ts.forEachChild(node, search);
  };
  search(callback.body);
  return found;
}

/**
 * Guardrail 10. `.collect()` is Convex-only (no array method of that name), so
 * every zero-argument call counts. `.filter(` counts only on a database query:
 * rooted at `<x>.db.query(` directly or through a variable, or taking Convex's
 * filter-builder callback (a query passed in as a parameter). An array filter is
 * not a violation.
 * @returns {{ "query-collect": number, "query-filter": number }}
 */
export function countQueryReads(sourceFile) {
  const aliases = queryAliases(sourceFile);
  const counts = { "query-collect": 0, "query-filter": 0 };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === "collect" && node.arguments.length === 0) counts["query-collect"] += 1;
      if (method === "filter" && (isQueryChain(node.expression.expression, aliases) || usesFilterBuilder(node))) {
        counts["query-filter"] += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return counts;
}
