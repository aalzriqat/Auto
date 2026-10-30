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

test("SCRUM-866 entry isolation preserves sibling metadata; the global rule still refuses missing calls", async () => {
  const root = fixture();
  const flag = "__scrum866HostIsolationProbe";
  assert.equal(Object.hasOwn(TextEncoder, flag), false);
  try {
    fs.writeFileSync(path.join(root, "convex/good.ts"), `import { queryGeneric } from "convex/server";
import { v } from "convex/values";
export const read = queryGeneric({ args: { label: TextEncoder.${flag} ? v.string() : v.number() }, handler: () => null });`);
    const alone = await renderCurrentSpec(root);
    const argsOf = (spec) => spec.functions.find((fn) => fn.identifier === "good.js:read")?.args;
    assert.equal(argsOf(alone), undefined, "observing the host stand-in refuses even without a sibling");
    fs.writeFileSync(path.join(root, "convex/aaBad.ts"), `import { queryGeneric } from "convex/server";
TextEncoder.${flag} = true; Date.now();
export const read = queryGeneric({ args: {}, handler: () => null });`);
    const together = await renderCurrentSpec(root);
    assert.equal(Object.hasOwn(TextEncoder, flag), false, "worlds must never mutate the parent process");
    assert.deepEqual(together.unavailableModules, [
      { file: "aaBad.ts", reason: "synthetic binding reflection" },
      { file: "good.ts", reason: "synthetic binding reflection" },
    ]);
    // Convex analyzes each entry in a fresh context (analyze.rs:283).
    // Missing called entries still trigger the global completeness refusal.
    assert.equal(argsOf(together), undefined);
    assert.deepEqual(readFunction(together).args, readFunction(alone).args, "ordinary sibling metadata remains isolated");
    fs.mkdirSync(path.join(root, "app"));
    fs.writeFileSync(path.join(root, "app/client.ts"), `import { useQuery } from "convex/react";
declare const api: { good: { read: unknown }, aaBad: { read: unknown } };
export function useRead() { useQuery(api.good.read, { label: "new" }); useQuery(api.aaBad.read, {}); }`);
    fs.writeFileSync(path.join(root, "current.json"), JSON.stringify(together));
    fs.writeFileSync(path.join(root, "deployed.json"), '{"functions":[]}');
    fs.writeFileSync(path.join(root, "baseline.json"), '{"version":1,"entries":[]}');
    const run = spawnSync(process.execPath, [cli, "--mode", "production", "--spec", "deployed.json", "--current", "current.json",
      "--baseline", "baseline.json", "--json", "report.json"], { cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.ifError(run.error);
    assert.equal(run.status, 7, run.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8")).classification.callOutcomes,
      { fixed: 0, stillFails: 0, unproven: 2 });
    assert.match(run.stderr, /aaBad\.ts/);
    assert.match(run.stderr, /discarding all current evidence/);
  } finally {
    Reflect.deleteProperty(TextEncoder, flag);
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  ["synthetic random source is UNPROVEN", 'Math.random.toString().includes("deny") ? { label: v.string() } : {}', { fixed: 0, stillFails: 0, unproven: 1 }],
  ["synthetic Math enumerability is UNPROVEN", 'Object.keys(Math).includes("random") ? {} : { label: v.string() }', { fixed: 0, stillFails: 0, unproven: 1 }],
  ["load-time error stack is UNPROVEN", '(new Error().stack ?? "").includes("file:") ? { label: v.string() } : {}', { fixed: 0, stillFails: 0, unproven: 1 }],
  ["abort event clock is UNPROVEN", '(() => { let t = 0; const c = new AbortController(); c.signal.addEventListener("abort", (e) => { t = e.timeStamp; }); c.abort(); return t > 0 ? { label: v.string() } : {}; })()', { fixed: 0, stillFails: 0, unproven: 1 }],
  ["library benign capability probe is FIXED", `(typeof navigator !== "undefined", (() => { try { new Function(""); } catch {} })(), { label: v.string() })`, { fixed: 1, stillFails: 0, unproven: 0 }, true],
  ["library navigator branch is UNPROVEN", `navigator?.userAgent?.includes("Cloudflare") ? {} : { label: v.string() }`, { fixed: 0, stillFails: 0, unproven: 1 }, true],
  ["environment-blind normal metadata is FIXED", '{ label: v.string() }', { fixed: 1, stillFails: 0, unproven: 0 }],
  ["NODE_ENV-conditioned metadata is UNPROVEN", 'process.env.NODE_ENV === "production" ? {} : { label: v.string() }', { fixed: 0, stillFails: 0, unproven: 1 }],
  ["library NODE_ENV-conditioned metadata is UNPROVEN", 'process.env.NODE_ENV === "production" ? {} : { label: v.string() }', { fixed: 0, stillFails: 0, unproven: 1 }, true],
  ["library environment read with independent args is UNPROVEN", '(process.env.NODE_ENV, { label: v.string() })', { fixed: 0, stillFails: 0, unproven: 1 }, true],
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
      const current = await renderCurrentSpec(root);
      fs.writeFileSync(path.join(root, "current.json"), JSON.stringify(current));
      fs.writeFileSync(path.join(root, "baseline.json"), JSON.stringify({ version: 1, entries: [] }));
      const run = spawnSync(process.execPath, [cli, "--mode", "production", "--spec", "deployed.json",
        "--current", "current.json", "--baseline", "baseline.json", "--json", "report.json"],
      { cwd: root, encoding: "utf8", timeout: 30_000 });
      assert.ifError(run.error);
      assert.equal(run.status, 7, run.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8")).classification.callOutcomes, expected);
      if (scenario.startsWith("synthetic")) assert.equal(current.unavailableModules.length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("an empty-message load throw is unavailable, never a successful empty module", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "convex/broken.ts"), 'import { queryGeneric } from "convex/server"; export const read = queryGeneric({ args: {}, handler: () => null }); throw new Error("");');
    const spec = await renderCurrentSpec(root);
    assert.deepEqual(spec.unavailableModules, [{ file: "broken.ts", reason: "Module evaluation failed" }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Error family retains native descriptors except Convex's assigned stack formatter", () => {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import vm from "node:vm";
    import { installConstructorGuards, installGlobals } from ${JSON.stringify(new URL("./metadataGlobals.mjs", import.meta.url).href)};
    import { installObservationGuards } from ${JSON.stringify(new URL("./metadataObservation.mjs", import.meta.url).href)};
    const write = process.stdout.write.bind(process.stdout);
    const finish = process.exit.bind(process);
    const runtimeGlobal = globalThis;
    const apply = Reflect.apply, ownKeys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor;
    const source = Function.prototype.toString;
    const names = ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError"];
    const record = (realm) => {
      const objects = names.flatMap(name => [[name, realm[name]], [name + ".prototype", realm[name].prototype]]);
      const references = new Map(objects.map(([name, object]) => [object, name]));
      const value = (item) => references.has(item) ? { intrinsic: references.get(item) }
        : typeof item === "function" ? { source: apply(source, item, []) } : item;
      return objects.map(([name, object]) => [name, ownKeys(object).map(key => {
        const d = descriptor(object, key);
        return [String(key), Object.fromEntries(ownKeys(d).map(field => [field,
          name === "Error" && key === "prepareStackTrace" && field === "value" ? { formatter: true } : value(d[field])]))];
      })]);
    };
    const reference = vm.runInNewContext("globalThis");
    // errors.ts db914cf0:23 uses plain assignment. ECMAScript
    // OrdinarySetWithOwnDescriptor -> CreateDataProperty gives all three true:
    reference.Error.prepareStackTrace = () => undefined;
    const expected = record(reference);
    const deny = () => { throw new Error("refused"); };
    installConstructorGuards(deny, new Set());
    installGlobals({ target: globalThis, deny, world: {}, reads: { keys: new Set(), enumerations: 0, capabilityProbes: new Set() } });
    installObservationGuards(runtimeGlobal, deny);
    write(JSON.stringify({ expected, exposed: record(globalThis) }), () => finish(0));
  `], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const { expected, exposed } = JSON.parse(run.stdout);
  assert.deepEqual(exposed, expected);
  const formatter = exposed.find(([name]) => name === "Error")[1].find(([key]) => key === "prepareStackTrace")[1];
  // Each attribute follows errors.ts:23's assignment, not Node's absent hook.
  assert.equal(formatter.writable, true); // errors.ts:23; CreateDataProperty
  assert.equal(formatter.enumerable, true); // errors.ts:23; CreateDataProperty
  assert.equal(formatter.configurable, true); // errors.ts:23; CreateDataProperty
});

test("lasting Error family residue refuses its entry without leaking; restored mutations and inheritance register", async () => {
  const root = fixture();
  const names = ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError"];
  const operations = names.flatMap((name) => [
    `Object.defineProperty(${name}, "name", { value: "changed" })`,
    `Object.defineProperty(${name}, "marker", { value: true })`,
    `delete ${name}.name`,
    `${name}.prototype.message = "changed"`,
    `Object.defineProperty(${name}.prototype, "marker", { value: true })`,
    `delete ${name}.prototype.message`,
  ]);
  operations.push('Object.setPrototypeOf(Error, null)', 'Object.preventExtensions(TypeError.prototype)',
    'Error.captureStackTrace = () => undefined', 'Error.stackTraceLimit = 1',
    `const iterate = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function() {
  if (this.length === 6 && this[0] === "value" && this[5] === "configurable") return { next: () => ({ done: true }) };
  return iterate.call(this);
}; Error.prototype.message = "hidden residue"`);
  try {
    const pkg = path.join(root, "node_modules/error-observations");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ type: "module", exports: { "./*": "./*.js" } }));
    for (const [index, operation] of operations.entries()) {
      fs.writeFileSync(path.join(pkg, `${index}.js`), `try { ${operation}; } catch {} export const label = true;`);
      fs.writeFileSync(path.join(root, `convex/error${index}.ts`), `import { queryGeneric } from "convex/server";
import { label } from "error-observations/${index}";
export const read = queryGeneric({ args: {}, handler: () => label });`);
    }
    fs.writeFileSync(path.join(root, "convex/restored.ts"), `import { queryGeneric } from "convex/server";
import { v } from "convex/values";
const previous = Error.prototype.message;
Error.prototype.message = "own change";
const observed = new Error().message;
Error.prototype.message = previous;
export const read = queryGeneric({ args: { label: observed === "own change" ? v.string() : v.number() }, handler: () => null });`);
    fs.writeFileSync(path.join(root, "convex/inheritance.ts"), `import { queryGeneric } from "convex/server";
import { ConvexError } from "convex/values";
class Example extends Error {}
if (Error.prototype.message !== "" || !(new Example() instanceof Error) || !(new ConvexError("test") instanceof Error)) throw new Error("native Error inheritance changed");
export const read = queryGeneric({ args: {}, handler: () => null });`);
    const spec = await renderCurrentSpec(root);
    assert.ok(spec.functions.some((fn) => fn.identifier === "inheritance.js:read"));
    assert.equal(spec.functions.find((fn) => fn.identifier === "restored.js:read")?.args.value.label.fieldType.type, "string");
    assert.deepEqual(spec.functions.filter((fn) => /^error\d+\.js:/.test(fn.identifier)).map((fn) => fn.identifier), []);
    assert.equal(spec.unavailableModules.length, operations.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("bundled prepareStackTrace text refuses replace-format-restore and transitive imports", async () => {
  const root = fixture();
  try {
    const library = path.join(root, "node_modules/stack-observation");
    fs.mkdirSync(library, { recursive: true });
    fs.writeFileSync(path.join(library, "package.json"), '{"main":"index.js"}');
    fs.writeFileSync(path.join(library, "index.js"), `const original = Error.prepareStackTrace;
Error.prepareStackTrace = () => "host frame";
export const label = new Error().stack;
Error.prepareStackTrace = original;`);
    fs.writeFileSync(path.join(root, "convex/stack.ts"), `import { queryGeneric } from "convex/server";
import { label } from "stack-observation";
export const read = queryGeneric({ args: {}, handler: () => label });`);
    const spec = await renderCurrentSpec(root);
    assert.equal(spec.functions.some((fn) => fn.identifier === "stack.js:read"), false);
    assert.deepEqual(spec.unavailableModules, [{ file: "stack.ts", reason: "prepareStackTrace source input" }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native captureStackTrace formatting refuses even when caught; stack binding reads remain native", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "convex/stack.ts"), `import { queryGeneric } from "convex/server";
const captured = {}; Error.captureStackTrace(captured); try { void captured.stack; } catch {}
export const read = queryGeneric({ args: {}, handler: () => null });`);
    fs.writeFileSync(path.join(root, "convex/native.ts"), `import { queryGeneric } from "convex/server";
void Error.captureStackTrace; void Error.stackTraceLimit;
export const read = queryGeneric({ args: {}, handler: () => null });`);
    const spec = await renderCurrentSpec(root);
    assert.ok(spec.functions.some((fn) => fn.identifier === "native.js:read"));
    assert.deepEqual(spec.unavailableModules, [{ file: "stack.ts", reason: "error stack" }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("SCRUM-866 replacement reflection refuses even when caught, across host and callable bindings", async () => {
  const root = fixture();
  const hostOperations = [
    'Object.keys(Math)', 'Object.getOwnPropertyNames(Math)', 'Object.getOwnPropertyDescriptor(Math, "random")',
    'Object.getOwnPropertyDescriptors(Math)', 'Reflect.ownKeys(Math)', 'Reflect.getOwnPropertyDescriptor(Math, "random")',
    '(() => { for (const key in Math) return key; })()', '"random" in Math',
    'Object.prototype.hasOwnProperty.call(Math, "random")', 'JSON.stringify(Math)', 'Object.getPrototypeOf(Math)',
    ...["console", "crypto", "performance", "Intl", "process", "process.env", "Date", "globalThis"]
      .flatMap((host) => [`Object.keys(${host})`, `"anything" in ${host}`, `Object.getOwnPropertyDescriptors(${host})`, `JSON.stringify(${host})`]),
    'Object.defineProperty(globalThis, "Math", { value: {} })', 'delete globalThis.Math',
    'Object.setPrototypeOf(globalThis, {})', 'Object.preventExtensions(globalThis)',
    'new Proxy(Math, {})', 'Proxy.revocable(process.env, {})',
    '"navigator" in globalThis', 'Object.getOwnPropertyDescriptor(globalThis, "navigator")',
    'Object.getOwnPropertyDescriptor(navigator ?? {}, "userAgent")',
    'WeakSet.prototype.has = () => false; (function(){}).toString.call(Math.random)',
    'Reflect.apply = () => "invented"; (function(){}).toString.call(Math.random)',
    'Array.prototype.includes = () => true; Math.random.name',
    'Symbol = { hasInstance: "prototype" }; Math.random.prototype',
  ];
  const callableOperations = ["Math.random", "Date.now", "console.log", "Function", "eval", "Proxy", "Proxy.revocable",
    "TextEncoder", "AbortController", "Object.getOwnPropertyDescriptor", "Reflect.getOwnPropertyDescriptor",
    "Object.prototype.__lookupGetter__", "(function(){}).toString"]
    .flatMap((fn) => [`${fn}.name`, `${fn}.length`, `${fn}.prototype`, `${fn}.toString()`, `String(${fn})`,
      `(function(){}).toString.call(${fn})`, `(function(){}).toString.apply(${fn}, [])`,
      `(function(){}).toString.bind(${fn})()`, `Object.getOwnPropertyDescriptors(${fn})`, `new Proxy(${fn}, {})`]);
  const operations = [...hostOperations, ...callableOperations, 'new Math.random()', 'new Date.now()', 'new console.log()'];
  try {
    for (const [index, operation] of operations.entries()) {
      const library = path.join(root, `node_modules/observation${index}`);
      fs.mkdirSync(library, { recursive: true });
      fs.writeFileSync(path.join(library, "package.json"), '{"main":"index.js"}');
      fs.writeFileSync(path.join(library, "index.js"), `try { ${operation}; } catch {} export const args = {};`);
      fs.writeFileSync(path.join(root, `convex/observation${index}.ts`), `import { queryGeneric } from "convex/server";
import { args } from "observation${index}";
export const read = queryGeneric({ args, handler: () => null });
export const unaffected = queryGeneric({ args: {}, handler: () => null });`);
    }
    const spec = await renderCurrentSpec(root);
    for (const [index, operation] of operations.entries()) {
      assert.ok(spec.unavailableModules.some((entry) => entry.file === `observation${index}.ts`), operation);
      assert.equal(spec.functions.some((fn) => fn.identifier === `observation${index}.js:read`), false, operation);
      assert.equal(spec.functions.some((fn) => fn.identifier === `observation${index}.js:unaffected`), false, operation);
    }
    assert.equal(spec.unavailableModules.length, operations.length);
    assert.equal(spec.evaluation.staticallyRefusedModules, 0, "exercise runtime traps, not the app-source audit");
    assert.equal(readFunction(spec).args.value.label.fieldType.type, "string", "ordinary SDK registration remains available");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unchanged native operations and callable identity topology remain correct", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "convex/identity.ts"), `import { queryGeneric } from "convex/server";
import { v } from "convex/values";
const correct = Date.now === Date.now && console.log === console.log && console.log !== console.error &&
Math.random.call === (function(){}).call && (() => { try { return new Function("") !== new Function(""); } catch { return true; } })();
export const read = queryGeneric({ args: { label: correct ? v.string() : v.number() }, handler: () => null });`);
    const spec = await renderCurrentSpec(root);
    assert.deepEqual(spec.unavailableModules, []);
    assert.equal(spec.functions.find((fn) => fn.identifier === "identity.js:read")?.args.value.label.fieldType.type, "string");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [scenario, source] of [["import failure", 'throw Error("IMPORT FAILED");\nexport {};'],
  ["systemic bundler failure", 'import "missing-build-dependency"; export {};']]) {
test(`${scenario} publishes no partial spec, removes stale output, and leaves every call UNPROVEN`, () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "convex/broken.ts"), source);
    fs.writeFileSync(path.join(root, "current.json"), '{"functions":[]}');
    const run = spawnSync(process.execPath, [renderer, "current.json"], { cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.ifError(run.error);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Current spec unavailable/);
    assert.equal(fs.existsSync(path.join(root, "current.json")), false);
    fs.mkdirSync(path.join(root, "app"));
    fs.writeFileSync(path.join(root, "app/client.ts"), `import { useQuery } from "convex/react";
declare const api: { alias: { renamed: unknown }, broken: { read: unknown } };
export function useRead() { useQuery(api.alias.renamed, { label: "new" }); useQuery(api.broken.read, {}); }`);
    fs.writeFileSync(path.join(root, "deployed.json"), '{"functions":[]}');
    fs.writeFileSync(path.join(root, "baseline.json"), '{"version":1,"entries":[]}');
    const comparison = spawnSync(process.execPath, [cli, "--mode", "production", "--spec", "deployed.json",
      "--baseline", "baseline.json", "--json", "report.json"], { cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.ifError(comparison.error);
    assert.equal(comparison.status, 7, comparison.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8")).classification.callOutcomes,
      { fixed: 0, stillFails: 0, unproven: 2 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
}
