import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { renderCurrentSpec, missingCurrentFunctions } from "./currentSpec.mjs";
import { specProblems } from "./specIndex.mjs";
import { compareContracts } from "./compare.mjs";
import { classifyBreaking } from "./classify.mjs";
import { clientNode } from "./contractTree.mjs";

const cli = path.resolve("scripts/contractSkew/cli.mjs");
const renderer = path.resolve("scripts/contractSkew/renderCurrentSpec.mjs");

function readFunction(spec) {
  const fn = spec.functions.find((entry) => entry.identifier.endsWith(":read"));
  assert.ok(fn, "native read export must be present");
  return fn;
}

function fixture() {
  const cache = path.resolve("node_modules/.cache");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "current-spec-test-"));
  fs.mkdirSync(path.join(root, "convex/nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true,
  } }));
  fs.writeFileSync(path.join(root, "convex/shared.ts"), `import { v } from "convex/values";
export const args = { label: v.string(), sibling: v.optional(v.string()) };`);
  fs.writeFileSync(path.join(root, "convex/nested/functions.ts"), `import { queryGeneric, internalMutationGeneric, actionGeneric } from "convex/server";
import { args } from "../shared";
export const read = queryGeneric({ args, handler: () => { throw Error("HANDLER MUST NOT RUN"); } });
export const write = internalMutationGeneric({ args: {}, handler: () => null });
export const action = actionGeneric({ args: {}, handler: () => null });`);
  fs.writeFileSync(path.join(root, "convex/alias.ts"), 'export { read as renamed } from "./nested/functions";');
  // The SDK itself excludes these; importing either would fail the render.
  fs.writeFileSync(path.join(root, "convex/excluded.test.ts"), 'throw Error("TEST IMPORTED");\nexport {};');
  fs.mkdirSync(path.join(root, "convex/_generated"));
  fs.writeFileSync(path.join(root, "convex/_generated/excluded.ts"), 'throw Error("GENERATED IMPORTED");\nexport {};');
  return root;
}

