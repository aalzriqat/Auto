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
 *      references"), so every leading run of segments that names `convex/<run>.ts`
 *      (or `<run>/index.ts`) is an edge. Mobile's `makeFunctionReference("mod:fn")`
 *      string form is the same edge. A reference that names no module, or that
 *      cannot be read statically (bare `api`, `api[key]`, a namespace or dynamic
 *      import of `_generated/api`, `anyApi`, a non-literal `makeFunctionReference`)
 *      is reported in `unresolved`, which refuses mechanical renewal.
 *   3. Inputs that decide HOW the first two resolve and type: the tsconfig each
 *      program was built from and its relative `extends` chain, that directory's
 *      package.json, and the `implicitInputs` the caller names (package.json,
 *      pnpm-lock.yaml, convex/schema.ts: the schema reaches clients only through
 *      the generated dataModel, which is excluded).
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
const GENERATED_API = /(?:^|\/)_generated\/api$/;
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

/**
 * Everything a source file names that can change what it does: module specifiers
 * (static and type-only imports, `export ... from`, `import x = require()`,
 * `import()` and `require()` with a string literal) and Convex function references.
 *
 * @param {import("typescript").SourceFile} source
 * @returns {{ specifiers: string[], functionPaths: Array<{ text: string, segments: string[] }>, opaque: string[] }}
 *   `functionPaths` are `api.a.b` chains; `opaque` are references that cannot be read statically.
 */
function scan(source) {
  /** @type {string[]} */
  const specifiers = [];
  /** @type {Array<{ text: string, segments: string[] }>} */
  const functionPaths = [];
  /** @type {string[]} */
  const opaque = [];
  /** local name -> "api" | "internal" (the generated function-reference roots) */
  const roots = new Map();
  const referenceMakers = new Set();
  const anyApis = new Set();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) || !statement.importClause) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (GENERATED_API.test(from)) {
      if (clause.name) opaque.push(`default import of ${from} cannot be traced`);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) opaque.push(`namespace import of ${from} cannot be traced`);
      else if (bindings) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported === "api" || imported === "internal") roots.set(element.name.text, imported);
        }
      }
    } else if (from === "convex/server" && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === "makeFunctionReference") referenceMakers.add(element.name.text);
        if (imported === "anyApi") anyApis.add(element.name.text);
      }
    }
  }

  /** @param {import("typescript").Node} node @returns {{ base: string, segments: string[] } | undefined} */
  const chainOf = (node) => {
    /** @type {string[]} */
    const reversed = [];
    let current = node;
    for (;;) {
      if (ts.isPropertyAccessExpression(current)) {
        reversed.push(current.name.text);
        current = current.expression;
      } else if (ts.isElementAccessExpression(current)) {
        if (!ts.isStringLiteralLike(current.argumentExpression)) return { base: "", segments: [] }; // dynamic key
        reversed.push(current.argumentExpression.text);
        current = current.expression;
      } else if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
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
      ts.isMethodDeclaration(parent) || ts.isBindingElement(parent) && parent.propertyName === node || ts.isEnumMember(parent)) && parent.name === node) return true;
    if (ts.isQualifiedName(parent) && parent.right === node) return true;
    return ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
  };

  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        specifiers.push(node.arguments[0].text);
        if (GENERATED_API.test(node.arguments[0].text)) opaque.push(`dynamic load of ${node.arguments[0].text} cannot be traced`);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && referenceMakers.has(node.expression.text)) {
      const [name] = node.arguments;
      if (name && ts.isStringLiteralLike(name)) {
        const [modulePath] = name.text.split(":");
        functionPaths.push({ text: `makeFunctionReference("${name.text}")`, segments: modulePath.split("/") });
      } else {
        opaque.push("makeFunctionReference with a non-literal name cannot be traced");
      }
    }
    if (ts.isImportDeclaration(node)) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isQualifiedName(node)) {
      const chain = chainOf(node);
      if (chain && roots.has(chain.base)) {
        const label = chain.base;
        if (chain.segments.length === 0) opaque.push(`${label}[<dynamic>] cannot be traced`);
        else functionPaths.push({ text: `${roots.get(label)}.${chain.segments.join(".")}`, segments: chain.segments });
        return; // the whole chain is accounted for
      }
    }
    if (ts.isIdentifier(node)) {
      if (roots.has(node.text) && !isBindingOrMemberName(node)) opaque.push(`${roots.get(node.text)} used without a static function path`);
      if (anyApis.has(node.text) && !isBindingOrMemberName(node)) opaque.push("anyApi cannot be traced");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, functionPaths, opaque };
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
 */export function createImportClosure({ root, projects, implicitInputs = [] }) {
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

  /** Every leading run of segments that names a backend module file: `a.b.c` -> convex/a.ts, convex/a/b.ts, ... */
  const functionModules = (/** @type {string[]} */ segments) => {
    /** @type {string[]} */
    const modules = [];
    for (let length = 1; length <= segments.length; length++) {
      const stem = path.join(absRoot, CONVEX_DIR, ...segments.slice(0, length));
      for (const candidate of MODULE_EXTENSIONS.flatMap((extension) => [`${stem}${extension}`, path.join(stem, `index${extension}`)])) {
        if (ts.sys.fileExists(candidate) && !toPosixRel(absRoot, candidate).startsWith(GENERATED_PREFIX)) modules.push(toPosixRel(absRoot, candidate));
      }
    }
    return modules;
  };

  /** @param {(typeof states)[number]} state @param {string} rel */
  const directImports = (state, rel) => {
    const cached = state.edges.get(rel);
    if (cached) return cached;
    const files = new Set();
    const unresolved = new Set();
    if (SCRIPT_EXT.test(rel)) {
      const abs = path.resolve(absRoot, rel);
      // A function reference reaches a module the program never imported: scan it syntactically from disk
      // (the scan needs no type information, and import specifiers resolve with the project options).
      const source = state.program.getSourceFile(abs) ?? parseFromDisk(abs);
      if (!source) {
        unresolved.add(`(source ${rel} is not in the program)`);
      } else {
        const scanned = scan(source);
        const specs = new Set(scanned.specifiers);
        for (const text of scanned.opaque) unresolved.add(text);
        for (const reference of scanned.functionPaths) {
          const modules = functionModules(reference.segments);
          if (modules.length === 0) unresolved.add(`${reference.text} (names no module under ${CONVEX_DIR}/)`);
          for (const module of modules) files.add(module);
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
    const stack = [file];
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