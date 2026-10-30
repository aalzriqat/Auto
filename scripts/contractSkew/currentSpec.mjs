/** Native argument metadata only: imports trusted source, never calls handlers. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { indexAllNamed, normalizeIdentifier, specProblems } from "./specIndex.mjs";

/**
 * Native registration metadata uses exportArgs, a private SDK hook. An
 * incompatible upgrade must throw, never publish partial evidence.
 * @param {string} root
 */
export async function renderCurrentSpec(root) {
  const require = createRequire(path.join(root, "package.json"));
  const convexPackage = require.resolve("convex/package.json");
  if (JSON.parse(fs.readFileSync(convexPackage, "utf8")).version !== "1.42.1") {
    throw new Error("Native spec discovery and registration hooks require review for this Convex version");
  }
  const convexRequire = createRequire(convexPackage);
  const { build } = convexRequire("esbuild");
  const dir = path.join(root, "convex");
  const files = discoverModules(dir);
  if (!files.length) throw new Error("No Convex modules discovered");
  const cache = path.join(root, "node_modules/.cache");
  fs.mkdirSync(cache, { recursive: true });
  const temp = fs.mkdtempSync(path.join(cache, "current-spec-"));
  try {
    const outfile = path.join(temp, "modules.cjs");
    // Keep every namespace: tree shaking must not remove uncalled exports.
    const source = files.map((file, i) => `import * as m${i} from ${JSON.stringify(file)};`).join("\n") +
      `\nexport default [${files.map((file, i) => `{ file: ${JSON.stringify(path.relative(dir, file).replace(/\\/g, "/"))}, exports: m${i} }`).join(",")}];`;
    await build({ stdin: { contents: source, resolveDir: root, loader: "ts" },
      outfile, bundle: true, platform: "node", format: "cjs", packages: "external",
      treeShaking: false, ignoreAnnotations: true, logLevel: "silent", tsconfig: path.join(root, "tsconfig.json"),
      // Workspace packages expose TypeScript source and must be bundled too.
      plugins: [{ name: "workspace-source", setup(builder) {
        builder.onResolve({ filter: /^@autoflow\// }, (args) => ({ path: require.resolve(args.path) }));
      } }] });
    const modules = require(outfile).default;
    if (!Array.isArray(modules) || modules.length !== files.length) throw new Error("Incomplete module render");
    const functions = [];
    for (const namespace of modules) {
      for (const [name, fn] of Object.entries(namespace.exports)) {
        if (typeof fn !== "function") continue;
        if (!("isQuery" in fn || "isMutation" in fn || "isAction" in fn || "exportArgs" in fn)) continue;
        const types = [["isQuery", "Query"], ["isMutation", "Mutation"], ["isAction", "Action"]]
          .filter(([flag]) => fn[flag] === true);
        if (types.length !== 1 || typeof fn.exportArgs !== "function" ||
            (fn.isPublic === true) === (fn.isInternal === true)) throw new Error("Unrecognized registered export");
        functions.push({ identifier: `${namespace.file.replace(/\.[^.]+$/, ".js")}:${name}`,
          functionType: types[0][1], visibility: { kind: fn.isPublic === true ? "public" : "internal" },
          args: JSON.parse(fn.exportArgs()) });
      }
    }
    const spec = { functions };
    const problems = specProblems(spec);
    if (!functions.length || problems.length) throw new Error("Incomplete or invalid native argument spec");
    return spec;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
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
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(dir, file);
      if (relative.startsWith("_deps" + path.sep)) throw new Error("Reserved Convex _deps directory");
      if (entry.isDirectory()) {
        if (relative === "_generated" || fs.existsSync(path.join(file, "convex.config.ts"))) continue;
        walk(file);
      } else if (entry.isFile()) {
        if (!/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(entry.name) ||
            entry.name.startsWith(".") || entry.name.startsWith("#") ||
            entry.name === "schema.ts" || entry.name === "schema.js" ||
            entry.name.split(".").length !== 2 || relative.includes(" ")) continue;
        if (/\.tsx?$/.test(file) && !/^\s{0,100}(import|export)/m.test(fs.readFileSync(file, "utf8"))) continue;
        files.push(file);
      } else {
        throw new Error("Unsupported filesystem entry in Convex source");
      }
    }
  };
  walk(dir);
  return files.sort();
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
