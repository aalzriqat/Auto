// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { discoverModules, missingCurrentFunctions, renderCurrentSpec } from "./currentSpec.mjs";
import { runRenderCurrentSpec } from "./renderCurrentSpec.mjs";
import { specProblems } from "./specIndex.mjs";

const sandboxes: string[] = [];

function fixture() {
  const cache = path.resolve("node_modules/.cache");
  fs.mkdirSync(cache, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(cache, "render-spec-test-"));
  sandboxes.push(sandbox);
  const root = path.join(sandbox, "repository");
  fs.mkdirSync(path.join(root, "convex/nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true,
  } }));
  fs.writeFileSync(path.join(root, "convex/nested/functions.ts"), `
import { queryGeneric, internalMutationGeneric, actionGeneric } from "convex/server";
import { v } from "convex/values";
export const read = queryGeneric({ args: { label: v.string() }, handler: () => { throw Error("HANDLER MUST NOT RUN"); } });
export const write = internalMutationGeneric({ args: {}, handler: () => null });
export const action = actionGeneric({ args: {}, handler: () => null });
export const helper = () => null;
export const constant = 42;
`);
  fs.writeFileSync(path.join(root, "convex/alias.ts"), 'export { read as renamed } from "./nested/functions";');
  return { root, sandbox, output: path.join(root, "current.json") };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

test.each([
  ['process.env.NODE_ENV === "production" ? {} : { label: v.string() }', false],
  ['(process.env.IGNORED, { label: v.string() })', true],
  ['Object.keys(process.env).length ? {} : { label: v.string() }', false],
  ['"NODE_ENV" in process.env ? {} : { label: v.string() }', false],
  ['Object.getOwnPropertyDescriptor(process.env, "NODE_ENV") ? {} : { label: v.string() }', false],
])("library load-time env is compared per function: %s", async (args, stable) => {
  const { root } = fixture();
  const pkg = path.join(root, "node_modules/library-args");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "library-args", main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), `import { v } from "convex/values";
export const args = ${args};`);
  fs.writeFileSync(path.join(root, "convex/library.ts"), `import { queryGeneric } from "convex/server";
import { args } from "library-args";
export const read = queryGeneric({ args, handler: () => null });
export const unaffected = queryGeneric({ args: {}, handler: () => null });`);
  const spec = await renderCurrentSpec(root);
  expect(missingCurrentFunctions(spec, [{ identifier: "library:read" }])).toEqual(stable ? [] : ["library:read"]);
  expect(missingCurrentFunctions(spec, [{ identifier: "library:unaffected" }])).toEqual([]);
  expect(spec.evaluation.differentialRefusedFunctions).toBe(stable ? 0 : 1);
  if (stable) expect(spec.functions.find((fn) => fn.identifier === "library.js:read")?.args).toEqual({
    type: "object", value: { label: { fieldType: { type: "string" }, optional: false } },
  });
});

test.each([
  ['process.env.KEY = "value";', "environment write"],
  ['Object.defineProperty(process.env, "KEY", { value: "value" });', "environment write"],
  ['delete process.env.KEY;', "environment write"],
  ['process.env = {};', "process write"],
  ['Object.defineProperty(process, "env", { value: {} });', "process write"],
  ['delete process.env;', "process write"],
  ['Object.setPrototypeOf(process.env, {});', "environment write"],
  ['Object.preventExtensions(process.env);', "environment write"],
  ['process.env[Symbol.iterator];', "unsupported environment key"],
  ['for (let i = 0; i < 33; i++) process.env["KEY_" + i];', "environment key budget exceeded"],
  ['if (process.env.NODE_ENV) process.env.SECOND;', "environment keys changed across worlds"],
])("unsupported library env operation discards module evidence: %s", async (operation, reason) => {
  const { root } = fixture();
  const pkg = path.join(root, "node_modules/library-refusal");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), `try { ${operation} } catch {} export const args = {};`);
  fs.writeFileSync(path.join(root, "convex/library.ts"), `import { queryGeneric } from "convex/server";
import { args } from "library-refusal";
export const read = queryGeneric({ args, handler: () => null });`);
  const spec = await renderCurrentSpec(root);
  expect(spec.unavailableModules).toEqual([{ file: "library.ts", reason }]);
  expect(missingCurrentFunctions(spec, [{ identifier: "library:read" }])).toEqual(["library:read"]);
});

