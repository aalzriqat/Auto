import ts from "typescript";
import { parseModule, staticStringOf } from "./commitmentWriteGuard";

export interface ReceivableWriterScan {
  /** Writer sites seen, including unparsed ones (definitions and type positions excluded). */
  sites: number;
  /** sourceType kinds resolved to a string literal. */
  literals: string[];
  /** Call sites whose sourceType could not be resolved, as `reason: snippet`. */
  unparsed: string[];
}

const snippet = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 100);

/**
 * Parsed with the TypeScript compiler API, like commitmentWriteGuard (SCRUM-208).
 * The previous text scanner was forged five ways (a table held in a const, a
 * space before the paren, an import alias, a `//` inside a string, an inner-scope
 * shadow of a const), then five more ways through indirect calls. What fails
 * closed, exactly: (1) a recognised call whose table, args object or `sourceType`
 * cannot be read statically; (2) any value-position occurrence of a watched name
 * (`insert`, the helpers, `createReceivable`) outside the recognised direct
 * positions listed on `indirectUse`: element access, `.call`/`.apply`,
 * destructuring, a stored reference, a parenthesised callee; (3) a watched
 * function rebound under another name by an import alias or an export specifier
 * (one hop: the alias's value uses, and `export { x as y }` / `export { alias }`).
 * NOT covered: a computed non-literal element-access key, `export *`, writes that
 * never name a watched name (including `patch` / `replace`), string-addressed
 * function references (e.g. makeFunctionReference("subledger:createReceivable")),
 * and cross-file symbol resolution beyond that one-hop alias-and-export rule.
 * Identity is the import binding, not the spelling. Identifier resolution is deliberately NOT
 * heuristic (the SCRUM-208 lesson, "a number cannot be shadowed"): a name resolves
 * only when the file declares it exactly once, anywhere, as a top-level
 * `const NAME = "literal"`.
 */
const RECEIVABLE_HELPERS: ReadonlySet<string> = new Set(["createReceivableDocument", "ensureReceivableDocument"]);
/** Names that, passed as a function reference, enqueue a receivableDocuments write. */
const RECEIVABLE_MUTATION_REFS: ReadonlySet<string> = new Set([...RECEIVABLE_HELPERS, "createReceivable"]);

