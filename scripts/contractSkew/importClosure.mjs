/**
 * The in-repo transitive closure of a source file (SCRUM-866).
 *
 * A baseline entry was reviewed against more than its own client file and its
 * backend module: what those files IMPORT (a validator, a payload builder, a
 * guard) decides what is sent and how it is handled. So a renewal that compares
 * only the two files can miss a changed helper. This resolves imports with the
 * TypeScript compiler (the surface's real tsconfig, via `createClientProgram`,
 * the same program the monitor builds) rather than a regular expression, so
 * path aliases, `export ... from`, `import type`, dynamic `import("x")` and
 * `require("x")` are followed the way the compiler follows them.
 *
 * The closure has three kinds of member:
 *   1. Files reached by an import edge (above).
 *   2. Files reached by a Convex FUNCTION REFERENCE. `api.<module>.<fn>` and
 *      `internal.<module>.<fn>` (any depth; `ctx.runQuery/runMutation/runAction`,
 *      the scheduler and crons all take one) name another backend module without
 *      importing it: the reference resolves through `convex/_generated/api`.
 *      Convex maps a function `f` in `convex/messages/access.ts` to
 *      `api.messages.access.f` (convex/_generated/ai/guidelines.md, "Function
 *      references"; docs.convex.dev/functions/query-functions, "Query names"), so
 *      the module is EXACTLY every segment but the last: `convex/messages/access.ts`
 *      and nothing shorter (`convex/messages.ts` is another module), and `index` is
 *      not special (`api.idx.index.fn` is convex/idx/index.ts; `api.idx.fn` names no
 *      module). Mobile's `makeFunctionReference("mod:fn")` string form is the same
 *      edge. A reference whose exact module does not exist is `unresolved`.
 *      Which import IS the generated api and which IS `convex/server` is decided by
 *      the module TypeScript resolves the specifier to (so `./_generated/api.js`, a
 *      path alias and a re-targeted tsconfig are seen), with the specifier text as a
 *      fallback that can only add ownership.
 *   The forms below are NOT traced and are reported in `unresolved`, which REFUSES
 *   mechanical renewal:
 *     - `api`/`internal` used other than as a static chain: bare (`const a = internal`),
 *       destructured, a dynamic key (`api[k]`), a chain that stops at a module
 *       (`internal.worker`) or names no function;
 *     - a default import, namespace import, `import x = require()` or dynamic
 *       `import()` / `require()` of the generated api module;
 *     - any re-export that could hand `api`/`internal`/`makeFunctionReference`/`anyApi`
 *       to a file that is not scanned again (`export { internal } from "./_generated/api"`,
 *       `export * from ...`, `export { api }`), and so the importers of such a file;
 *     - `anyApi`, and `makeFunctionReference` with a non-literal name, used without a
 *       call, or reached through a namespace used any other way (`const x = cv`,
 *       destructuring it, `cv[k]`); a dynamic `import()`/`require()` of `convex/server`;
 *     - a COMPUTED load, in every closure file and whatever it targets: `import()`,
 *       `require()` or `import x = require()` whose specifier is not a plain string
 *       literal (a no-substitution template counts as plain) after wrappers are
 *       skipped (`"a" + "b"`, a template with a substitution, an identifier, no
 *       argument), because it cannot be proved not to reach `_generated/api` or
 *       `convex/server`; every use of `require` other than a call, by ALLOWLIST: only a
 *       called `require.resolve(...)` and `typeof require` are inert, so `const r = require`,
 *       `require.call/apply/bind`, `require["call"]` and `require.resolve` as a value
 *       refuse; every property access named `require` and every element access with a
 *       plain string key `"require"`, in any position (called, extracted, passed, or
 *       used via `.call`/`.apply`/`.bind`), whatever the receiver; and every non-literal
 *       element key on `module`, `require` or `globalThis`; any reference to a free
 *       `module`, `global`, `globalThis` or `Reflect` identifier, except the exact
 *       CommonJS export access `module.exports` and the shipped Web Crypto
 *       access `globalThis.crypto`. This also refuses destructured,
 *       reflected, constructor and aliased loader acquisition without tracking the alias.
 *       Receivers and keys are unwrapped first; string, numeric, bigint, regexp and
 *       no-substitution template literals are literal keys. A direct literal
 *       `require("x")` is still traced, and called `require.resolve(...)` and
 *       `typeof require` remain accepted;
 *     Wrappers are looked through before every decision above (parentheses, `as`,
 *     `satisfies`, `<T>x`, `x!`, `f<T>`, partially emitted expressions): load specifiers,
 *     makeFunctionReference names and callees, `api`/`internal` chain links and keys,
 *     and namespace receivers. `ts.skipOuterExpressions` does this but is not in the
 *     public typescript.d.ts, so the public predicates are used instead.
 *     A namespace import of `convex/server` whose only use is
 *     `ns.makeFunctionReference("mod:fn")` IS traced like the named import.
 *   The real-tree dry run at this revision reports 1012 refused entries and 0
 *   unresolved baseline closures. This measures those closures, not every repo file.
 *   3. Inputs that decide HOW the first two resolve and type: the tsconfig each
 *      program was built from and its relative `extends` chain, that directory's
 *      package.json, and the `implicitInputs` the caller names (package.json,
 *      pnpm-lock.yaml, convex/schema.ts: the schema reaches clients only through
 *      the generated dataModel, which is excluded). An implicit input that is source
 *      is traversed like any member, so what convex/schema.ts imports is covered too.
 *
 * What is NOT part of the closure, and why:
 *   - `node_modules` (and anything resolving outside the repository): third-party
 *     code is pinned by the lockfile, not by this review.
 *   - `convex/_generated/`: generated from the whole backend. Its closure is
 *     every Convex module, so including it would make nothing renewable; the
 *     backend contract is checked by the monitor's fingerprint on every run.
 *
 * Known limits, i.e. what the closure still cannot see:
 *   - ambient declarations (`declare global`, a `.d.ts` nobody imports) have no edge;
 *   - dependency behaviour inside `node_modules` (only the lockfile and package.json
 *     pin it; a changed version with an unchanged lockfile entry cannot exist, but
 *     what the code of that version does is not reviewed here);
 *   - code that loads by other means: `eval`, `new Function`, `createRequire` under
 *     another name (`const load = createRequire(url); load(x)`), and type-only
 *     `import("x")` type nodes. `require.context` and member accesses named `require`
 *     refuse under the rules above; the scan does not track arbitrary loader aliases;
 *   - handler-only behaviour not reached by an edge: a database trigger, an
 *     `internal` function reached through a string built at run time, an HTTP route,
 *     a cron table or a scheduled job that runs code this file never names;
 *   - `components.*` references (Convex components are separate packages);
 *   - a local variable that shadows `api`/`internal` is treated as the generated
 *     object (this only ever over-includes).
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createClientProgram } from "./clientPaths.mjs";
import { toPosixRel } from "./clientFiles.mjs";

export const GENERATED_PREFIX = "convex/_generated/";
const CONVEX_DIR = "convex";
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/;
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];
/** The generated function-reference module, by its repository-relative resolved path (`.ts`, `.js` or `.d.ts`). */
const GENERATED_API_FILE = /^convex\/_generated\/api\.(?:d\.)?[cm]?[jt]sx?$/;
/** The `convex/server` entry point wherever the package manager put it (pnpm nests it under `.pnpm/`). */
const CONVEX_SERVER_FILE = /(?:^|\/)node_modules\/convex\/(?:[^/]+\/)*server\/index\.(?:d\.)?[cm]?[jt]s$/;
/** Fallback when a specifier does not resolve (a tree without node_modules): the text only ever ADDS ownership. */
const GENERATED_API_TEXT = /(?:^|\/)_generated\/api(?:\.[cm]?[jt]sx?)?$/;