test("a library error in a differential world discards the render", async () => {
  const { root } = fixture();
  const pkg = path.join(root, "node_modules/library-error");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), `if (process.env.NODE_ENV === "production") throw Error("world failed");
export const args = {};`);
  fs.writeFileSync(path.join(root, "convex/library.ts"), `import { queryGeneric } from "convex/server";
import { args } from "library-error";
export const read = queryGeneric({ args, handler: () => null });`);
  await expect(renderCurrentSpec(root)).rejects.toThrow("world failed");
});

test.each([
  'const args = (process.env.IGNORED, {});',
  'const { env } = process; const args = env.NODE_ENV === "production" ? {} : { label: v.string() };',
  'const args = globalThis.process.env.NODE_ENV === "production" ? {} : { label: v.string() };',
  'const args = globalThis["process"].env.NODE_ENV === "production" ? {} : { label: v.string() };',
  'const args = globalThis.__zod_globalConfig ? {} : { label: v.string() };',
  'const g = globalThis; const p = g.process; void p.env.IGNORED; const args = {};',
  'const g = globalThis; const p = g["process"]; void p.env.IGNORED; const args = {};',
])("repo-local imports refuse top-level environment reads: %s", async (definition) => {
  const { root } = fixture();
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib/args.ts"), `import { v } from "convex/values";
${definition} export { args };`);
  fs.writeFileSync(path.join(root, "convex/local.ts"), `import { queryGeneric } from "convex/server";
import { args } from "../lib/args";
export const read = queryGeneric({ args, handler: () => null });`);
  const spec = await renderCurrentSpec(root);
  expect(missingCurrentFunctions(spec, [{ identifier: "local:read" }])).toEqual(["local:read"]);
  expect(spec.unavailableModules.find((entry) => entry.file === "local.ts")?.reason).toMatch(/static.*lib\/args.ts:2/);
  expect(spec.evaluation.staticallyRefusedModules).toBe(1);
});

test("Zod fresh global config does not suppress unrelated Convex argument evidence", async () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "convex/zod.ts"), `import { queryGeneric } from "convex/server";
import { z } from "zod";
const label = z.string();
export const read = queryGeneric({ args: {}, handler: () => label.parse("ok") });`);
  expect(missingCurrentFunctions(await renderCurrentSpec(root), [{ identifier: "zod:read" }])).toEqual([]);
});

test.each([
  'process.env.NODE_ENV === "production" ? {} : { label: v.string() }',
  'Object.keys(process.env).length ? {} : { label: v.string() }',
  'Date.now() > 0 ? { label: v.string() } : {}',
  'Math.random() > 0 ? { label: v.string() } : {}',
  '"NODE_ENV" in process.env ? {} : { label: v.string() }',
  'Object.getOwnPropertyDescriptor(process.env, "NODE_ENV") ? {} : { label: v.string() }',
  '(process.env.NODE_ENV = "production") ? {} : { label: v.string() }',
  'process.platform === "linux" ? {} : { label: v.string() }',
  'new Date().getTime() > 0 ? {} : { label: v.string() }',
  'crypto.randomUUID() ? {} : { label: v.string() }',
  'performance.now() > 0 ? {} : { label: v.string() }',
  'typeof File === "undefined" ? { label: v.string() } : {}',
  'typeof Buffer === "undefined" ? { label: v.string() } : {}',
  'Date.parse("2020-01-01T00:00:00") > 0 ? { label: v.string() } : {}',
  'typeof module !== "undefined" ? { label: v.string() } : {}',
  'typeof exports !== "undefined" ? { label: v.string() } : {}',
  '"env" in process ? {} : { label: v.string() }',
  'Object.keys(process).length ? {} : { label: v.string() }',
  'Object.getOwnPropertyDescriptor(process, "env") ? {} : { label: v.string() }',
  '"File" in globalThis ? {} : { label: v.string() }',
  'Object.keys(globalThis).length ? {} : { label: v.string() }',
  'Object.getOwnPropertyDescriptor(globalThis, "File") ? {} : { label: v.string() }',
])("load-time deployment input refuses evidence: %s", async (args) => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "convex/unstable.ts"), `import { queryGeneric } from "convex/server";
import { v } from "convex/values";
export const read = queryGeneric({ args: ${args}, handler: () => null });`);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const spec = await renderCurrentSpec(root);
  expect(missingCurrentFunctions(spec, [{ identifier: "unstable:read" }])).toEqual(["unstable:read"]);
  expect(spec.functions.some((fn) => fn.identifier === "nested/functions.js:read")).toBe(true);
  expect(warning.mock.calls.flat().join(" ")).toMatch(/1 module\(s\).*UNPROVEN/);
});

test("a native require shim tainting shared chunks refuses the entire render", async () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "convex/requireBranch.ts"), `import { queryGeneric } from "convex/server";
import { v } from "convex/values";
export const read = queryGeneric({ args: typeof require !== "undefined" ? { label: v.string() } : {}, handler: () => null });`);
  await expect(renderCurrentSpec(root)).rejects.toThrow("Incomplete or invalid native argument spec");
});

test("load-time import.meta supplies no deployment evidence", async () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "convex/meta.ts"), `"use node";
import { actionGeneric } from "convex/server";
import { v } from "convex/values";
export const read = actionGeneric({ args: import.meta.url ? {} : { label: v.string() }, handler: () => null });`);
  expect(missingCurrentFunctions(await renderCurrentSpec(root), [{ identifier: "meta:read" }])).toEqual(["meta:read"]);
});

test("language intrinsics retain same-realm semantics under the global guard", async () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "convex/realm.ts"), `import { queryGeneric } from "convex/server";
import { v } from "convex/values";
export const read = queryGeneric({ args: ({} instanceof Object) && ([] instanceof Array) ? { label: v.string() } : {}, handler: () => null });`);
  expect((await renderCurrentSpec(root)).functions.find((fn) => fn.identifier === "realm.js:read")?.args).toEqual({
    type: "object", value: { label: { fieldType: { type: "string" }, optional: false } },
  });
});

test("caught environment reads still taint metadata; handler reads do not run", async () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "convex/caught.ts"), `import { queryGeneric } from "convex/server";
try { process.env.SECRET; } catch {}
export const read = queryGeneric({ args: {}, handler: () => null });`);
  fs.writeFileSync(path.join(root, "convex/handlerOnly.ts"), `import { queryGeneric } from "convex/server";
console.warn("MODULE DIAGNOSTIC MUST NOT LEAK");
export const read = queryGeneric({ args: {}, handler: () => process.env.SECRET });`);
  const spec = await renderCurrentSpec(root);
  expect(missingCurrentFunctions(spec, [{ identifier: "caught:read" }])).toEqual(["caught:read"]);
  expect(missingCurrentFunctions(spec, [{ identifier: "handlerOnly:read" }])).toEqual([]);
});

test("Node builtin dependencies are unavailable instead of evaluated by host resolution", async () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "convex/builtin.ts"), `"use node";
import { actionGeneric } from "convex/server";
import { randomUUID } from "node:crypto";
export const read = actionGeneric({ args: {}, handler: () => randomUUID() });`);
  const spec = await renderCurrentSpec(root);
  expect(spec.unavailableModules).toEqual([{ file: "builtin.ts", reason: "external module" }]);
});

test("unsupported deployment bundler configuration publishes no evidence", async () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "convex.json"), JSON.stringify({ node: { externalPackages: ["example"] } }));
  await expect(renderCurrentSpec(root)).rejects.toThrow(/unsupported Convex bundler configuration/);
});

test.each([["http.ts", '"use node";'], ["actions/read.ts", ""]])("Convex refuses invalid runtime selection for %s", async (file, directive) => {
  const { root } = fixture();
  const target = path.join(root, "convex", file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${directive}\nimport { actionGeneric } from "convex/server";
export const read = actionGeneric({ args: {}, handler: () => null });`);
  await expect(renderCurrentSpec(root)).rejects.toThrow(/Convex .* (runtime|use node)/);
});

