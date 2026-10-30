/** Native argument metadata only: evaluates trusted bundles, never calls handlers. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { indexAllNamed, normalizeIdentifier, specProblems } from "./specIndex.mjs";
import { bundleForMetadata, evaluateBundle, refusePatchedConvex } from "./metadataBundle.mjs";

/**
 * Native registration metadata uses exportArgs, a private SDK hook. An
 * incompatible upgrade must throw, never publish partial evidence.
 * @param {string} root
 */
export async function renderCurrentSpec(root) {
  const require = createRequire(path.join(root, "package.json"));
  refusePatchedConvex(root, require);
  const convexPackage = require.resolve("convex/package.json");
  if (JSON.parse(fs.readFileSync(convexPackage, "utf8")).version !== "1.42.1") {
    throw new Error("Native spec discovery and registration hooks require review for this Convex version");
  }
  const dir = path.join(root, "convex");
  const files = discoverModules(dir);
  if (!files.length) throw new Error("No Convex modules discovered");
  const bundles = await bundleForMetadata({ root, dir, files, convexPackage, require });
  const functions = [];
  const unavailableModules = [];
  /** @type {Array<{file: string, evaluations: number, environmentKeys: string[], enumerations: number, differentialRefused: string[], capabilityProbes: string[]}>} */
  const evaluatedModules = [];
  const evaluation = { staticallyRefusedModules: 0, differentialRefusedFunctions: 0, evaluations: 0, modules: evaluatedModules };
  for (const file of files) {
    const relative = path.relative(dir, file).replaceAll("\\", "/");
    const result = await evaluateBundle(bundles, relative, functionMetadata);
    evaluation.staticallyRefusedModules += result.staticRefused ? 1 : 0;
    evaluation.differentialRefusedFunctions += result.differentialRefused?.length ?? 0;
    evaluation.evaluations += result.evaluations;
    evaluation.modules.push({ file: relative, evaluations: result.evaluations,
      environmentKeys: result.environmentKeys ?? [], enumerations: result.enumerations ?? 0,
      differentialRefused: result.differentialRefused ?? [], capabilityProbes: result.capabilityProbes ?? [] });
    if (result.reason) unavailableModules.push({ file: relative, reason: result.reason });
    else functions.push(...result.functions);
  }
  console.warn(`Current spec: ${unavailableModules.length} module(s) UNPROVEN under environment-blind evaluation (no evidence from those modules).`);
  for (const unavailable of unavailableModules) console.warn(`Current spec UNPROVEN: ${unavailable.file}: ${unavailable.reason}`);
  console.warn(`Current spec: ${evaluation.staticallyRefusedModules} statically refused modules; ${evaluation.differentialRefusedFunctions} differential function refusals; ${evaluation.evaluations} evaluations.`);
  const spec = { functions, unavailableModules, evaluation };
  if (!functions.length || specProblems(spec).length) throw new Error("Incomplete or invalid native argument spec");
  return spec;
}

/**
 * @typedef {Function & {isQuery?: unknown, isMutation?: unknown, isAction?: unknown,
 *   isPublic?: unknown, isInternal?: unknown, exportArgs?: unknown}} RegisteredFunction
 */

/** @param {{file: string, exports: Record<string, unknown>}} namespace */
function functionMetadata(namespace) {
  const functions = [];
  for (const [name, fn] of Object.entries(namespace.exports)) {
    if (!isRegisteredFunction(fn)) continue;
    const kinds = /** @type {const} */ ([["isQuery", "Query"], ["isMutation", "Mutation"], ["isAction", "Action"]]);
    const types = kinds.filter(([flag]) => fn[flag] === true);
    if (types.length !== 1 || typeof fn.exportArgs !== "function" ||
        (fn.isPublic === true) === (fn.isInternal === true)) throw new Error("Unrecognized registered export");
    functions.push({ identifier: `${namespace.file.replace(/\.[^.]+$/, ".js")}:${name}`,
      functionType: types[0][1], visibility: { kind: fn.isPublic === true ? "public" : "internal" },
      args: JSON.parse(fn.exportArgs()) });
  }
  return functions;
}

/** @param {unknown} fn @returns {fn is RegisteredFunction} */
function isRegisteredFunction(fn) {
  return typeof fn === "function" && ("isQuery" in fn || "isMutation" in fn || "isAction" in fn || "exportArgs" in fn);
}

/**
 * Mirrors Convex 1.42.1 src/bundler/index.ts entryPoints. The published private
 * bundler cannot be imported directly (its CLI-only dependencies are bundled).
 * Discover source files, not a generated api.d.ts that may be stale. No list of
 * module or function names: re-exports are read from the imported namespaces.
 * @param {string} dir
 * @returns {string[]}
 */
export function discoverModules(dir) {
  const files = walkModules(dir, dir);
  // Match Array.sort's original UTF-16 ordering, independent of host locale.
  return files.sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

/** @param {string} dir @param {string} directory @returns {string[]} */
function walkModules(dir, directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const relative = path.relative(dir, file);
    if (relative.startsWith("_deps" + path.sep)) throw new Error("Reserved Convex _deps directory");
    if (entry.isDirectory()) {
      if (relative === "_generated" || fs.existsSync(path.join(file, "convex.config.ts"))) continue;
      files.push(...walkModules(dir, file));
    } else if (entry.isFile()) {
      if (isModuleFile(file, relative, entry.name)) files.push(file);
    } else {
      throw new Error("Unsupported filesystem entry in Convex source");
    }
  }
  return files;
}

/** @param {string} file @param {string} relative @param {string} name */
function isModuleFile(file, relative, name) {
  if (!/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(name) ||
      name.startsWith(".") || name.startsWith("#") ||
      name === "schema.ts" || name === "schema.js" ||
      name.split(".").length !== 2 || relative.includes(" ")) return false;
  return !/\.tsx?$/.test(file) || /^\s{0,100}(import|export)/m.test(fs.readFileSync(file, "utf8"));
}

/**
 * A structurally valid JSON document can still be a truncated render. Refuse
 * all current evidence if any resolved client function is absent. Repeated call
 * sites do not require repeated metadata entries. Internal entries are retained
 * so the comparator can still prove an actual public-to-internal defect.
 * @param {any} spec
 * @param {Array<{identifier: string}>} calls
 */
export function missingCurrentFunctions(spec, calls) {
  const ids = new Set([...indexAllNamed(spec).keys()].map(normalizeIdentifier));
  return [...new Set(calls.map((call) => normalizeIdentifier(call.identifier)))].filter((id) => !ids.has(id));
}