/**
 * Transparent wrappers that change no runtime value: parentheses, `x as T`, `x satisfies T`, `<T>x`, `x!`,
 * `f<T>` and partially emitted expressions. Every syntactic decision in the scan looks through them.
 * `ts.skipOuterExpressions` does this but is not part of the public typescript.d.ts, so it is not relied on;
 * these are the public predicates (https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).
 *
 * @param {import("typescript").Node} node
 * @returns {node is import("typescript").Node & { expression: import("typescript").Expression }}
 */
function isTransparent(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isExpressionWithTypeArguments(node) ||
    ts.isPartiallyEmittedExpression(node)
  );
}

/** @template {import("typescript").Node} T @param {T} node @returns {import("typescript").Node} */
function unwrap(node) {
  /** @type {import("typescript").Node} */
  let current = node;
  while (isTransparent(current)) current = current.expression;
  return current;
}
/**
 * Everything a source file names that can change what it does: module specifiers
 * (static and type-only imports, `export ... from`, `import x = require()`,
 * `import()` and `require()` with a string literal) and Convex function references.
 *
 * Which import is the generated `api` module and which is `convex/server` is decided by
 * `ownerOf`, which resolves the specifier with TypeScript (so `./_generated/api.js`, a
 * path alias and a re-targeted tsconfig are all seen), never by the specifier's text alone.
 *
 * @param {import("typescript").SourceFile} source
 * @param {(specifier: string) => "api" | "server" | undefined} ownerOf
 * @returns {{ specifiers: string[], references: Array<{ text: string, modulePath: string[] }>, opaque: string[] }}
 *   `references` name a backend module exactly (`api.a.b.fn` -> `["a", "b"]`);
 *   `opaque` are references and loads that cannot be read statically, each of which refuses renewal.
 */