test("native discovery renders nested, aliased, public/internal and all callable kinds in comparator shape", async () => {
  const root = fixture();
  try {
    const spec = await renderCurrentSpec(root);
    assert.deepEqual(specProblems(spec), []);
    assert.deepEqual(spec.functions.map((fn) => fn.identifier).sort(), [
      "alias.js:renamed", "nested/functions.js:action", "nested/functions.js:read", "nested/functions.js:write",
    ]);
    assert.ok(spec.functions.some((fn) => fn.identifier.endsWith(":write") && fn.visibility.kind === "internal"));
    assert.deepEqual(readFunction(spec).args, {
      type: "object", value: { label: { fieldType: { type: "string" }, optional: false },
        sibling: { fieldType: { type: "string" }, optional: true } },
    });
    assert.deepEqual(missingCurrentFunctions(spec, [{ identifier: "alias:renamed" }, { identifier: "alias:renamed" }]), []);
    assert.deepEqual(missingCurrentFunctions(spec, [{ identifier: "missing:read" }]), ["missing:read"]);

    const call = { identifier: "nested/functions:read", via: "useQuery", file: "app/page.tsx", line: 1,
      siteId: "app/page.tsx:1:1", surface: "web", payload: clientNode.object(new Map([
        ["label", { node: clientNode.scalar("string"), provenance: "LITERAL", optional: false }],
        ["sibling", { node: clientNode.scalar("string"), provenance: "LITERAL", optional: false }],
      ]), true) };
    const deployed = structuredClone(spec);
    delete readFunction(deployed).args.value.label;
    const breaks = compareContracts([call], deployed).breaking;
    assert.equal(breaks.length, 1);
    assert.deepEqual(classifyBreaking(breaks, { currentResult: compareContracts([call], spec) }).callOutcomes,
      { fixed: 1, stillFails: 0, unproven: 0 });
    const stillBroken = structuredClone(spec);
    delete readFunction(stillBroken).args.value.sibling;
    assert.deepEqual(classifyBreaking(breaks, { currentResult: compareContracts([call], stillBroken) }).callOutcomes,
      { fixed: 0, stillFails: 1, unproven: 0 });
    assert.equal(classifyBreaking(breaks, { currentResult: compareContracts([call], deployed) }).standingDefects.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI discards the whole partial current render; missing evidence stays UNPROVEN", () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, "app"));
    fs.writeFileSync(path.join(root, "app/client.ts"), `import { useMutation } from "convex/react";
declare const api: { a: { update: unknown }, b: { update: unknown } };
export function run() { const a = useMutation(api.a.update); const b = useMutation(api.b.update);
a({ label: "new" }); b({}); }`);
    const fn = (identifier, fields) => ({ identifier, functionType: "Mutation", visibility: { kind: "public" }, args: { type: "object", value: fields } });
    fs.writeFileSync(path.join(root, "deployed.json"), JSON.stringify({ functions: [fn("a.js:update", {}), fn("b.js:update", {})] }));
    fs.writeFileSync(path.join(root, "partial.json"), JSON.stringify({ functions: [fn("a.js:update", { label: { fieldType: { type: "string" }, optional: false } })] }));
    fs.writeFileSync(path.join(root, "complete.json"), JSON.stringify({ functions: [
      fn("a.js:update", { label: { fieldType: { type: "string" }, optional: false } }), fn("b.js:update", {}),
    ] }));
    fs.writeFileSync(path.join(root, "baseline.json"), JSON.stringify({ version: 1, entries: [] }));
    for (const extra of [[], ["--current", "partial.json"], ["--current", "complete.json"]]) {
      const run = spawnSync(process.execPath, [cli, "--mode", "production", "--spec", "deployed.json", "--baseline", "baseline.json", "--json", "report.json", ...extra],
        { cwd: root, encoding: "utf8", timeout: 30_000 });
      assert.ifError(run.error);
      assert.equal(run.status, 7, run.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8")).classification.callOutcomes,
        extra.includes("complete.json") ? { fixed: 1, stillFails: 0, unproven: 0 } : { fixed: 0, stillFails: 0, unproven: 1 });
      if (extra.includes("partial.json")) assert.match(run.stderr, /Current spec unavailable/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an unreviewed Convex SDK version refuses before module evaluation", async () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, "node_modules/convex"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/convex/package.json"), JSON.stringify({ name: "convex", version: "99.0.0" }));
    await assert.rejects(renderCurrentSpec(root), /require review for this Convex version/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/** @type {Array<[string, string, {fixed: number, stillFails: number, unproven: number}, boolean?]>} */
const environmentCases = [
  ["environment-blind normal metadata is FIXED", '{ label: v.string() }', { fixed: 1, stillFails: 0, unproven: 0 }],
  ["NODE_ENV-conditioned metadata is UNPROVEN", 'process.env.NODE_ENV === "production" ? {} : { label: v.string() }', { fixed: 0, stillFails: 0, unproven: 1 }],
  ["library NODE_ENV-conditioned metadata is UNPROVEN", 'process.env.NODE_ENV === "production" ? {} : { label: v.string() }', { fixed: 0, stillFails: 0, unproven: 1 }, true],
  ["library environment read with independent args is FIXED", '(process.env.NODE_ENV, { label: v.string() })', { fixed: 1, stillFails: 0, unproven: 0 }, true],
];
for (const [scenario, args, expected, library = false] of environmentCases) {
  test(scenario, async () => {
    const root = fixture();
    try {
      if (library) {
        const pkg = path.join(root, "node_modules/fixture-args");
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ main: "index.js" }));
        fs.writeFileSync(path.join(pkg, "index.js"), `import { v } from "convex/values"; export const args = ${args};`);
      }
      fs.writeFileSync(path.join(root, "convex/unstable.ts"), `import { queryGeneric } from "convex/server";
import { v } from "convex/values";
${library ? 'import { args } from "fixture-args";' : ""}
export const read = queryGeneric({ args: ${library ? "args" : args}, handler: () => process.env.HANDLER_ONLY });`);
      fs.mkdirSync(path.join(root, "app"));
      fs.writeFileSync(path.join(root, "app/client.ts"), `import { useQuery } from "convex/react";
declare const api: { unstable: { read: unknown } };
export function useRead() { return useQuery(api.unstable.read, { label: "new" }); }`);
      fs.writeFileSync(path.join(root, "deployed.json"), JSON.stringify({ functions: [{ identifier: "unstable.js:read",
        functionType: "Query", visibility: { kind: "public" }, args: { type: "object", value: {} } }] }));
      fs.writeFileSync(path.join(root, "current.json"), JSON.stringify(await renderCurrentSpec(root)));
      fs.writeFileSync(path.join(root, "baseline.json"), JSON.stringify({ version: 1, entries: [] }));
      const run = spawnSync(process.execPath, [cli, "--mode", "production", "--spec", "deployed.json",
        "--current", "current.json", "--baseline", "baseline.json", "--json", "report.json"],
      { cwd: root, encoding: "utf8", timeout: 30_000 });
      assert.ifError(run.error);
      assert.equal(run.status, 7, run.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8")).classification.callOutcomes, expected);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("an import failure publishes no partial spec and removes stale output", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "convex/broken.ts"), 'throw Error("IMPORT FAILED");\nexport {};');
    fs.writeFileSync(path.join(root, "current.json"), '{"functions":[]}');
    const run = spawnSync(process.execPath, ["--experimental-vm-modules", renderer, "current.json"], { cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.ifError(run.error);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Current spec unavailable/);
    assert.equal(fs.existsSync(path.join(root, "current.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
