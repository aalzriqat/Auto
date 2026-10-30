/** Deployment bundling plus conservative, environment-blind metadata evaluation. */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolveInside } from "./baselineFile.mjs";

/** @typedef {{identifier: string, functionType: string, visibility: {kind: string}, args: unknown}} FunctionMetadata */
/** @typedef {{functions: FunctionMetadata[], reason: string, keys: string[], enumerations: number, capabilityProbes: string[], error?: string}} WorldEntry */

/** Refuse a content-patched SDK even when its version still matches. */
export function refusePatchedConvex(root, require) {
  const { parse } = require("yaml");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const settings = fs.existsSync(workspace) ? parse(fs.readFileSync(workspace, "utf8")) : null;
  for (const patches of [pkg.pnpm?.patchedDependencies, settings?.patchedDependencies]) {
    if (Object.keys(patches ?? {}).some((key) => key === "convex" || key.startsWith("convex@"))) {
      throw new Error("Current spec unavailable: patched Convex requires review");
    }
  }
}

/**
 * Use installed 1.42.1 innerEsbuild, including its production define, resolution
 * conditions, platform defaults, splitting, minification and async-hooks shim.
 * CLI push: components/definition/bundle.ts:674-723; debugBundle.ts:16-97.
 * No external-package resolver is needed for the supported empty allowlist.
 * External imports are never resolved by the evaluating host.
 */
export async function bundleForMetadata({ root, dir, files, convexPackage, require }) {
  const sdk = path.dirname(convexPackage);
  const nativeRequire = createRequire(convexPackage);
  const { innerEsbuild } = nativeRequire(path.join(sdk, "dist/cjs/bundler/debugBundle.js"));
  const { serverOnlyPlugin } = nativeRequire(path.join(sdk, "dist/cjs/bundler/serverOnly.js"));
  const { wasmPlugin } = nativeRequire(path.join(sdk, "dist/cjs/bundler/wasm.js"));
  const ts = require("typescript");
  const configPath = path.join(root, "convex.json");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  if ((config.node?.externalPackages?.length ?? 0) || (config.functions && config.functions !== "convex/")) {
    throw new Error("Current spec unavailable: unsupported Convex bundler configuration");
  }
  const groups = entryPointGroups(dir, files, ts);
  const deployment = new Map();
  const probe = new Map();
  const staticReads = new Map();
  const dependencies = new Map();
  await Promise.all(["browser", "node"].filter((platform) => groups[platform].length).map(async (platform) => {
    const options = { dir, entryPoints: groups[platform], platform, generateSourceMaps: true,
      chunksFolder: platform === "node" ? path.join("_deps", "node") : "_deps",
      extraConditions: [], includeSourcesContent: false, logLevel: "silent" };
    /** @type {Array<[Map<string, string>, boolean]>} */
    const passes = [[deployment, false], [probe, true]];
    await Promise.all(passes.map(async ([target, audit]) => {
      const plugins = [serverOnlyPlugin, wasmPlugin];
      // NODE_ENV is otherwise folded away before the recording Proxy can see it.
      // This second, conservative probe is never used as current metadata.
      if (audit) plugins.push(environmentProbe(ts, root, staticReads));
      const result = await innerEsbuild({ ...options, plugins });
      recordSources(result.outputFiles, target);
      if (audit) {
        const graph = new Map();
        for (const [input, info] of Object.entries(result.metafile.inputs)) {
          graph.set(path.resolve(input), info.imports.filter((item) => !item.external).map((item) => path.resolve(item.path)));
        }
        for (const file of groups[platform]) dependencies.set(path.resolve(file), graph);
      }
    }));
  }));
  return { deployment, probe, staticReads, dependencies, dir, root, ts };
}

/** Keep emitted ESM bytes unchanged; source maps are not executable modules. */
function recordSources(outputs, target) {
  for (const output of outputs) {
    if (!output.path.endsWith(".map")) target.set(path.resolve(output.path), output.text);
  }
}

/** Convex's directive-prologue rule, parsed as syntax rather than substring. */
function entryPointGroups(dir, files, ts) {
  /** @type {{browser: string[], node: string[]}} */
  const groups = { browser: [], node: [] };
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const directives = [];
    for (const statement of source.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      directives.push(statement.expression.text);
    }
    const node = directives.includes("use node");
    const relative = path.relative(dir, file);
    if (node && ["http", "crons", "schema", "auth.config"].includes(relative.replace(/\.[^.]+$/, ""))) {
      throw new Error("Convex requires this entry point to use the isolate runtime");
    }
    if (!node && relative.startsWith("actions" + path.sep)) throw new Error("Convex actions directory requires use node");
    groups[node ? "node" : "browser"].push(file);
  }
  return groups;
}