function scan(source, ownerOf) {
  /** @type {string[]} */
  const specifiers = [];
  /** @type {Array<{ text: string, modulePath: string[] }>} */
  const references = [];
  /** @type {string[]} */
  const opaque = [];
  /** local name -> "api" | "internal" (the generated function-reference roots) */
  const roots = new Map();
  const makers = new Set();
  const anyApis = new Set();
  const serverNamespaces = new Set();
  const MAKER = "makeFunctionReference";
  const ANY_API = "anyApi";
  const importedName = (/** @type {import("typescript").ImportSpecifier} */ element) => (element.propertyName ?? element.name).text;
  /** The text of a plain string literal (or no-substitution template) once wrappers are skipped; anything else is undefined. */
  const plainText = (/** @type {import("typescript").Expression} */ expression) => {
    const inner = unwrap(expression);
    return ts.isStringLiteralLike(inner) ? inner.text : undefined;
  };
  const specifierOf = (/** @type {import("typescript").Node} */ node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      return plainText(node.moduleReference.expression);
    }
    return undefined;
  };

  // Pass 1: what the file imports from the two owned modules.
  for (const statement of source.statements) {
    const from = specifierOf(statement);
    const owner = from === undefined ? undefined : ownerOf(from);
    if (owner === undefined || from === undefined) continue;
    if (ts.isImportEqualsDeclaration(statement)) {
      if (owner === "api") opaque.push(`import = require of ${from} cannot be traced`);
      else serverNamespaces.add(statement.name.text);
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      const bindings = clause.namedBindings;
      if (clause.name) opaque.push(`default import of ${from} cannot be traced`);
      if (bindings && ts.isNamespaceImport(bindings)) {
        if (owner === "api") opaque.push(`namespace import of ${from} cannot be traced`);
        else serverNamespaces.add(bindings.name.text);
      } else if (bindings) {
        for (const element of bindings.elements) {
          const imported = importedName(element);
          if (owner === "api" && (imported === "api" || imported === "internal")) roots.set(element.name.text, imported);
          if (owner === "server" && imported === MAKER) makers.add(element.name.text);
          if (owner === "server" && imported === ANY_API) anyApis.add(element.name.text);
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      // A re-export hands the root to files this scan does not follow back to their uses.
      const clause = statement.exportClause;
      const names = clause && ts.isNamedExports(clause) ? clause.elements.map((element) => (element.propertyName ?? element.name).text) : undefined;
      if (owner === "api" || names === undefined || names.includes(MAKER) || names.includes(ANY_API)) {
        opaque.push(`re-export from ${from} cannot be traced`);
      }
    }
  }
  // Pass 2: a local re-export of a root or maker (`export { api }`), wherever it is written in the file.
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const local = (element.propertyName ?? element.name).text;
      if (roots.has(local) || makers.has(local) || anyApis.has(local) || serverNamespaces.has(local)) opaque.push(`re-export of ${local} cannot be traced`);
    }
  }

  /** @param {import("typescript").Node} node @returns {{ base: string, segments: string[] } | undefined} */
  const chainOf = (node) => {
    /** @type {string[]} */
    const reversed = [];
    let current = node;
    for (;;) {
      current = unwrap(current);
      if (ts.isPropertyAccessExpression(current)) {
        reversed.push(current.name.text);
        current = current.expression;
      } else if (ts.isElementAccessExpression(current)) {
        const key = plainText(current.argumentExpression);
        if (key === undefined) return { base: "", segments: [] }; // dynamic key
        reversed.push(key);
        current = current.expression;
      } else if (ts.isQualifiedName(current)) {
        reversed.push(current.right.text);
        current = current.left;
      } else {
        break;
      }
    }
    if (!ts.isIdentifier(current)) return undefined;
    return { base: current.text, segments: reversed.reverse() };
  };

  /** @param {import("typescript").Identifier} node */
  const isBindingOrMemberName = (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) || ts.isBindingElement(parent) && parent.propertyName === node || ts.isEnumMember(parent) ||
      ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === node) return true;
    if (ts.isQualifiedName(parent) && parent.right === node) return true;
    return ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent);
  };

  /** Whether `node`, seen through transparent wrappers, is the callee of a call. @param {import("typescript").Node} node */
  const isCallee = (node) => {
    let current = node;
    while (current.parent && isTransparent(current.parent) && current.parent.expression === current) current = current.parent;
    return current.parent !== undefined && ts.isCallExpression(current.parent) && current.parent.expression === current;
  };

  /** The outermost transparent wrapper around `node` (the node itself when it is not wrapped). @param {import("typescript").Node} node */
  const outermost = (node) => {
    let current = node;
    while (current.parent && isTransparent(current.parent) && current.parent.expression === current) current = current.parent;
    return current;
  };

  /** `typeof require`, or `require.resolve(...)` that is called: neither loads a module. @param {import("typescript").Node} node */
  const isInertRequire = (node) => {
    const outer = outermost(node);
    const parent = outer.parent;
    if (parent === undefined) return false;
    if (ts.isTypeOfExpression(parent)) return true;
    return ts.isPropertyAccessExpression(parent) && parent.expression === outer && parent.name.text === "resolve" && isCallee(parent);
  };

  // A lexical declaration in this file can shadow a runtime global. Check the
  // enclosing scopes, rather than matching source text, so local `module` data
  // does not become a loader claim. Ambient Node globals have no local binding.
  /** @param {import("typescript").BindingName} name @param {string} wanted */
  const binds = (name, wanted) => ts.isIdentifier(name)
    ? name.text === wanted
    : name.elements.some((part) => ts.isBindingElement(part) && binds(part.name, wanted));
  // `declare` describes an existing value; it emits no shadow, including in
  // nested ambient namespaces/global blocks and declaration files.
  /** @param {import("typescript").Node} node */
  const isAmbient = (node) => {
    for (let current = node; current; current = current.parent) {
      if (ts.isSourceFile(current) && current.isDeclarationFile) return true;
      if (ts.canHaveModifiers(current) && ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
    }
    return false;
  };
  /** @param {import("typescript").Node} scope @param {string} wanted */
  const declares = (scope, wanted) => {
    if (isAmbient(scope)) return false;
    if (ts.isFunctionLike(scope) && "body" in scope && scope.body && scope.parameters.some((param) => binds(param.name, wanted))) return true;
    if (ts.isCatchClause(scope) && scope.variableDeclaration && binds(scope.variableDeclaration.name, wanted)) return true;
    const statements = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
      ? scope.statements : undefined;
    if (!statements) return false;
    for (const statement of statements) {
      if (isAmbient(statement)) continue;
      if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((decl) => binds(decl.name, wanted))) return true;
      if (ts.isFunctionDeclaration(statement) && statement.body && statement.name?.text === wanted) return true;
      if (ts.isClassDeclaration(statement) && statement.name?.text === wanted) return true;
      // A const enum may be erased; an uncertain declaration must not hide a loader.
      if (ts.isEnumDeclaration(statement) && !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ConstKeyword) && statement.name.text === wanted) return true;
      if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly && statement.name.text === wanted) return true;
      if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
        const clause = statement.importClause;
        if (clause.name?.text === wanted) return true;
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === wanted) return true;
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((element) => !element.isTypeOnly && element.name.text === wanted)) return true;
      }
    }
    return false;
  };
  /** @param {import("typescript").Identifier} node */
  const isLocallyBound = (node) => {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (declares(scope, node.text)) return true;
    }
    return false;
  };
  /** @param {import("typescript").Identifier} node */
  const isModuleExports = (node) => {
    const outer = outermost(node);
    const parent = outer.parent;
    return parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === outer && parent.name.text === "exports";
  };
  /** The shipped client uses Web Crypto through this exact built-in property. @param {import("typescript").Identifier} node */
  const isGlobalCrypto = (node) => {
    const outer = outermost(node);
    const parent = outer.parent;
    return parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === outer && parent.name.text === "crypto";
  };

  /** The call `makeFunctionReference(...)` or `ns.makeFunctionReference(...)`, wrappers skipped. @param {import("typescript").Expression} expression */
  const isMakerCallee = (expression) => {
    const callee = unwrap(expression);
    if (ts.isIdentifier(callee)) return makers.has(callee.text);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const receiver = unwrap(callee.expression);
    return ts.isIdentifier(receiver) && serverNamespaces.has(receiver.text) && callee.name.text === MAKER;
  };

  /**
   * A namespace import of convex/server that `node` reads a member of (`cv.x`, `cv["x"]`, through wrappers), or undefined.
   * @param {import("typescript").Node} node
   */
  const serverMemberAccess = (node) => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
    const receiver = unwrap(node.expression);
    return ts.isIdentifier(receiver) && serverNamespaces.has(receiver.text) ? node : undefined;
  };

  // Scan every member access independently: reference-chain handling below can stop traversal at an outer node.
  // Node's module.require is itself a loader, even when extracted or used via call/apply/bind:
  // https://nodejs.org/api/modules.html#modulerequireid
  /** @param {import("typescript").Node} node */
  const visitLoaderAccess = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "require") {
      opaque.push("member named require cannot be traced");
    } else if (ts.isElementAccessExpression(node)) {
      const key = unwrap(node.argumentExpression);
      const receiver = unwrap(node.expression);
      if (plainText(node.argumentExpression) === "require") {
        opaque.push("member named require cannot be traced");
      } else if (!ts.isLiteralExpression(key) && ts.isIdentifier(receiver) && ["module", "require", "globalThis"].includes(receiver.text)) {
        opaque.push(`computed member of ${receiver.text} cannot be traced`);
      }
    }
    ts.forEachChild(node, visitLoaderAccess);
  };
  visitLoaderAccess(source);

  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    const specifier = specifierOf(node);
    if (specifier !== undefined) {
      specifiers.push(specifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      opaque.push("computed require() specifier cannot be traced");
    } else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      opaque.push("computed module specifier cannot be traced");
    } else if (ts.isCallExpression(node)) {
      // `import(x)` and `require(x)`, however the callee and the argument are wrapped. Every closure file is held to
      // this, whatever the load targets: a specifier that is not a plain literal cannot be proved not to reach
      // convex/_generated/api or convex/server.
      const callee = unwrap(node.expression);
      const kind = callee.kind === ts.SyntaxKind.ImportKeyword ? "import" : ts.isIdentifier(callee) && callee.text === "require" ? "require" : undefined;
      if (kind !== undefined) {
        const target = node.arguments.length >= 1 ? plainText(node.arguments[0]) : undefined;
        if (target === undefined) {
          opaque.push(`computed ${kind}() specifier cannot be traced`);
        } else {
          specifiers.push(target);
          if (ownerOf(target) !== undefined) opaque.push(`dynamic load of ${target} cannot be traced`);
        }
      }
    }
    if (ts.isCallExpression(node) && isMakerCallee(node.expression)) {
      const name = node.arguments.length >= 1 ? plainText(node.arguments[0]) : undefined;
      if (name !== undefined) {
        // "folder/module:fn" (a string with no ":" names the module's default export).
        const [modulePath] = name.split(":");
        references.push({ text: `makeFunctionReference("${name}")`, modulePath: modulePath.split("/") });
      } else {
        opaque.push("makeFunctionReference with a non-literal name cannot be traced");
      }
    }
    if (ts.isImportDeclaration(node)) return;
    const member = serverMemberAccess(node);
    if (member && ts.isPropertyAccessExpression(member)) {
      if (member.name.text === ANY_API) opaque.push("anyApi cannot be traced");
      else if (member.name.text === MAKER && !isCallee(member)) opaque.push("makeFunctionReference used without a call cannot be traced");
      return;
    }
    if (member) {
      opaque.push("a computed member of convex/server cannot be traced");
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isQualifiedName(node)) {
      const chain = chainOf(node);
      if (chain && roots.has(chain.base)) {
        const root = roots.get(chain.base);
        const text = `${root}.${chain.segments.join(".")}`;
        if (chain.segments.length === 0) opaque.push(`${root}[<dynamic>] cannot be traced`);
        else if (chain.segments.length < 2) opaque.push(`${text} names no function (a module path needs at least module and function)`);
        // The module is every segment but the last: `api.messages.access.h` is function h of convex/messages/access.ts
        // (https://docs.convex.dev/functions/query-functions, "Query names").
        else references.push({ text, modulePath: chain.segments.slice(0, -1) });
        return; // the whole chain is accounted for
      }
    }
    if (ts.isIdentifier(node) && !isBindingOrMemberName(node)) {
      if (roots.has(node.text)) opaque.push(`${roots.get(node.text)} used without a static function path`);
      if (anyApis.has(node.text)) opaque.push("anyApi cannot be traced");
      if (makers.has(node.text) && !isCallee(node)) opaque.push("makeFunctionReference used without a call cannot be traced");
      if (serverNamespaces.has(node.text)) opaque.push("a convex/server namespace used without a static member cannot be traced");
      // `const r = require; r("x")` loads without a call the scan can read. `require.resolve` and `typeof require` load nothing.
      // An ALLOWLIST: only a called `require.resolve(...)` and `typeof require` are inert. Every other use
      // (`require.call/apply/bind`, `require["x"]`, `require.resolve` as a value, an alias) can reach a load.
      if (node.text === "require" && !isCallee(node) && !isInertRequire(node)) opaque.push("require used without a call cannot be traced");
      if (["module", "global", "globalThis", "Reflect"].includes(node.text) && !isLocallyBound(node) &&
        !(node.text === "module" && isModuleExports(node)) &&
        !(node.text === "globalThis" && isGlobalCrypto(node))) {
        opaque.push(`free ${node.text} reference cannot be traced`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, references, opaque };
}
/**
 * The tsconfig a program was built from and its relative `extends` chain, as repository-relative paths.
 * A package `extends` ("expo/tsconfig.base") resolves into node_modules and is pinned by the lockfile.
 *
 * @param {string} absRoot @param {string} tsconfigAbs
 * @returns {string[]}
 */
function configChain(absRoot, tsconfigAbs) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} file */
  const walk = (file) => {
    const rel = toPosixRel(absRoot, file);
    if (found.includes(rel)) return;
    found.push(rel);
    const read = ts.readConfigFile(file, ts.sys.readFile);
    const extend = read.config?.extends;
    for (const spec of Array.isArray(extend) ? extend : extend ? [extend] : []) {
      if (typeof spec !== "string" || !spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      walk(path.extname(target) === ".json" ? target : `${target}.json`);
    }
  };
  walk(tsconfigAbs);
  return found;
}

