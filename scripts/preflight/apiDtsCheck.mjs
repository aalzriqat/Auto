/**
 * Offline check of `convex/_generated/api.d.ts` against what the Convex code generator would emit (SCRUM-1007).
 *
 * Why: CI's `convex-backend` job runs `convex dev --once` against a throwaway local backend and then
 * `git diff --exit-code convex/_generated` (.github/workflows/test.yml). A module added without regenerating, or a
 * hand-added entry in the wrong position, fails that job. Running the real generator needs a local backend binary and
 * a deployment, so it is not a sub-minute local check.
 *
 * What this does instead: it re-implements, from the installed `convex` package's own code, the two decisions that
 * determine the generated file: WHICH files are registered and in WHAT ORDER.
 *   - which: `entryPoints()` in convex/dist/cjs/bundler/index.js (extension list, `_generated`, dotfiles, `#` files,
 *     `schema.*`, names with more than one dot, spaces, nested components, files with no import/export);
 *   - order: `doApiCodegen()` in convex/dist/cjs/cli/codegen.js sorts the relative paths with the default JS sort
 *     (UTF-16 code units) while they still carry their extension;
 *   - names: `importPath` and `moduleIdentifier` are loaded from the package, not copied.
 * It then compares the import block and the `fullApi` block of the committed file to that, separately.
 *
 * Limits (also stated in the PR): this is an emulation of version-specific internals, not the generator. It does not
 * check the rest of the file (header, `components`, formatting) or `api.js`, and a Convex upgrade that changes those
 * internals can make it wrong. Its guard is the repository test that requires zero problems on the committed file,
 * which CI's real generator keeps honest.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ENTRY_POINT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"];
const EXPORT_OR_IMPORT = /^\s{0,100}(import|export)/m;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** @typedef {{ kind: "missing" | "extra" | "duplicate" | "order" | "identifier", block: "import" | "fullApi", module: string, message: string, fix: string }} ApiProblem */

/**
 * `importPath` and `moduleIdentifier` exactly as the installed generator defines them.
 * @returns {{ importPath: (p: string) => string, moduleIdentifier: (p: string) => string, version: string }}
 */