/** Peel `( )`, `as T`, `<T>x`, `x satisfies T` and `x!`: none changes the value. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

/** Every binding of each name in the file, at any scope, including imports, parameters and patterns. */
function declarationsByName(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const out = new Map<string, ts.Node[]>();
  const add = (name: ts.Node | undefined, decl: ts.Node) => {
    if (name && ts.isIdentifier(name)) out.set(name.text, [...(out.get(name.text) ?? []), decl]);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      add(node.name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The literal a name is bound to, or null. Resolves ONLY a sole, top-level `const NAME = "..."`. */
function resolveConstString(name: string, decls: Map<string, ts.Node[]>): string | null {
  const all = decls.get(name) ?? [];
  if (all.length !== 1) return null;
  const decl = all[0];
  if (!ts.isVariableDeclaration(decl) || !decl.initializer) return null;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;
  if (!ts.isVariableStatement(list.parent) || !ts.isSourceFile(list.parent.parent)) return null;
  return staticStringOf(unwrap(decl.initializer));
}

/** True when `node` sits inside a type annotation, where `typeof helper` is not a call. */
const inTypePosition = (node: ts.Node): boolean => {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (ts.isTypeNode(p)) return true;
  return false;
};

type SourceTypeVerdict = { kind: string } | { reason: string };

function sourceTypeOf(arg: ts.Expression | undefined, decls: Map<string, ts.Node[]>): SourceTypeVerdict {
  if (!arg) return { reason: "no inline object argument: (missing)" };
  const obj = unwrap(arg);
  if (!ts.isObjectLiteralExpression(obj)) {
    return { reason: `no inline object argument: ${snippet(arg.getText())}` };
  }
  if (obj.properties.some((p) => ts.isSpreadAssignment(p))) {
    return { reason: `spread args: ${snippet(obj.getText())}` };
  }
  // A computed key could spell sourceType at runtime; refuse rather than guess.
  if (obj.properties.some((p) => p.name && ts.isComputedPropertyName(p.name))) {
    return { reason: `computed key: ${snippet(obj.getText())}` };
  }
  const named = obj.properties.filter(
    (p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "sourceType"
  );
  if (named.length === 0) return { reason: `no sourceType key: ${snippet(obj.getText())}` };
  if (named.length > 1) return { reason: `duplicate sourceType: ${snippet(obj.getText())}` };
  const prop = named[0];
  if (!ts.isPropertyAssignment(prop)) return { reason: `shorthand or method sourceType: ${snippet(prop.getText())}` };
  const value = unwrap(prop.initializer);
  const literal = staticStringOf(value);
  if (literal !== null) return { kind: literal };
  if (ts.isIdentifier(value)) {
    const resolved = resolveConstString(value.text, decls);
    if (resolved !== null) return { kind: resolved };
  }
  return { reason: `unresolved sourceType: ${snippet(value.getText())}` };
}

/**
 * Inspects EVERY receivableDocuments write in one file. A call is a SITE when it
 * is: a `.insert(` (any receiver, so a `db = ctx.db` alias counts) whose table is
 * "receivableDocuments" OR is not a string literal (unresolved, so unparsed); a
 * call of a helper import-bound to `createReceivableDocument` /
 * `ensureReceivableDocument` under any local name, or as a namespace member; or a
 * call passing a function reference named after a helper or `createReceivable`
 * (the `runMutation` form). A helper alias is a recognised callee; a
 * `createReceivable` alias (whatever its spelling), any value use of it, a helper
 * that escapes as a bare value, or a re-export under another name is reported as
 * unparsed (one hop only). Not covered: see the boundary list above (`export *`,
 * computed keys, patch/replace, string-addressed references, cross-file
 * resolution). Definitions, imports, type positions and comments are not sites.
 * Each site's `sourceType` must resolve to a literal or it is reported.
 */
export function scanReceivableDocumentWriters(rawText: string, file = "scanned.ts"): ReceivableWriterScan {
  const sf = parseModule(rawText, file);
  const decls = declarationsByName(sf);
  // Identity is the IMPORT BINDING, not the spelling. `importedFrom` maps each local name
  // bound by a named import of a watched function to the original name it imports. A
  // helper binding is a recognised callee; a `createReceivable` binding is only watched
  // (`refAliases`), even when it is spelled like a helper, so any use of it is unparsed.
  // The reverse (a helper imported as `createReceivable`) is a helper binding and is
  // recorded as such; its same-name export is caught by the export rule below.
  const aliases = new Set<string>(RECEIVABLE_HELPERS);
  const refAliases = new Set<string>();
  const importedFrom = new Map<string, string>();
  sf.forEachChild(function findImports(node) {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      const local = el.name.text;
      if (!RECEIVABLE_MUTATION_REFS.has(imported)) continue;
      importedFrom.set(local, imported);
      if (RECEIVABLE_HELPERS.has(imported)) {
        aliases.add(local);
        refAliases.delete(local);
      } else {
        refAliases.add(local);
        aliases.delete(local);
      }
    }
  });
  const tracked = (name: string) => RECEIVABLE_MUTATION_REFS.has(name) || aliases.has(name) || refAliases.has(name);

  const literals = new Set<string>();
  const unparsed: string[] = [];
  let sites = 0;
  const record = (verdict: SourceTypeVerdict) => {
    sites++;
    if ("kind" in verdict) literals.add(verdict.kind);
    else unparsed.push(verdict.reason);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !inTypePosition(node)) {
      const callee = node.expression;
      const args = node.arguments;
      const refAt = args.findIndex((a) => {
        const e = unwrap(a);
        return ts.isPropertyAccessExpression(e) && RECEIVABLE_MUTATION_REFS.has(e.name.text);
      });
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "insert") {
        const table = staticStringOf(args[0]);
        if (table === "receivableDocuments") record(sourceTypeOf(args[1], decls));
        else if (table === null) {
          sites++;
          unparsed.push(
            `insert with an unresolvable table: counted as a possible receivableDocuments writer: ${snippet(args[0] ? args[0].getText() : "(missing)")}`
          );
        }
      } else if (ts.isIdentifier(callee) && aliases.has(callee.text)) {
        record(sourceTypeOf(args[1], decls));
      } else if (ts.isPropertyAccessExpression(callee) && RECEIVABLE_HELPERS.has(callee.name.text)) {
        record(sourceTypeOf(args[1], decls));
      } else if (refAt >= 0) {
        record(sourceTypeOf(args[refAt + 1], decls));
      }
    } else if (ts.isExportSpecifier(node)) {
      // One site per specifier: it fires when a tracked name is exported under any name other
      // than the ORIGINAL it is bound to (the import's original name, else its own spelling).
      const local = (node.propertyName ?? node.name).text;
      const original = importedFrom.get(local) ?? local;
      if (tracked(local) && node.name.text !== original) {
        sites++;
        unparsed.push(`re-export under a new name: ${snippet(node.getText())}`);
      }
    }
    // Name-keyed escape check, independent of the call shape above: EVERY value-position
    // occurrence of a watched name must sit in a recognised direct position or it is a site.
    let escape: string | null = null;
    if (ts.isIdentifier(node)) escape = indirectUse(node, aliases, refAliases);
    else if (ts.isElementAccessExpression(node) && !inTypePosition(node)) {
      const key = staticStringOf(node.argumentExpression);
      if (key !== null && WATCHED_NAMES.has(key)) escape = `indirect use of ${key}: ${snippet(node.getText())}`;
    }
    if (escape !== null) {
      sites++;
      unparsed.push(escape);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sites, literals: [...literals].sort(), unparsed: unparsed.sort() };
}

/** `insert`, the helpers and the function-reference names: the only names that can write the table. */
const WATCHED_NAMES: ReadonlySet<string> = new Set(["insert", ...RECEIVABLE_MUTATION_REFS]);

/** Object/class member names are keys, not references. */
const isKeyPosition = (p: ts.Node, id: ts.Identifier): boolean =>
  (ts.isPropertyAssignment(p) ||
    ts.isPropertySignature(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isMethodSignature(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isEnumMember(p)) &&
  p.name === id;

/**
 * The reason string when this identifier is a watched name used in a value position
 * that is NOT one of the recognised direct positions, else null. Recognised:
 * (a) the member name of a property access that is directly the callee (insert and
 * the helpers); (b) an identifier callee that is a helper or import alias; (c) the
 * member name of a property access passed directly as an argument (the function-
 * reference form); (d) a function or variable declaration's own name; plus imports,
 * exports (renames are reported separately), object keys and type positions.
 * Destructuring, shorthand properties, element access and every other shape fail closed.
 */
function indirectUse(
  id: ts.Identifier,
  aliases: ReadonlySet<string>,
  refAliases: ReadonlySet<string>
): string | null {
  const name = id.text;
  const base = WATCHED_NAMES.has(name);
  if (!base && !aliases.has(name) && !refAliases.has(name)) return null;
  if (inTypePosition(id)) return null;
  const p = id.parent;
  const bad = (n: ts.Node) => `indirect use of ${name}: ${snippet(n.getText())}`;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return null;
  if (ts.isBindingElement(p)) {
    for (let a: ts.Node | undefined = p; a; a = a.parent) {
      if (ts.isVariableDeclaration(a) || ts.isParameter(a)) return bad(a);
    }
    return bad(p);
  }
  if (ts.isShorthandPropertyAssignment(p)) return bad(p);
  if (ts.isPropertyAccessExpression(p) && p.name === id) {
    if (!base) return null; // an alias-only name as someone else's member
    const g = p.parent;
    if (ts.isCallExpression(g) && g.expression === p && (name === "insert" || RECEIVABLE_HELPERS.has(name))) return null;
    if (ts.isCallExpression(g) && g.arguments.some((a) => a === p) && RECEIVABLE_MUTATION_REFS.has(name)) return null;
    return bad(p);
  }
  if (isKeyPosition(p, id)) return null;
  if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === id) return null;
  if (ts.isCallExpression(p) && p.expression === id && aliases.has(name)) return null;
  return bad(p);
}