/**
 * @param {{ root: string, projects: Array<{ tsconfig: string, rootFiles: string[] }>, implicitInputs?: string[] }} options
 *   `rootFiles` are repository-relative; each is the entry of its project's program.
 *   `implicitInputs` are repository-relative files every closure includes (lockfile, schema, ...).
 * @returns {(file: string) => { files: string[], unresolved: string[] }}
 *   `files` are repository-relative, sorted and include the file itself;
 *   `unresolved` lists in-repo specifiers (relative or `@/`) and function references that resolve to nothing.
 */
export function createImportClosure({ root, projects, implicitInputs = [] }) {
  const absRoot = path.resolve(root);
  const toRel = (/** @type {string} */ abs) => toPosixRel(absRoot, abs);
  const states = projects
    .filter((project) => project.rootFiles.length > 0)
    .map(({ tsconfig, rootFiles }) => {
      const program = createClientProgram(rootFiles.map((file) => path.resolve(absRoot, file)), path.resolve(absRoot, tsconfig));
      /** @type {Map<string, { files: string[], unresolved: string[] }>} direct imports per file, one project's program */
      const edges = new Map();
      const tsconfigAbs = path.resolve(absRoot, tsconfig);
      const configDirPackage = toPosixRel(absRoot, path.join(path.dirname(tsconfigAbs), "package.json"));
      const inputs = [...configChain(absRoot, tsconfigAbs), ...(fs.existsSync(path.join(absRoot, configDirPackage)) ? [configDirPackage] : []), ...implicitInputs];
      return { program, options: program.getCompilerOptions(), edges, roots: new Set(rootFiles), inputs };
    });

  const parseFromDisk = (/** @type {string} */ abs) => {
    const text = ts.sys.fileExists(abs) ? ts.sys.readFile(abs) : undefined;
    return text === undefined ? undefined : ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  };

  /**
   * The backend module file named by `modulePath` (every segment of a function path but the last):
   * `["messages", "access"]` is convex/messages/access.ts. Exactly that file; a shorter prefix that happens to
   * exist (convex/messages.ts) is a different module, and `index` has no special meaning
   * (convex/_generated/ai/guidelines.md, "Function references"; docs.convex.dev/functions/query-functions, "Query names").
   * An empty result is an unresolved reference.
   */
  const functionModules = (/** @type {string[]} */ modulePath) => {
    const stem = path.join(absRoot, CONVEX_DIR, ...modulePath);
    return MODULE_EXTENSIONS.map((extension) => toPosixRel(absRoot, `${stem}${extension}`)).filter(
      (candidate) => ts.sys.fileExists(path.join(absRoot, candidate)) && !candidate.startsWith(GENERATED_PREFIX)
    );
  };

  /**
   * Which of the two modules whose bindings carry function references a specifier names, decided by what
   * TypeScript resolves it to (`./_generated/api.js`, a path alias and a re-targeted tsconfig all count),
   * with the specifier's text as a fallback so a tree that cannot resolve it can only over-refuse.
   *
   * @param {(typeof states)[number]} state @param {string} fromFile absolute path of the importing file
   * @returns {(specifier: string) => "api" | "server" | undefined}
   */
  const ownerOfFor = (state, fromFile) => (specifier) => {
    const resolved = ts.resolveModuleName(specifier, fromFile, state.options, ts.sys).resolvedModule;
    if (resolved) {
      const target = toRel(resolved.resolvedFileName);
      if (GENERATED_API_FILE.test(target)) return "api";
      if (CONVEX_SERVER_FILE.test(target)) return "server";
    }
    if (GENERATED_API_TEXT.test(specifier)) return "api";
    return specifier === "convex/server" ? "server" : undefined;
  };

  /** @param {(typeof states)[number]} state @param {string} rel */
  const directImports = (state, rel) => {
    const cached = state.edges.get(rel);
    if (cached) return cached;
    const files = new Set();
    const unresolved = new Set();
    if (SCRIPT_EXT.test(rel)) {
      const abs = path.resolve(absRoot, rel);
      // Always parsed from disk with parent pointers (a program's own source files have none until type-checked,
      // and a function reference reaches modules the program never imported). The scan needs no type information;
      // import specifiers resolve with the project's options.
      const source = parseFromDisk(abs);
      if (!source) {
        unresolved.add(`(source ${rel} cannot be read)`);
      } else {
        const scanned = scan(source, ownerOfFor(state, abs));
        const specs = new Set(scanned.specifiers);
        for (const text of scanned.opaque) unresolved.add(text);
        for (const reference of scanned.references) {
          const modules = functionModules(reference.modulePath);
          if (modules.length === 0) unresolved.add(`${reference.text} (names no module under ${CONVEX_DIR}/)`);
          for (const moduleFile of modules) files.add(moduleFile);
        }
        for (const reference of source.referencedFiles) files.add(toRel(path.resolve(path.dirname(abs), reference.fileName)));
        for (const spec of specs) {
          const resolved = ts.resolveModuleName(spec, abs, state.options, ts.sys).resolvedModule;
          if (resolved) {
            const target = toRel(resolved.resolvedFileName);
            const external = resolved.isExternalLibraryImport || target.startsWith("..") || target.split("/").includes("node_modules");
            if (!external && !target.startsWith(GENERATED_PREFIX)) files.add(target);
            continue;
          }
          // TypeScript does not resolve assets (`./x.css`, `./x.svg`): a file that exists is a dependency.
          const candidate = spec.startsWith(".") ? path.resolve(path.dirname(abs), spec) : spec.startsWith("@/") ? path.resolve(absRoot, spec.slice(2)) : undefined;
          if (candidate === undefined) continue; // bare package name: external, pinned by the lockfile
          if (ts.sys.fileExists(candidate)) files.add(toRel(candidate));
          else unresolved.add(spec);
        }
      }
    }
    const result = { files: [...files], unresolved: [...unresolved] };
    state.edges.set(rel, result);
    return result;
  };

  return (file) => {
    const state = states.find((candidate) => candidate.roots.has(file));
    if (!state) throw new Error(`${file} is not a root of any import-closure project`);
    const seen = new Set([file, ...state.inputs]);
    const unresolved = new Set();
    // An implicit input that is source (convex/schema.ts) has imports of its own that decide what it means.
    const stack = [file, ...state.inputs.filter((input) => SCRIPT_EXT.test(input))];
    while (stack.length) {
      const edges = directImports(state, /** @type {string} */ (stack.pop()));
      for (const spec of edges.unresolved) unresolved.add(spec);
      for (const next of edges.files) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return { files: [...seen].sort(), unresolved: [...unresolved].sort() };
  };
}