export function loadGeneratorNaming() {
  const require = createRequire(import.meta.url);
  let pkgPath;
  try {
    pkgPath = require.resolve("convex/package.json");
  } catch (error) {
    throw new Error(`cannot locate the installed convex package (run pnpm install): ${error instanceof Error ? error.message : String(error)}`);
  }
  const pkgDir = path.dirname(pkgPath);
  const apiTemplate = path.join(pkgDir, "dist", "cjs", "cli", "codegen_templates", "api.js");
  let template;
  try {
    template = require(apiTemplate);
  } catch (error) {
    throw new Error(`cannot load the Convex api template ${apiTemplate}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof template.importPath !== "function" || typeof template.moduleIdentifier !== "function") {
    throw new Error(`${apiTemplate} no longer exports importPath/moduleIdentifier; this check must be updated for this Convex version`);
  }
  const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  return { importPath: template.importPath, moduleIdentifier: template.moduleIdentifier, version: String(version) };
}

/**
 * Module paths (no extension, forward slashes) the generator registers for `convexDir`, in generator order.
 * @param {string} convexDir absolute path of the `convex/` directory
 * @returns {string[]}
 */
export function expectedApiModules(convexDir) {
  const { importPath } = loadGeneratorNaming();
  /** @type {string[]} */
  const relPaths = [];
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(full, "convex.config.ts"))) continue; // a nested component, not this app's functions
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(convexDir, full).split(path.sep).join("/");
      const base = entry.name;
      if (rel.startsWith("_deps/")) throw new Error(`${rel} is inside the reserved "_deps" directory; Convex refuses this layout`);
      if (!ENTRY_POINT_EXTENSIONS.some((ext) => rel.toLowerCase().endsWith(ext))) continue;
      if (rel.startsWith("_generated/")) continue;
      if (base.startsWith(".") || base.startsWith("#")) continue;
      if (base === "schema.ts" || base === "schema.js") continue;
      if ((base.match(/\./g) || []).length > 1) continue;
      if (rel.includes(" ")) continue;
      if ((base.endsWith(".ts") || base.endsWith(".tsx")) && !EXPORT_OR_IMPORT.test(fs.readFileSync(full, "utf8"))) continue;
      relPaths.push(rel);
    }
  };
  walk(convexDir, 0);
  return relPaths.sort().map((rel) => importPath(rel));
}

/**
 * The two registered-module lists in a generated api.d.ts.
 * @param {string} text
 * @returns {{ imports: Array<{ module: string, id: string }>, fullApi: Array<{ module: string, id: string }> }}
 */
export function parseApiDts(text) {
  const imports = [];
  for (const m of text.matchAll(/^import type \* as ([\w$]+) from "\.\.\/(.+)\.js";\s*$/gm)) imports.push({ module: m[2], id: m[1] });
  const start = text.search(/declare const fullApi: ApiFromModules<\{/);
  if (start === -1) throw new Error("api.d.ts has no `declare const fullApi: ApiFromModules<{` block");
  const open = text.indexOf("{", text.indexOf("ApiFromModules<", start));
  const close = text.indexOf("\n}>", open);
  if (close === -1) throw new Error("api.d.ts fullApi block is not closed by `}>`");
  const fullApi = [];
  for (const line of text.slice(open + 1, close).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*typeof\s+([\w$]+)\s*[;,]?\s*$/);
    if (!m) throw new Error(`api.d.ts fullApi block has a line this check cannot read: ${line.trim()}`);
    fullApi.push({ module: m[1] ?? m[2], id: m[3] });
  }
  if (imports.length === 0) throw new Error("api.d.ts has no `import type * as ... from \"../....js\"` lines");
  return { imports, fullApi };
}

/** Indices of one longest strictly increasing subsequence of `values` (these keep their place; the rest moved). */
function longestIncreasingKeep(values) {
  const n = values.length;
  const len = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  let best = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) if (values[j] < values[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    if (len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = n ? best : -1; i !== -1; i = prev[i]) keep.add(i);
  return keep;
}

/**
 * @param {"import" | "fullApi"} block
 * @param {string} mod
 * @param {string} id
 */
function lineFor(block, mod, id) {
  if (block === "import") return `import type * as ${id} from "../${mod}.js";`;
  const key = IDENTIFIER.test(mod) ? mod : `"${mod}"`;
  return `${key}: typeof ${id};`;
}

/**
 * @param {"import" | "fullApi"} block
 * @param {string[]} expected generator order
 * @param {Array<{ module: string, id: string }>} actual file order
 * @param {(m: string) => string} identifierOf
 * @returns {ApiProblem[]}
 */
function compareBlock(block, expected, actual, identifierOf) {
  /** @type {ApiProblem[]} */
  const problems = [];
  const where = block === "import" ? "the import block" : "the fullApi block";
  const expectedSet = new Set(expected);
  const seen = new Set();
  const present = [];
  for (const { module, id } of actual) {
    if (seen.has(module)) {
      problems.push({ kind: "duplicate", block, module, message: `${module} appears more than once in ${where}`, fix: `delete the duplicate ${block} line for ${module}` });
      continue;
    }
    seen.add(module);
    if (!expectedSet.has(module)) {
      problems.push({ kind: "extra", block, module, message: `${module} is in ${where} but convex/${module}.* is not a registerable module`, fix: `delete its line from ${where}, or restore the file if it was removed by mistake` });
      continue;
    }
    present.push(module);
    if (id !== identifierOf(module)) {
      problems.push({ kind: "identifier", block, module, message: `${module} is bound to \`${id}\` in ${where}; the generator uses \`${identifierOf(module)}\``, fix: `rename the identifier to ${identifierOf(module)}` });
    }
  }
  for (let i = 0; i < expected.length; i++) {
    const mod = expected[i];
    if (seen.has(mod)) continue;
    const previous = expected[i - 1];
    const placement = previous ? `after the line for "${previous}"` : `at the top of ${where}`;
    problems.push({ kind: "missing", block, module: mod, message: `${mod} exists on disk but is missing from ${where}`, fix: `insert \`${lineFor(block, mod, identifierOf(mod))}\` ${placement}` });
  }
  // Order is judged on the modules both sides know about, so a missing or extra entry is not also reported as a move.
  const position = new Map(expected.map((m, i) => [m, i]));
  const keep = longestIncreasingKeep(present.map((m) => position.get(m)));
  const expectedPresent = expected.filter((m) => seen.has(m));
  present.forEach((module, index) => {
    if (keep.has(index)) return;
    const target = expectedPresent.indexOf(module);
    const before = expectedPresent[target - 1];
    const placement = before ? `directly after the line for "${before}"` : `at the top of ${where}`;
    problems.push({ kind: "order", block, module, message: `${module} is out of generator order in ${where}`, fix: `move \`${lineFor(block, module, identifierOf(module))}\` ${placement}` });
  });
  return problems;
}

/**
 * @param {{ root: string }} options repository root
 * @returns {{ ok: boolean, problems: ApiProblem[], expectedCount: number, actualCount: { import: number, fullApi: number }, convexVersion: string }}
 * @throws when the generated file or the generator internals cannot be read: the caller must report that as FAIL.
 */
export function checkApiDts({ root }) {
  const convexDir = path.join(root, "convex");
  const file = path.join(convexDir, "_generated", "api.d.ts");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file} (api.d.ts): ${error instanceof Error ? error.message : String(error)}`);
  }
  const { moduleIdentifier, version } = loadGeneratorNaming();
  const expected = expectedApiModules(convexDir);
  const parsed = parseApiDts(text);
  const problems = [
    ...compareBlock("import", expected, parsed.imports, moduleIdentifier),
    ...compareBlock("fullApi", expected, parsed.fullApi, moduleIdentifier),
  ];
  return {
    ok: problems.length === 0,
    problems,
    expectedCount: expected.length,
    actualCount: { import: parsed.imports.length, fullApi: parsed.fullApi.length },
    convexVersion: version,
  };
}