/** Preserve env accesses through Convex's NODE_ENV constant folding. */
function environmentProbe(ts, root, staticReads) {
  return { name: "environment-blind-probe", setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
      const text = fs.readFileSync(args.path, "utf8");
      const source = ts.createSourceFile(args.path, text, ts.ScriptTarget.Latest, true);
      const relative = path.relative(root, args.path);
      if (!relative.startsWith("..") && !relative.split(path.sep).includes("node_modules")) {
        const location = topLevelInput(ts, source);
        if (location) staticReads.set(path.resolve(args.path), `${relative.replaceAll("\\", "/")}:${location}`);
      }
      const edits = [];
      function visit(node) {
        if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
            ts.isIdentifier(node.expression) && node.expression.text === "process") {
          edits.push({ start: node.expression.getStart(source), end: node.expression.end });
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      let contents = text;
      for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
        contents = contents.slice(0, edit.start) + "globalThis.process" + contents.slice(edit.end);
      }
      const extension = path.extname(args.path).slice(1);
      let loader = extension;
      if (["mts", "cts"].includes(extension)) loader = "ts";
      else if (["mjs", "cjs"].includes(extension)) loader = "js";
      return { contents, loader };
    });
  } };
}

/** Refuse app input references outside function bodies, before tree shaking. */
function topLevelInput(ts, source) {
  let location = 0;
  function visit(node) {
    if (location) return;
    // Declarations/parameters are still inspected; function bodies are not run.
    if (node.parent && ts.isFunctionLike(node.parent) && node.parent.body === node) return;
    const inputNames = new Set(["process", "__zod_globalConfig", "__zod_globalRegistry"]);
    const computedInput = ts.isElementAccessExpression(node) &&
      ["globalThis", "global"].includes(node.expression.getText(source)) &&
      (!ts.isStringLiteral(node.argumentExpression) || inputNames.has(node.argumentExpression.text));
    // Capturing the global object enables aliases/reflection that cannot be
    // certified by this syntax-only audit; direct intrinsic access stays usable.
    const capturedGlobal = ts.isIdentifier(node) && ["globalThis", "global"].includes(node.text) &&
      !((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node);
    if (computedInput || capturedGlobal || (ts.isIdentifier(node) && inputNames.has(node.text) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && node.text === "process" &&
          !["globalThis", "global"].includes(node.parent.expression.getText(source))))) {
      location = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return location;
}

/** Trace each entry's input closure, not shared emitted-chunk membership. */
function staticRefusal(bundles, file) {
  const entry = path.resolve(bundles.dir, file);
  const graph = bundles.dependencies.get(entry);
  if (!graph?.has(entry)) return "static dependency graph unavailable";
  const pending = [entry];
  const visited = new Set();
  for (const input of pending) {
    if (visited.has(input)) continue;
    visited.add(input);
    if (bundles.staticReads.has(input)) return `static environment input: ${bundles.staticReads.get(input)}`;
    pending.push(...(graph.get(input) ?? []));
  }
  return "";
}

/** Evaluate all entries together, in a fresh, bounded process for each world. */
export async function evaluateBundles(bundles, files) {
  const entries = files.map((file) => ({ file, reason: staticRefusal(bundles, file) }));
  const cache = resolveInside(bundles.root, "node_modules/.cache", "metadata temporary directory");
  resolveInside(bundles.root, path.dirname(cache), "metadata temporary parent");
  fs.mkdirSync(cache, { recursive: true });
  resolveInside(bundles.root, fs.realpathSync(cache), "metadata temporary directory");
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(cache), "metadata-worlds-"));
  try {
    const coverage = process.env.NODE_V8_COVERAGE && path.resolve(process.env.NODE_V8_COVERAGE);
    const evaluateWorld = (modules, world) => runWorld({ directory, modules, entries, world, coverage });
    const probe = writeModules(directory, "probe", bundles.probe, bundles.ts);
    const deployment = writeModules(directory, "deployment", bundles.deployment, bundles.ts);
    const baseline = await evaluateWorld(probe, {});
    const keys = new Set(baseline.filter((result) => !result.reason).flatMap((result) => result.keys));
    if (baseline.some((result) => result.enumerations) && !keys.size) keys.add("__AUTOFLOW_ENV_PROBE__");
    const worlds = runtimeWorlds([...keys]);
    // Worlds are independent, but serial execution bounds total child memory to
    // one 1024 MiB heap. Entries inside each world share module/global state.
    const results = await worlds.reduce(async (previous, world) => {
      const completed = await previous;
      completed.push(await evaluateWorld(probe, world));
      return completed;
    }, Promise.resolve(/** @type {WorldEntry[][]} */ ([])));
    const deployed = await evaluateWorld(deployment, {});
    return entries.map((entry, index) => compareWorlds(entry, baseline[index],
      [...results.map((world) => world[index]), deployed[index]], keys));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Native emitted bytes stay unchanged; only the enclosing ESM package is new. */
function writeModules(directory, pass, modules, ts) {
  const root = path.join(directory, pass);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}', { flag: "wx" });
  const paths = [];
  const forbidden = {};
  for (const [name, source] of modules) {
    const relative = path.relative(path.resolve("out"), name);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Emitted module outside bundle directory");
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, { flag: "wx" });
    paths.push(target);
    const reason = unsupportedModuleSyntax(ts, source);
    if (reason) forbidden[target] = reason;
  }
  return { root, paths, forbidden };
}