test("conditional package exports use Convex resolution, including Node actions", async () => {
  const { root } = fixture();
  const pkg = path.join(root, "node_modules/conditional-args");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "conditional-args", exports: {
    convex: "./convex.js", node: "./node.js", default: "./default.js",
  } }));
  for (const condition of ["convex", "node", "default"]) {
    fs.writeFileSync(path.join(pkg, `${condition}.js`), `import { v } from "convex/values";
export const args = { ${condition}: v.string() };`);
  }
  for (const [name, directive, kind] of [["condition", "", "query"], ["nodeCondition", '"use node";', "action"]]) {
    fs.writeFileSync(path.join(root, `convex/${name}.ts`), `${directive}
import { ${kind}Generic } from "convex/server";
import { args } from "conditional-args";
export const read = ${kind}Generic({ args, handler: () => process.env.HANDLER_ONLY });`);
  }
  const spec = await renderCurrentSpec(root);
  for (const id of ["condition.js:read", "nodeCondition.js:read"]) {
    expect(spec.functions.find((fn) => fn.identifier === id)?.args).toEqual({
      type: "object", value: { convex: { fieldType: { type: "string" }, optional: false } },
    });
  }
});

test("static refusal follows each platform's conditional workspace import graph", async () => {
  const { root } = fixture();
  const pkg = path.join(root, "packages/runtime-args");
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(pkg, path.join(root, "node_modules/runtime-args"), "junction");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ exports: {
    browser: "./browser.ts", node: "./node.ts",
  } }));
  fs.writeFileSync(path.join(pkg, "browser.ts"), 'const ignored = process.env.UNUSED; export const args = {};');
  fs.writeFileSync(path.join(pkg, "node.ts"), 'export const args = {};');
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib/args.ts"), 'export { args } from "runtime-args";');
  for (const [name, directive, kind] of [["browserGraph", "", "query"], ["nodeGraph", '"use node";', "action"]]) {
    fs.writeFileSync(path.join(root, `convex/${name}.ts`), `${directive}
import { ${kind}Generic } from "convex/server";
import { args } from "../lib/args";
export const read = ${kind}Generic({ args, handler: () => null });`);
  }
  const spec = await renderCurrentSpec(root);
  expect(missingCurrentFunctions(spec, [{ identifier: "browserGraph:read" }])).toEqual(["browserGraph:read"]);
  expect(missingCurrentFunctions(spec, [{ identifier: "nodeGraph:read" }])).toEqual([]);
});

