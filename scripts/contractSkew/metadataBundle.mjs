/** Deployment bundling plus conservative, environment-blind metadata evaluation. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

/** @typedef {{identifier: string, functionType: string, visibility: {kind: string}, args: unknown}} FunctionMetadata */

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
  for (const platform of ["browser", "node"]) {
    if (!groups[platform].length) continue;
    const options = { dir, entryPoints: groups[platform], platform, generateSourceMaps: true,
      chunksFolder: platform === "node" ? path.join("_deps", "node") : "_deps",
      extraConditions: [], includeSourcesContent: false, logLevel: "silent" };
    /** @type {Array<[Map<string, string>, boolean]>} */
    const passes = [[deployment, false], [probe, true]];
    for (const [target, audit] of passes) {
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
    }
  }
  return { deployment, probe, staticReads, dependencies, dir };
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
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        contents = contents.slice(0, edit.start) + "globalThis.process" + contents.slice(edit.end);
      }
      const extension = path.extname(args.path).slice(1);
      const loader = ["mts", "cts"].includes(extension) ? "ts" : ["mjs", "cjs"].includes(extension) ? "js" : extension;
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
    const inputNames = ["process", "__zod_globalConfig", "__zod_globalRegistry"];
    const computedInput = ts.isElementAccessExpression(node) &&
      ["globalThis", "global"].includes(node.expression.getText(source)) &&
      (!ts.isStringLiteral(node.argumentExpression) || inputNames.includes(node.argumentExpression.text));
    // Capturing the global object enables aliases/reflection that cannot be
    // certified by this syntax-only audit; direct intrinsic access stays usable.
    const capturedGlobal = ts.isIdentifier(node) && ["globalThis", "global"].includes(node.text) &&
      !((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node);
    if (computedInput || capturedGlobal || (ts.isIdentifier(node) && inputNames.includes(node.text) &&
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
  for (let index = 0; index < pending.length; index++) {
    const input = pending[index];
    if (visited.has(input)) continue;
    visited.add(input);
    if (bundles.staticReads.has(input)) return `static environment input: ${bundles.staticReads.get(input)}`;
    pending.push(...(graph.get(input) ?? []));
  }
  return "";
}

/**
 * Fresh context/cache per entry and per pass. Evaluate native ESM unchanged,
 * with an emitted-chunk-only linker, never host package resolution.
 * vm is an evaluator for trusted main, not a security sandbox.
 * @returns {Promise<{functions: FunctionMetadata[], reason: string, evaluations: number,
 * staticRefused?: boolean, differentialRefused?: string[], environmentKeys?: string[], enumerations?: number,
 * capabilityProbes?: string[]}>}
 */
export async function evaluateBundle(bundles, file, metadata) {
  if (typeof vm.SourceTextModule !== "function") throw new Error("Native ESM metadata evaluation requires --experimental-vm-modules");
  const reason = staticRefusal(bundles, file);
  if (reason) return { functions: [], reason, staticRefused: true, evaluations: 0 };
  const entry = path.resolve("out", file.replace(/\.[^.]+$/, ".js"));
  const options = { entry, file, metadata };
  const baseline = await evaluatePass({ ...options, modules: bundles.probe });
  if (baseline.reason) return { ...baseline, environmentKeys: [...baseline.keys], capabilityProbes: [...baseline.capabilityProbes], evaluations: 1 };
  return differentialEvaluation(bundles, options, baseline);
}

/** Group keys to bound probing; discovering a new key in a world refuses. */
async function differentialEvaluation(bundles, options, baseline) {
  const keys = [...baseline.keys];
  if (baseline.enumerations && !keys.length) keys.push("__AUTOFLOW_ENV_PROBE__");
  if (keys.length > 32) return { functions: [], reason: "environment key budget exceeded", evaluations: 1 };
  const values = ["production", "development", "test", "true", "false", "1", "0", "", randomUUID()];
  /** @type {Array<{env: Record<string, string | undefined>, runtime?: {userAgent?: string, evalThrows?: boolean}, zodConfig?: boolean}>} */
  const worlds = keys.length || baseline.enumerations ? values.map((value) => ({ env: Object.fromEntries(keys.map((key) => [key, value])) })) : [];
  // Enumerated keys are present even when their values are undefined.
  if (keys.length || baseline.enumerations) worlds.push({ env: Object.fromEntries(keys.map((key) => [key, undefined])) });
  // Exercise the browser-like capability probes independently of env values.
  // The empty-navigator world is also the baseline and deployment world.
  worlds.push({ env: {}, runtime: { userAgent: undefined, evalThrows: true } });
  worlds.push({ env: {}, runtime: { userAgent: "Cloudflare-Workers", evalThrows: false } });
  worlds.push({ env: {}, runtime: { userAgent: "Mozilla/5.0", evalThrows: false } });
  // Supported Zod globals own fresh realm state. Probe preinitialized
  // configuration as well as Zod's own initialization path.
  worlds.push({ env: {}, zodConfig: true });
  const refused = new Set();
  let evaluations = 1;
  let enumerations = baseline.enumerations;
  const capabilityProbes = new Set(baseline.capabilityProbes);
  for (const world of worlds) {
    const result = await evaluatePass({ ...options, modules: bundles.probe, world: world.env, runtime: world.runtime, zodConfig: world.zodConfig });
    evaluations++;
    enumerations += result.enumerations;
    for (const probe of result.capabilityProbes) capabilityProbes.add(probe);
    if (result.reason) return { functions: [], reason: result.reason, evaluations, environmentKeys: keys, enumerations };
    if ([...result.keys].some((key) => !keys.includes(key))) {
      return { functions: [], reason: "environment keys changed across worlds", evaluations, environmentKeys: [...new Set([...keys, ...result.keys])], enumerations };
    }
    compareFunctions(baseline.functions, result.functions, refused);
  }
  const deployed = await evaluatePass({ ...options, modules: bundles.deployment });
  evaluations++;
  enumerations += deployed.enumerations;
  for (const probe of deployed.capabilityProbes) capabilityProbes.add(probe);
  if (deployed.reason) return { functions: [], reason: deployed.reason, evaluations, environmentKeys: keys, enumerations };
  compareFunctions(baseline.functions, deployed.functions, refused);
  return { functions: deployed.functions.filter((fn) => !refused.has(fn.identifier)), reason: "",
    differentialRefused: [...refused], evaluations, environmentKeys: keys, enumerations,
    capabilityProbes: [...capabilityProbes].sort() };
}

/** Compare full registration records, including exportArgs JSON and presence. */
function compareFunctions(baseline, current, refused) {
  const first = new Map(baseline.map((fn) => [fn.identifier, JSON.stringify(fn)]));
  const next = new Map(current.map((fn) => [fn.identifier, JSON.stringify(fn)]));
  for (const id of new Set([...first.keys(), ...next.keys()])) {
    if (first.get(id) !== next.get(id)) refused.add(id);
  }
}

/** Any denial, even caught by module code, invalidates this entire entry. */
async function evaluatePass({ modules, entry, file, metadata, world = {}, runtime = {}, zodConfig = false }) {
  const state = { reason: "" };
  const reads = { keys: new Set(), enumerations: 0, capabilityProbes: new Set() };
  const deny = (reason) => {
    state.reason ||= reason;
    throw new Error("Deployment-dependent module evaluation");
  };
  const context = metadataContext(deny, world, reads, zodConfig, runtime);
  try {
    const namespace = await evaluateEntry(modules, context, deny, entry);
    const functions = metadata({ file, exports: namespace });
    return { functions: state.reason ? [] : functions, reason: state.reason, ...reads };
  } catch (error) {
    if (!state.reason) throw error;
    return { functions: [], reason: state.reason, ...reads };
  }
}

/** Only emitted chunks can satisfy an import; Node package loading is refused. */
async function evaluateEntry(modules, context, deny, entry) {
  const cache = new Map();
  function load(key) {
    if (cache.has(key)) return cache.get(key);
    if (!modules.has(key)) return deny("external or unavailable module");
    const compiled = new vm.SourceTextModule(modules.get(key), { context, identifier: key,
      initializeImportMeta: () => deny("import.meta input"),
      importModuleDynamically: () => deny("dynamic import"),
    });
    cache.set(key, compiled);
    return compiled;
  }
  const compiled = load(entry);
  await compiled.link((specifier, referencing) => {
    if (!specifier.startsWith(".")) return deny("external module");
    return load(path.resolve(path.dirname(referencing.identifier), specifier));
  });
  await compiled.evaluate({ timeout: 1000 });
  return compiled.namespace;
}

/** Read nothing from the calling process; permit handlers to remain uncalled. */
function metadataContext(deny, world, reads, zodConfig, runtime) {
    const record = (key) => {
      if (typeof key !== "string") return deny("unsupported environment key");
      reads.keys.add(key);
    };
    const env = new Proxy(Object.assign(Object.create(null), world), {
      get: (target, key) => { record(key); return target[key]; },
      ownKeys: (target) => { reads.enumerations++; return Reflect.ownKeys(target); },
      has: (target, key) => { record(key); return Object.hasOwn(target, key); },
      getOwnPropertyDescriptor: (target, key) => { record(key); return Reflect.getOwnPropertyDescriptor(target, key); },
      set: () => deny("environment write"),
      defineProperty: () => deny("environment write"), deleteProperty: () => deny("environment write"),
      setPrototypeOf: () => deny("environment write"), preventExtensions: () => deny("environment write"),
    });
    const runtimeReads = reads.capabilityProbes;
    const { context, protect } = environmentContext(deny, {
      process: new Proxy({ env }, {
        get: (_target, key) => key === "env" ? env : deny("process input"),
        ownKeys: () => deny("process enumeration"), has: () => deny("process membership"),
        getOwnPropertyDescriptor: () => deny("process descriptor"),
        set: () => deny("process write"), defineProperty: () => deny("process write"),
        deleteProperty: () => deny("process write"), setPrototypeOf: () => deny("process write"),
        preventExtensions: () => deny("process write"),
      }),
      console: new Proxy({}, { get: () => () => {} }),
      TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers,
      Blob, AbortController, ReadableStream, WritableStream, TransformStream,
      atob, btoa,
      // Even a caught access taints the whole entry's evidence.
      __denyInput: deny,
      ...(runtime.userAgent === undefined ? {} : { navigator: new Proxy({ userAgent: runtime.userAgent }, {
        get: (target, key) => key === "userAgent" ? (runtimeReads.add("navigator.userAgent"), target.userAgent) : deny("unsupported navigator probe"),
        has: (target, key) => key === "userAgent" ? (runtimeReads.add("navigator.userAgent"), true) : deny("unsupported navigator probe"),
        getOwnPropertyDescriptor: (target, key) => key === "userAgent" ? (runtimeReads.add("navigator.userAgent"), Reflect.getOwnPropertyDescriptor(target, key)) : deny("unsupported navigator probe"),
      }) }),
    }, runtimeReads);
    vm.runInContext(`
      globalThis.__zod_globalConfig = ${zodConfig ? "{}" : "undefined"};
      globalThis.__zod_globalRegistry = undefined;
      Date = new Proxy(Date, { apply() { __denyInput("clock"); }, construct() { __denyInput("clock"); },
        // UTC is a pure conversion of its supplied arguments, with no clock or
        // host timezone input. Keep now, parse, construction and calls refused.
        get(target, key) { return key === "UTC" ? target.UTC : () => __denyInput("clock"); } });
      Math.random = () => __denyInput("randomness");
      crypto = new Proxy({}, { get() { __denyInput("crypto input"); } });
      performance = new Proxy({}, { get() { __denyInput("clock"); } });
      Intl = new Proxy({}, { get() { __denyInput("locale input"); } });
      ${runtime.evalThrows ? `Function = new Proxy(Function, {
        apply() { throw new EvalError("Code generation unavailable"); },
        construct() { throw new EvalError("Code generation unavailable"); }
      });
      eval = () => { throw new EvalError("Code generation unavailable"); };` : ""}
    `, context);
    protect();
    return context;
}

/**
 * Keep language intrinsics in the SAME realm (instanceof must retain meaning).
 * Once initialized, even typeof a missing host/runtime global taints evidence.
 * V8 can mask a global Proxy exception as undefined, hence the latched denial.
 */
function environmentContext(deny, globals, runtimeReads) {
  const backing = {};
  /** @type {ProxyHandler<Record<string | symbol, unknown>>} */
  const traps = {};
  const globalProxy = new Proxy(backing, traps);
  const context = vm.createContext(globalProxy, { codeGeneration: { strings: true, wasm: false } });
  const intrinsics = vm.runInContext("Object.getOwnPropertyDescriptors(globalThis)", context);
  delete intrinsics.globalThis;
  Object.defineProperties(backing, intrinsics);
  // Convex functions are server modules; the SDK checks this exact absent global
  // in assertNotBrowser during registration. No other missing global is assumed.
  Object.assign(backing, globals, { globalThis: globalProxy, window: undefined });
  return { context, protect() {
    const capability = (key) => typeof key === "string" && ["navigator", "Function", "eval", "__zod_globalConfig", "__zod_globalRegistry"].includes(key);
    traps.get = (target, key) => {
      if (capability(key)) runtimeReads.add(key);
      if (key === "navigator" && !Reflect.has(target, key)) return undefined;
      return Reflect.has(target, key) ? Reflect.get(target, key) : deny(`unavailable global ${String(key)}`);
    };
    traps.has = (target, key) => capability(key) ? (runtimeReads.add(key), Reflect.has(target, key)) : deny("global membership");
    traps.ownKeys = () => deny("global enumeration");
    traps.getOwnPropertyDescriptor = (target, key) => capability(key) ? (runtimeReads.add(key), Reflect.getOwnPropertyDescriptor(target, key)) : deny("global descriptor");
  } };
}
