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