test.each(["package", "workspace"])("patched Convex in %s refuses even at the pinned version", async (location) => {
  const { root } = fixture();
  if (location === "package") {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ pnpm: { patchedDependencies: { "convex@1.42.1": "patches/convex.patch" } } }));
  } else {
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'patchedDependencies:\n  "convex@1.42.1": patches/convex.patch\n');
  }
  await expect(renderCurrentSpec(root)).rejects.toThrow(/patched Convex/);
});

test("native render retains aliases and callable metadata without running handlers", async () => {
  const { root } = fixture();
  const spec = await renderCurrentSpec(root);
  expect(specProblems(spec)).toEqual([]);
  expect(spec.functions).toEqual([
    { identifier: "alias.js:renamed", functionType: "Query", visibility: { kind: "public" },
      args: { type: "object", value: { label: { fieldType: { type: "string" }, optional: false } } } },
    { identifier: "nested/functions.js:action", functionType: "Action", visibility: { kind: "public" }, args: { type: "object", value: {} } },
    { identifier: "nested/functions.js:read", functionType: "Query", visibility: { kind: "public" },
      args: { type: "object", value: { label: { fieldType: { type: "string" }, optional: false } } } },
    { identifier: "nested/functions.js:write", functionType: "Mutation", visibility: { kind: "internal" }, args: { type: "object", value: {} } },
  ]);
  expect(missingCurrentFunctions(spec, [{ identifier: "alias:renamed" }, { identifier: "alias.js:renamed" }])).toEqual([]);
  expect(missingCurrentFunctions(spec, [{ identifier: "missing:read" }, { identifier: "missing.js:read" }])).toEqual(["missing:read"]);
});