/** Import metadata and dynamic imports are runtime inputs, never host evidence. */
function unsupportedModuleSyntax(ts, text) {
  const source = ts.createSourceFile("bundle.js", text, ts.ScriptTarget.Latest, true);
  let reason = "";
  function visit(node) {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) reason = "import.meta input";
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) reason = "dynamic import";
    ts.forEachChild(node, visit);
  }
  visit(source);
  return reason;
}

/** No shell, inherited NODE_OPTIONS, credentials or arbitrary Node flags. */
async function runWorld({ directory, modules, entries, world, coverage }) {
  const input = path.join(directory, "world.json");
  fs.writeFileSync(input, JSON.stringify({ modules, entries, world }));
  // Node's coverage collector runs before globals are replaced. Allow only its
  // output path for measurement; never inherit the host env.
  const env = coverage ? { NODE_V8_COVERAGE: coverage } : {};
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--max-old-space-size=1024", fileURLToPath(new URL("./metadataWorld.mjs", import.meta.url))],
    { cwd: directory, env, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  const result = /** @type {WorldEntry[]} */ (JSON.parse(stdout));
  if (!Array.isArray(result) || result.length !== entries.length) throw new Error("Incomplete metadata world");
  for (const entry of result) {
    if (entry.error) throw new Error(entry.error);
  }
  return result;
}

/** Probe supported runtime capabilities independently from grouped env values. */
function runtimeWorlds(keys) {
  const values = ["production", "development", "test", "true", "false", "1", "0", "", randomUUID()];
  /** @type {Array<{env: Record<string, string | null>, runtime?: {userAgent?: string, evalThrows?: boolean}, zodConfig?: boolean}>} */
  const worlds = keys.length ? values.map((value) => ({ env: Object.fromEntries(keys.map((key) => [key, value])) })) : [];
  if (keys.length) worlds.push({ env: Object.fromEntries(keys.map((key) => [key, null])) });
  worlds.push({ env: {}, runtime: { evalThrows: true } },
    { env: {}, runtime: { userAgent: "Cloudflare-Workers", evalThrows: false } },
    { env: {}, runtime: { userAgent: "Mozilla/5.0", evalThrows: false } },
    { env: {}, zodConfig: true });
  return worlds;
}

/** A refusal or new environment key in any world removes the entry's evidence. */
function compareWorlds(entry, baseline, worlds, knownKeys) {
  if (entry.reason) return { functions: [], reason: entry.reason, staticRefused: true, evaluations: 0 };
  const all = [baseline, ...worlds];
  const reason = all.find((world) => world.reason)?.reason ?? "";
  const keys = new Set(all.flatMap((world) => world.keys));
  const newKeys = [...keys].some((key) => !knownKeys.has(key));
  const refused = new Set();
  for (const world of worlds) compareFunctions(baseline.functions, world.functions, refused);
  const failure = reason || (newKeys ? "environment keys changed across worlds" : "");
  return { functions: failure ? [] : worlds.at(-1).functions.filter((fn) => !refused.has(fn.identifier)),
    reason: failure, differentialRefused: [...refused], evaluations: all.length,
    environmentKeys: [...keys], enumerations: all.reduce((sum, world) => sum + world.enumerations, 0),
    capabilityProbes: [...new Set(all.flatMap((world) => world.capabilityProbes))].toSorted(compareStrings) };
}

/** Compare full registration records, including exportArgs JSON and presence. */
function compareFunctions(baseline, current, refused) {
  const first = new Map(baseline.map((fn) => [fn.identifier, JSON.stringify(fn)]));
  const next = new Map(current.map((fn) => [fn.identifier, JSON.stringify(fn)]));
  for (const id of new Set([...first.keys(), ...next.keys()])) {
    if (first.get(id) !== next.get(id)) refused.add(id);
  }
}

/** Stable UTF-16 ordering, independent of the host locale. */
function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
