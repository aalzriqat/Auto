/** Deployment bundling plus conservative, environment-blind metadata evaluation. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

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
  for (const platform of ["browser", "node"]) {
    if (!groups[platform].length) continue;
    const options = { dir, entryPoints: groups[platform], platform, generateSourceMaps: true,
      chunksFolder: platform === "node" ? path.join("_deps", "node") : "_deps",
      extraConditions: [], includeSourcesContent: false, logLevel: "silent" };
    /** @type {Array<[Map<string, string>, boolean]>} */
    const passes = [[deployment, false], [probe, true]];
    for (const [target, audit] of passes) {
      const plugins = [serverOnlyPlugin, wasmPlugin];
      // NODE_ENV is otherwise folded away before the throwing Proxy can see it.
      // This second, conservative probe is never used as current metadata.
      if (audit) plugins.push(environmentProbe(ts));
      const result = await innerEsbuild({ ...options, plugins });
      recordSources(result.outputFiles, target);
    }
  }
  return { deployment, probe };
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
function environmentProbe(ts) {
  return { name: "environment-blind-probe", setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
      const text = fs.readFileSync(args.path, "utf8");
      const source = ts.createSourceFile(args.path, text, ts.ScriptTarget.Latest, true);
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

/**
 * Fresh context/cache per entry and per pass. Evaluate native ESM unchanged,
 * with an emitted-chunk-only linker, never host package resolution.
 * vm is an evaluator for trusted main, not a security sandbox.
 */
export async function evaluateBundle(bundles, file, metadata) {
  if (typeof vm.SourceTextModule !== "function") throw new Error("Native ESM metadata evaluation requires --experimental-vm-modules");
  const entry = path.resolve("out", file.replace(/\.[^.]+$/, ".js"));
  const probe = await evaluatePass({ modules: bundles.probe, entry, file, metadata });
  return probe.reason ? probe : evaluatePass({ modules: bundles.deployment, entry, file, metadata });
}

/** Any denial, even caught by module code, invalidates this entire entry. */
async function evaluatePass({ modules, entry, file, metadata }) {
  const state = { reason: "" };
  const deny = (reason) => {
    state.reason ||= reason;
    throw new Error("Deployment-dependent module evaluation");
  };
  const context = metadataContext(deny);
  try {
    const namespace = await evaluateEntry(modules, context, deny, entry);
    const functions = metadata({ file, exports: namespace });
    return { functions: state.reason ? [] : functions, reason: state.reason };
  } catch (error) {
    if (!state.reason) throw error;
    return { functions: [], reason: state.reason };
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
function metadataContext(deny) {
    const env = new Proxy({}, {
      get: () => deny("environment read"), ownKeys: () => deny("environment enumeration"),
      has: () => deny("environment membership"), getOwnPropertyDescriptor: () => deny("environment descriptor"),
      set: () => deny("environment write"),
    });
    const { context, protect } = environmentContext(deny, {
      process: new Proxy({ env }, {
        get: (_target, key) => key === "env" ? env : deny("process input"),
        ownKeys: () => deny("process enumeration"), has: () => deny("process membership"),
        getOwnPropertyDescriptor: () => deny("process descriptor"),
      }),
      console: new Proxy({}, { get: () => () => {} }),
      TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers,
      Blob, AbortController, ReadableStream, WritableStream, TransformStream,
      atob, btoa,
      // Even a caught access taints the whole entry's evidence.
      __denyInput: deny,
    });
    vm.runInContext(`
      Date = new Proxy(Date, { apply() { __denyInput("clock"); }, construct() { __denyInput("clock"); },
        get() { return () => __denyInput("clock"); } });
      Math.random = () => __denyInput("randomness");
      crypto = new Proxy({}, { get() { __denyInput("crypto input"); } });
      performance = new Proxy({}, { get() { __denyInput("clock"); } });
      Intl = new Proxy({}, { get() { __denyInput("locale input"); } });
    `, context);
    protect();
    return context;
}

/**
 * Keep language intrinsics in the SAME realm (instanceof must retain meaning).
 * Once initialized, even typeof a missing host/runtime global taints evidence.
 * V8 can mask a global Proxy exception as undefined, hence the latched denial.
 */
function environmentContext(deny, globals) {
  const backing = {};
  /** @type {ProxyHandler<Record<string | symbol, unknown>>} */
  const traps = {};
  const globalProxy = new Proxy(backing, traps);
  const context = vm.createContext(globalProxy, { codeGeneration: { strings: false, wasm: false } });
  const intrinsics = vm.runInContext("Object.getOwnPropertyDescriptors(globalThis)", context);
  delete intrinsics.globalThis;
  Object.defineProperties(backing, intrinsics);
  // Convex functions are server modules; the SDK checks this exact absent global
  // in assertNotBrowser during registration. No other missing global is assumed.
  Object.assign(backing, globals, { globalThis: globalProxy, window: undefined });
  return { context, protect() {
    traps.get = (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : deny(`unavailable global ${String(key)}`);
    traps.has = () => deny("global membership");
    traps.ownKeys = () => deny("global enumeration");
    traps.getOwnPropertyDescriptor = () => deny("global descriptor");
  } };
}