test("discovery preserves UTF-16 sort order and Convex exclusions", () => {
  const { root } = fixture();
  const dir = path.join(root, "convex");
  for (const name of ["zulu.ts", "apple.ts", "Zebra.ts", "_.ts", "é.ts", "schema.ts", "schema.js", ".hidden.ts", "#temp.ts", "read.test.ts", "with space.ts", "plain.ts", "notes.txt"]) {
    fs.writeFileSync(path.join(dir, name), name === "plain.ts" ? "const x = 1;" : "export {};");
  }
  for (const name of ["_generated", "component"]) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, "ignored.ts"), "export {};");
  }
  fs.writeFileSync(path.join(dir, "component/convex.config.ts"), "export {};");
  fs.mkdirSync(path.join(dir, "A"));
  fs.writeFileSync(path.join(dir, "A/read.ts"), "export {};");
  const names = discoverModules(dir).map((file) => path.relative(dir, file).replaceAll("\\", "/"));
  expect(names).toEqual(["A/read.ts", "Zebra.ts", "_.ts", "alias.ts", "apple.ts", "nested/functions.ts", "zulu.ts", "é.ts"]);
});

test("CLI publishes complete JSON atomically at an in-root absolute path", async () => {
  const { root, output } = fixture();
  fs.writeFileSync(output, "stale");
  fs.writeFileSync(`${output}.tmp`, "stale partial output");
  expect(await runRenderCurrentSpec(output, root)).toBe(0);
  expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual(await renderCurrentSpec(root));
  expect(fs.existsSync(`${output}.tmp`)).toBe(false);
});

test("a temporary file appearing at write time refuses publication", async () => {
  const { root, output } = fixture();
  const write = fs.writeFileSync;
  // Inject only the external filesystem race; the renderer and write both run.
  vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (file === `${output}.tmp`) write(file, "concurrent file");
    return write(file, data, options);
  });
  expect(await runRenderCurrentSpec("current.json", root)).toBe(1);
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.existsSync(`${output}.tmp`)).toBe(false);
});

test.each([
  ["import failure", 'export {}; throw Error("IMPORT FAILED");'],
  ["unrecognized registration", 'export function broken() {} broken.isQuery = true;'],
  ["invalid validator JSON", 'export function broken() {} broken.isQuery = true; broken.isPublic = true; broken.exportArgs = () => "not json";'],
  ["invalid argument spec", 'export function broken() {} broken.isQuery = true; broken.isPublic = true; broken.exportArgs = () => "{}";'],
])("%s removes stale and temporary evidence", async (_scenario, source) => {
  const { root, output } = fixture();
  fs.writeFileSync(path.join(root, "convex/broken.ts"), source);
  fs.writeFileSync(output, "stale");
  fs.writeFileSync(`${output}.tmp`, "partial");
  expect(await runRenderCurrentSpec("current.json", root)).toBe(1);
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.existsSync(`${output}.tmp`)).toBe(false);
});

