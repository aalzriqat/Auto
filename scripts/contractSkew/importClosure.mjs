/**
 * The in-repo transitive import closure of a source file (SCRUM-866).
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
 * What is NOT part of the closure, and why:
 *   - `node_modules` (and anything resolving outside the repository): third-party
 *     code is pinned by the lockfile, not by this review.
 *   - `convex/_generated/`: generated from the whole backend. Its closure is
 *     every Convex module, so including it would make nothing renewable; the
 *     backend contract is checked by the monitor's fingerprint on every run.
 *
 * Known limit: ambient global declarations (`declare global`, a `.d.ts` nobody
 * imports) have no import edge and are not followed.
 */
import path from "node:path";
import ts from "typescript";
import { createClientProgram } from "./clientPaths.mjs";
import { toPosixRel } from "./clientFiles.mjs";

export const GENERATED_PREFIX = "convex/_generated/";
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Module specifiers a source file names: static and type-only imports,
 * `export ... from`, `import x = require()`, `import()` and `require()` with a
 * string literal.
 *
 * @param {import("typescript").SourceFile} source
 * @returns {string[]}
 */
function specifiersOf(source) {
  /** @type {string[]} */
  const found = [];
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * @param {{ root: string, projects: Array<{ tsconfig: string, rootFiles: string[] }> }} options
 *   `rootFiles` are repository-relative; each is the entry of its project's program.
 * @returns {(file: string) => { files: string[], unresolved: string[] }}
 *   `files` are repository-relative, sorted and include the file itself;
 *   `unresolved` lists in-repo specifiers (relative or `@/`) that resolve to nothing.
 */
export function createImportClosure({ root, projects }) {
  const absRoot = path.resolve(root);
  const toRel = (/** @type {string} */ abs) => toPosixRel(absRoot, abs);
  const states = projects
    .filter((project) => project.rootFiles.length > 0)
    .map(({ tsconfig, rootFiles }) => {
      const program = createClientProgram(rootFiles.map((file) => path.resolve(absRoot, file)), path.resolve(absRoot, tsconfig));
      /** @type {Map<string, { files: string[], unresolved: string[] }>} direct imports per file, one project's program */
      const edges = new Map();
      return { program, options: program.getCompilerOptions(), edges, roots: new Set(rootFiles) };
    });

  /** @param {(typeof states)[number]} state @param {string} rel */
  const directImports = (state, rel) => {
    const cached = state.edges.get(rel);
    if (cached) return cached;
    const files = new Set();
    const unresolved = new Set();
    if (SCRIPT_EXT.test(rel)) {
      const abs = path.resolve(absRoot, rel);
      const source = state.program.getSourceFile(abs);
      if (!source) {
        unresolved.add(`(source ${rel} is not in the program)`);
      } else {
        const specs = new Set(specifiersOf(source));
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
    const seen = new Set([file]);
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