test("unreviewed SDK and empty source both refuse metadata", async () => {
  const { root } = fixture();
  fs.mkdirSync(path.join(root, "node_modules/convex"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/convex/package.json"), '{"name":"convex","version":"99.0.0"}');
  await expect(renderCurrentSpec(root)).rejects.toThrow("require review for this Convex version");
  const empty = fixture();
  fs.rmSync(path.join(empty.root, "convex"), { recursive: true });
  fs.mkdirSync(path.join(empty.root, "convex"));
  await expect(renderCurrentSpec(empty.root)).rejects.toThrow("No Convex modules discovered");
});

test("reserved dependency directories and filesystem links refuse discovery", () => {
  const { root, sandbox } = fixture();
  const dir = path.join(root, "convex");
  fs.mkdirSync(path.join(dir, "_deps"));
  fs.writeFileSync(path.join(dir, "_deps/read.ts"), "export {};");
  expect(() => discoverModules(dir)).toThrow("Reserved Convex _deps directory");
  fs.rmSync(path.join(dir, "_deps"), { recursive: true });
  fs.symlinkSync(sandbox, path.join(dir, "linked"), "junction");
  expect(() => discoverModules(dir)).toThrow("Unsupported filesystem entry");
});

test.each(["../outside.json", "../repository-sibling/out.json", "absolute", " ", "bad\0path"])("refuses unsafe output %s before changing outside files", async (candidate) => {
  const { root, sandbox } = fixture();
  const outside = path.join(sandbox, "outside.json");
  fs.writeFileSync(outside, "untouched");
  expect(await runRenderCurrentSpec(candidate === "absolute" ? outside : candidate, root)).toBe(1);
  expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
  expect(fs.existsSync(`${outside}.tmp`)).toBe(false);
});

test.each(["parent", "temporary"])("refuses %s junction escapes and preserves their targets", async (kind) => {
  const { root, sandbox, output } = fixture();
  const outside = path.join(sandbox, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.json"), "untouched");
  fs.writeFileSync(output, "stale");
  const link = kind === "parent" ? path.join(root, "linked") : `${output}.tmp`;
  fs.symlinkSync(outside, link, "junction");
  expect(await runRenderCurrentSpec(kind === "parent" ? "linked/new.json" : "current.json", root)).toBe(1);
  expect(fs.readdirSync(outside)).toEqual(["keep.json"]);
  expect(fs.readFileSync(path.join(outside, "keep.json"), "utf8")).toBe("untouched");
  if (kind === "temporary") expect(fs.existsSync(output)).toBe(false);
});

test("missing output and unwritable output fail with non-success status", async () => {
  const { root } = fixture();
  expect(await runRenderCurrentSpec(undefined, root)).toBe(2);
  fs.mkdirSync(path.join(root, "directory.json"));
  expect(await runRenderCurrentSpec("directory.json", root)).toBe(1);
});

test("CLI discards partial current metadata; absent evidence keeps calls UNPROVEN", () => {
  const { root } = fixture();
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "app/client.ts"), `import { useMutation } from "convex/react";
declare const api: { a: { update: unknown }, b: { update: unknown } };
export function run() { const a = useMutation(api.a.update); const b = useMutation(api.b.update);
a({ label: "new" }); b({}); }`);
  const fn = (identifier: string, fields: Record<string, unknown>) => ({ identifier, functionType: "Mutation", visibility: { kind: "public" }, args: { type: "object", value: fields } });
  const updated = fn("a.js:update", { label: { fieldType: { type: "string" }, optional: false } });
  fs.writeFileSync(path.join(root, "deployed.json"), JSON.stringify({ functions: [fn("a.js:update", {}), fn("b.js:update", {})] }));
  fs.writeFileSync(path.join(root, "partial.json"), JSON.stringify({ functions: [updated] }));
  fs.writeFileSync(path.join(root, "complete.json"), JSON.stringify({ functions: [updated, fn("b.js:update", {})] }));
  fs.writeFileSync(path.join(root, "baseline.json"), '{"version":1,"entries":[]}');
  for (const current of [undefined, "partial.json", "complete.json"]) {
    const extra = current ? ["--current", current] : [];
    const run = spawnSync(process.execPath, [path.resolve("scripts/contractSkew/cli.mjs"), "--mode", "production", "--spec", "deployed.json", "--baseline", "baseline.json", "--json", "report.json", ...extra], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(7);
    expect(JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8")).classification.callOutcomes).toEqual(
      current === "complete.json" ? { fixed: 1, stillFails: 0, unproven: 0 } : { fixed: 0, stillFails: 0, unproven: 1 },
    );
    if (current === "partial.json") expect(run.stderr).toContain("Current spec unavailable");
  }
});

test("CLI refuses an output outside its repository without changing that file", () => {
  const cache = path.resolve("node_modules/.cache");
  fs.mkdirSync(cache, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(cache, "render-refusal-"));
  const root = path.join(sandbox, "repository");
  fs.mkdirSync(path.join(root, "convex"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "convex/read.ts"), 'import { queryGeneric } from "convex/server"; export const read = queryGeneric({ args: {}, handler: () => null });');
  const outside = path.join(sandbox, "outside.json");
  fs.writeFileSync(outside, "leave this evidence alone");
  try {
    const run = spawnSync(process.execPath, [path.resolve("scripts/contractSkew/renderCurrentSpec.mjs"), "../outside.json"], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(1);
    expect(fs.readFileSync(outside, "utf8")).toBe("leave this evidence alone");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
