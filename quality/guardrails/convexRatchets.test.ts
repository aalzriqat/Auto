// @vitest-environment node
/**
 * SCRUM-418 section 6, guardrails 9, 10 and 11, the Convex-specific ratchets:
 *   10  bounded reads    .collect() and .filter( on a database query chain
 *   11  validators       public functions without `args` / without `returns`
 *   9   tenant builders  advisory only until orgQuery/orgMutation exist
 * Sources: https://docs.convex.dev/understanding/best-practices/ (".filter on
 * database queries", "Only use .collect with a small number of results") and
 * https://docs.convex.dev/functions/validation.
 */
import { describe, expect, test } from "vitest";

import { analyzeSource, analyzeTree } from "./ratchets.mjs";
import {
  TIMEOUT,
  baseConfig,
  check,
  expectFailure,
  fixtureRepo,
  remove,
  registerFixtureCleanup,
  write,
  writeConfig,
} from "./testkit";

registerFixtureCleanup();

type Kind =
  | "query-collect"
  | "query-filter"
  | "no-args-validator"
  | "no-returns-validator"
  | "non-tenant-builder"
  | "public-functions";
const count = (kind: Kind, source: string, file = "convex/x.ts"): number => analyzeSource(file, source)[kind];

const SERVER = 'import { query, mutation, action, internalQuery } from "./_generated/server";\nimport { v } from "convex/values";\n';

describe("bounded reads: .collect() and .filter( on a query chain (guardrail 10)", () => {
  test("collect: every zero-argument .collect() call in a convex file", () => {
    expect(count("query-collect", 'export const a = async (ctx) => ctx.db.query("t").collect();')).toBe(1);
    expect(count("query-collect", 'export const a = async (ctx) => ctx.db.query("t").withIndex("i", (q) => q.eq("a", 1)).order("desc").collect();')).toBe(1);
    expect(count("query-collect", "const q = ctx.db.query('t'); const rows = await q.collect(); const more = await q.collect();")).toBe(2);
    expect(count("query-collect", 'const a = await ctx.db.query("t").take(5); const b = await ctx.db.query("t").first();')).toBe(0);
    expect(count("query-collect", "// ctx.db.query('t').collect()\nconst s = 'ctx.db.query(\"t\").collect()';")).toBe(0);
  });

  test("filter: a database query chain is counted, an array filter is not", () => {
    expect(count("query-filter", 'const a = ctx.db.query("t").filter((q) => q.eq(q.field("a"), 1));')).toBe(1);
    expect(count("query-filter", 'const a = ctx.db.query("t").withIndex("i").order("asc").filter((q) => q.gt(q.field("n"), 2)).take(3);')).toBe(1);
    expect(count("query-filter", 'const a = db.query("t").filter((q) => q.eq(q.field("a"), 1));')).toBe(1);
    expect(count("query-filter", "const a = rows.filter((r) => r.active);")).toBe(0);
    expect(count("query-filter", 'const a = (await ctx.db.query("t").collect()).filter((r) => r.active);')).toBe(0);
    expect(count("query-filter", 'const a = (await ctx.db.query("t").take(9)).filter((r) => r.active);')).toBe(0);
    expect(count("query-filter", "const a = items.map((i) => i.id).filter(Boolean);")).toBe(0);
  });

  test("filter: a query held in a variable, or passed in as a parameter, is still a query chain", () => {
    expect(count("query-filter", 'const q = ctx.db.query("t"); const a = q.filter((x) => x.eq(x.field("a"), 1));')).toBe(1);
    expect(count("query-filter", 'const q = ctx.db.query("t").order("desc"); const r = q.withIndex("i"); const a = r.filter((x) => x.eq(x.field("a"), 1));')).toBe(1);
    expect(count("query-filter", 'const f = (q: Q) => q.filter((b) => b.eq(b.field("a"), 1));')).toBe(1);
  });

  test("reads are only counted in convex/ files", () => {
    const source = 'export const a = async (ctx) => ctx.db.query("t").filter((q) => q.eq(q.field("a"), 1)).collect();';
    expect(count("query-collect", source, "lib/x.ts")).toBe(0);
    expect(count("query-filter", source, "components/x.tsx")).toBe(0);
  });
});

describe("validators on public functions (guardrail 11)", () => {
  test("a complete public function has neither gap", () => {
    const src = `${SERVER}export const list = query({ args: { id: v.string() }, returns: v.null(), handler: async () => null });\n`;
    expect(count("public-functions", src)).toBe(1);
    expect(count("no-args-validator", src)).toBe(0);
    expect(count("no-returns-validator", src)).toBe(0);
  });

  test("missing args and missing returns are counted separately", () => {
    const noReturns = `${SERVER}export const a = query({ args: {}, handler: async () => null });\n`;
    const noArgs = `${SERVER}export const b = mutation({ returns: v.null(), handler: async () => null });\n`;
    const neither = `${SERVER}export const c = action({ handler: async () => null });\n`;
    expect([count("no-args-validator", noReturns), count("no-returns-validator", noReturns)]).toEqual([0, 1]);
    expect([count("no-args-validator", noArgs), count("no-returns-validator", noArgs)]).toEqual([1, 0]);
    expect([count("no-args-validator", neither), count("no-returns-validator", neither)]).toEqual([1, 1]);
  });

  test("the bare-handler form and a config the checker cannot see both count as missing", () => {
    expect([
      count("no-args-validator", `${SERVER}export const a = query(async (ctx) => null);\n`),
      count("no-returns-validator", `${SERVER}export const a = query(async (ctx) => null);\n`),
    ]).toEqual([1, 1]);
    const spread = `${SERVER}const base = { args: {} };\nexport const b = query({ ...base, handler: async () => null });\n`;
    expect([count("no-args-validator", spread), count("no-returns-validator", spread)]).toEqual([1, 1]);
    const shorthand = `${SERVER}const args = {};\nconst returns = v.null();\nexport const c = query({ args, returns, handler: async () => null });\n`;
    expect([count("no-args-validator", shorthand), count("no-returns-validator", shorthand)]).toEqual([0, 0]);
  });

  test("internal functions are not public and are not counted", () => {
    const src = `${SERVER}import { internalMutation } from "./functions";\nexport const a = internalQuery({ handler: async () => null });\nexport const b = internalMutation({ handler: async () => null });\n`;
    expect(count("public-functions", src)).toBe(0);
    expect(count("no-args-validator", src)).toBe(0);
  });

  test("builders are resolved from their imports: aliases, the functions.ts wrappers and namespaces", () => {
    const aliased = 'import { query as q } from "./_generated/server";\nexport const a = q({ handler: async () => null });\n';
    expect(count("no-args-validator", aliased)).toBe(1);
    const wrapped = 'import { mutation, socialBulkMutation } from "./functions";\nexport const a = mutation({ handler: async () => null });\nexport const b = socialBulkMutation({ args: {}, handler: async () => null });\n';
    expect([count("public-functions", wrapped), count("no-args-validator", wrapped), count("no-returns-validator", wrapped)]).toEqual([2, 1, 2]);
    const nested = 'import { mutation } from "../../../functions";\nexport const a = mutation({ handler: async () => null });\n';
    expect(count("public-functions", nested, "convex/domains/deals/commands/close.ts")).toBe(1);
    const ns = 'import * as server from "./_generated/server";\nexport const a = server.query({ handler: async () => null });\n';
    expect(count("no-args-validator", ns)).toBe(1);
  });

  test("a call that merely shares a name, or a function that is not exported, is not a public function", () => {
    expect(count("public-functions", 'const query = (x: unknown) => x;\nexport const a = query({ handler: 1 });\n')).toBe(0);
    expect(count("public-functions", `${SERVER}const hidden = query({ handler: async () => null });\n`)).toBe(0);
    expect(count("public-functions", `${SERVER}const shown = query({ handler: async () => null });\nexport { shown };\n`)).toBe(1);
    expect(count("public-functions", `${SERVER}export default query({ handler: async () => null });\n`)).toBe(1);
  });

  test("validators are only counted in convex/ files", () => {
    expect(count("public-functions", `${SERVER}export const a = query({ handler: async () => null });\n`, "lib/x.ts")).toBe(0);
  });
});

describe("tenant builders are advisory (guardrail 9)", () => {
  test("counts public queries and mutations, not actions, not internal, not orgQuery/orgMutation", () => {
    const src = [
      SERVER,
      'import { orgQuery, orgMutation } from "./functions";',
      "export const a = query({ handler: async () => null });",
      "export const b = mutation({ handler: async () => null });",
      "export const c = action({ handler: async () => null });",
      "export const d = internalQuery({ handler: async () => null });",
      "export const e = orgQuery({ args: {}, returns: v.null(), handler: async () => null });",
      "export const f = orgMutation({ args: {}, returns: v.null(), handler: async () => null });",
    ].join("\n");
    expect(count("non-tenant-builder", src)).toBe(2);
    expect(count("public-functions", src)).toBe(5);
    expect(count("no-args-validator", src)).toBe(3);
  });
});

const READ_TARGET = {
  "convex/reads.ts": 'export const one = (ctx: C) => ctx.db.query("t").collect();\nexport const two = (ctx: C) => ctx.db.query("t").filter((q) => q.eq(q.field("a"), 1)).take(1);\n',
  "convex/other.ts": "export const none = 1;\n",
};

describe("bounded-read ratchet against the trusted target tree", () => {
  test("negative control: one more .collect() fails with the per-file delta", async () => {
    const root = fixtureRepo(READ_TARGET);
    write(root, "convex/other.ts", 'export const more = (ctx: C) => ctx.db.query("u").collect();\n');
    const result = await check(root);
    expectFailure(result.errors, /^UNBOUNDED-READ-GROWN query-collect: 2 > target 1 \(\+1\)\n {2}convex\/other\.ts: 0 -> 1$/);
    expect(result.errors).toHaveLength(1);
  }, TIMEOUT);

  test("negative control: one more .filter( on a query chain fails", async () => {
    const root = fixtureRepo(READ_TARGET);
    write(root, "convex/other.ts", 'export const more = (ctx: C) => ctx.db.query("u").filter((q) => q.eq(q.field("b"), 2)).take(1);\n');
    const result = await check(root);
    expectFailure(result.errors, /^UNBOUNDED-READ-GROWN query-filter: 2 > target 1 \(\+1\)/);
  }, TIMEOUT);

  test("positive control: an indexed bounded read and an array filter pass", async () => {
    const root = fixtureRepo(READ_TARGET);
    write(
      root,
      "convex/other.ts",
      'export const ok = async (ctx: C) => {\n  const rows = await ctx.db.query("u").withIndex("by_a", (q) => q.eq("a", 1)).take(50);\n  return rows.filter((r) => r.active);\n};\n',
    );
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("positive control: moving a .collect() to another file passes", async () => {
    const root = fixtureRepo(READ_TARGET);
    write(root, "convex/reads.ts", 'export const two = (ctx: C) => ctx.db.query("t").filter((q) => q.eq(q.field("a"), 1)).take(1);\n');
    write(root, "convex/other.ts", 'export const one = (ctx: C) => ctx.db.query("t").collect();\n');
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("positive control: removing a .collect() passes and offers the tighter total", async () => {
    const root = fixtureRepo(READ_TARGET);
    remove(root, "convex/reads.ts");
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.notices.some((n) => n.startsWith("ratchet can tighten: query-collect 1 -> 0"))).toBe(true);
  }, TIMEOUT);

  test("a new .collect() in a test file or a non-convex file is not counted", async () => {
    const root = fixtureRepo(READ_TARGET);
    write(root, "convex/reads.test.ts", 'export const t = (ctx: C) => ctx.db.query("t").collect();\n');
    write(root, "components/Rows.tsx", "export const r = (q: Q) => q.collect();\n");
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);
});

const FN_SERVER = 'import { query, mutation } from "./_generated/server";\nimport { v } from "convex/values";\n';
const VALIDATOR_TARGET = {
  "convex/fns.ts": `${FN_SERVER}export const list = query({ args: {}, returns: v.null(), handler: async () => null });\nexport const old = mutation({ handler: async () => null });\n`,
};

describe("validator ratchet against the trusted target tree", () => {
  test("negative control: a new public function without args or returns fails on both kinds", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/more.ts", `${FN_SERVER}export const fresh = query({ handler: async () => null });\n`);
    const result = await check(root);
    expectFailure(result.errors, /^VALIDATOR-GAP-GROWN no-args-validator: 2 > target 1 \(\+1\)\n {2}convex\/more\.ts: 0 -> 1$/);
    expectFailure(result.errors, /^VALIDATOR-GAP-GROWN no-returns-validator: 2 > target 1 \(\+1\)/);
  }, TIMEOUT);

  test("negative control: dropping `returns` from an existing function fails", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/fns.ts", `${FN_SERVER}export const list = query({ args: {}, handler: async () => null });\nexport const old = mutation({ handler: async () => null });\n`);
    const result = await check(root);
    expectFailure(result.errors, /^VALIDATOR-GAP-GROWN no-returns-validator: 2 > target 1/);
  }, TIMEOUT);

  test.each(["convex/migrateOld.ts", "convex/data.ts"])(
    "negative control: a new public function without `returns` in %s (excused from the size limit only) fails",
    async (listed) => {
      const root = fixtureRepo(VALIDATOR_TARGET);
      const moduleId = listed.replace(/\.ts$/u, "");
      write(root, listed, `${FN_SERVER}export const run = mutation({ args: {}, handler: async () => null });\n`);
      const result = await check(root);
      expectFailure(result.errors, /^VALIDATOR-GAP-GROWN no-returns-validator: 2 > target 1 \(\+1\)/);
      expectFailure(result.errors, new RegExp(`^VALIDATOR-GAP-NEW-FUNCTION[^\\n]*\\n {2}${moduleId}:run: missing returns$`));
    },
    TIMEOUT,
  );

  test("positive control: a new fully validated public function passes", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/more.ts", `${FN_SERVER}export const fresh = query({ args: { id: v.string() }, returns: v.null(), handler: async () => null });\n`);
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("negative control: moving an unvalidated function to another file makes it a new function and fails", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/fns.ts", `${FN_SERVER}export const list = query({ args: {}, returns: v.null(), handler: async () => null });\n`);
    write(root, "convex/moved.ts", `${FN_SERVER}export const old = mutation({ handler: async () => null });\n`);
    const result = await check(root);
    expect(result.errors).toEqual([
      "VALIDATOR-GAP-NEW-FUNCTION: 1 public function(s) new on the target must declare both args and returns\n  convex/moved:old: missing args, returns",
    ]);
  }, TIMEOUT);

  test("positive control: moving a fully validated function to another file passes", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/fns.ts", `${FN_SERVER}export const old = mutation({ handler: async () => null });\n`);
    write(root, "convex/moved.ts", `${FN_SERVER}export const list = query({ args: {}, returns: v.null(), handler: async () => null });\n`);
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("positive control: fixing the old function passes and offers the tighter totals", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/fns.ts", `${FN_SERVER}export const list = query({ args: {}, returns: v.null(), handler: async () => null });\nexport const old = mutation({ args: {}, returns: v.null(), handler: async () => null });\n`);
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.notices.some((n) => n.startsWith("ratchet can tighten: no-args-validator 1 -> 0"))).toBe(true);
  }, TIMEOUT);

  test("internal functions are not required to carry validators", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/more.ts", 'import { internalQuery } from "./_generated/server";\nexport const i = internalQuery({ handler: async () => null });\n');
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);
});

describe("validators per public function (guardrail 11)", () => {
  const FIXED_OLD = `${FN_SERVER}export const list = query({ args: {}, returns: v.null(), handler: async () => null });\nexport const old = mutation({ args: {}, returns: v.null(), handler: async () => null });\n`;

  test("negative control: fixing an old function while adding a new unvalidated one keeps the totals equal and still fails", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/fns.ts", FIXED_OLD);
    write(root, "convex/more.ts", `${FN_SERVER}export const fresh = query({ handler: async () => null });\n`);
    const result = await check(root);
    expect(result.ratchets?.pr["no-args-validator"]).toBe(result.ratchets?.target["no-args-validator"]);
    expect(result.ratchets?.pr["no-returns-validator"]).toBe(result.ratchets?.target["no-returns-validator"]);
    expect(result.errors).toEqual([
      "VALIDATOR-GAP-NEW-FUNCTION: 1 public function(s) new on the target must declare both args and returns\n  convex/more:fresh: missing args, returns",
    ]);
  }, TIMEOUT);

  test("negative control: a new function missing only args, or only returns, fails", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/fns.ts", FIXED_OLD);
    write(root, "convex/a.ts", `${FN_SERVER}export const noArgs = query({ returns: v.null(), handler: async () => null });\nexport const noReturns = query({ args: {}, handler: async () => null });\n`);
    const result = await check(root);
    expect(result.errors).toEqual([
      "VALIDATOR-GAP-NEW-FUNCTION: 2 public function(s) new on the target must declare both args and returns\n  convex/a:noArgs: missing args\n  convex/a:noReturns: missing returns",
    ]);
  }, TIMEOUT);

  test("negative control: a new default export is keyed as module:default", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/fns.ts", FIXED_OLD);
    write(root, "convex/d.ts", `${FN_SERVER}export default query({ handler: async () => null });\n`);
    const result = await check(root);
    expectFailure(result.errors, /^VALIDATOR-GAP-NEW-FUNCTION[^\n]*\n {2}convex\/d:default: missing args, returns$/);
  }, TIMEOUT);

  test("negative control: removing a validator from an existing function fails even when another gains one", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(
      root,
      "convex/fns.ts",
      `${FN_SERVER}export const list = query({ handler: async () => null });\nexport const old = mutation({ args: {}, returns: v.null(), handler: async () => null });\n`,
    );
    const result = await check(root);
    expect(result.ratchets?.pr["no-args-validator"]).toBe(result.ratchets?.target["no-args-validator"]);
    expect(result.errors).toEqual([
      "VALIDATOR-REMOVED: 1 existing public function(s) lost a validator they had on the target\n  convex/fns:list: lost args, returns",
    ]);
  }, TIMEOUT);

  test("positive control: an existing unvalidated function that stays as it is passes, and a new validated one passes", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/more.ts", `${FN_SERVER}export const fresh = query({ args: {}, returns: v.null(), handler: async () => null });\n`);
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("positive control: a new internal function needs no validators", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/more.ts", 'import { internalMutation } from "./_generated/server";\nexport const quiet = internalMutation({ handler: async () => null });\n');
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);
});
const HELPERS = 'import { customQuery, customMutation, customAction } from "convex-helpers/server/customFunctions";\n';

describe("public functions built with convex-helpers custom builders (guardrails 9 and 11)", () => {
  const authed = `${SERVER}${HELPERS}const authedQuery = customQuery(query, { args: {}, input: async () => ({ ctx: {}, args: {} }) });\n`;

  test("a function built by a custom builder bound to a public builder is a public function", () => {
    const src = `${authed}export const a = authedQuery({ handler: async () => null });\nexport const b = authedQuery({ args: {}, returns: v.null(), handler: async () => null });\n`;
    expect([count("public-functions", src), count("no-args-validator", src), count("no-returns-validator", src)]).toEqual([2, 1, 1]);
    expect(count("non-tenant-builder", src)).toBe(2);
  });

  test("the custom builder definition itself is not a public function, exported or not", () => {
    const src = `${SERVER}${HELPERS}export const authedMutation = customMutation(mutation, { args: {}, input: async () => ({ ctx: {}, args: {} }) });\n`;
    expect(count("public-functions", src)).toBe(0);
  });

  test("a custom builder over an internal builder is not public", () => {
    const src = `${SERVER}${HELPERS}const q = customQuery(internalQuery, { args: {}, input: async () => ({ ctx: {}, args: {} }) });\nexport const a = q({ handler: async () => null });\n`;
    expect(count("public-functions", src)).toBe(0);
  });

  test("custom builders chain, and the namespace import and a plain alias are followed", () => {
    const chained = `${authed}const adminQuery = customQuery(authedQuery, { args: {}, input: async () => ({ ctx: {}, args: {} }) });\nexport const a = adminQuery({ handler: async () => null });\n`;
    expect(count("public-functions", chained)).toBe(1);
    const namespace = `${SERVER}import * as helpers from "convex-helpers/server/customFunctions";\nconst m = helpers.customMutation(mutation, { args: {}, input: async () => ({ ctx: {}, args: {} }) });\nexport const a = m({ handler: async () => null });\n`;
    expect(count("public-functions", namespace)).toBe(1);
    const alias = `${SERVER}const q = query;\nexport const a = q({ handler: async () => null });\n`;
    expect(count("public-functions", alias)).toBe(1);
  });

  test("a custom action is public but is not a tenant-builder candidate", () => {
    const src = `${SERVER}${HELPERS}const a = customAction(action, { args: {}, input: async () => ({ ctx: {}, args: {} }) });\nexport const run = a({ handler: async () => null });\n`;
    expect([count("public-functions", src), count("non-tenant-builder", src)]).toEqual([1, 0]);
  });

  test("a customQuery that does not come from convex-helpers is not a builder", () => {
    const src = `${SERVER}const customQuery = (b: unknown) => b;\nconst q = customQuery(query);\nexport const a = q({ handler: async () => null });\n`;
    expect(count("public-functions", src)).toBe(0);
  });

  test("builders are followed across modules: import, re-export, export list and star export", () => {
    const tree = analyzeTree(
      new Map([
        ["convex/builders.ts", `${authed}export { authedQuery };\n`],
        ["convex/reexport.ts", 'export { authedQuery as guardedQuery } from "./builders";\n'],
        ["convex/star.ts", 'export * from "./reexport";\n'],
        ["convex/direct.ts", 'import { authedQuery } from "./builders";\nexport const d = authedQuery({ handler: async () => null });\n'],
        ["convex/viaRename.ts", 'import { guardedQuery } from "./reexport";\nexport const r = guardedQuery({ handler: async () => null });\n'],
        ["convex/viaStar.ts", 'import { guardedQuery } from "./star";\nexport const s = guardedQuery({ handler: async () => null });\n'],
        ["convex/viaNamespace.ts", 'import * as b from "./builders";\nexport const n = b.authedQuery({ args: {}, returns: null, handler: async () => null });\n'],
      ]),
    );
    const publicFunctions = (file: string) => tree.get(file)["public-functions"];
    expect(["builders", "reexport", "star"].map((f) => publicFunctions(`convex/${f}.ts`))).toEqual([0, 0, 0]);
    expect(["direct", "viaRename", "viaStar", "viaNamespace"].map((f) => publicFunctions(`convex/${f}.ts`))).toEqual([1, 1, 1, 1]);
    expect(tree.get("convex/viaStar.ts").functions.map((f: { key: string }) => f.key)).toEqual(["convex/viaStar:s"]);
    expect(tree.get("convex/viaNamespace.ts")["no-args-validator"]).toBe(0);
  });

  test("a builder module outside the counted scope still resolves for the files that use it", () => {
    const tree = analyzeTree(
      new Map([["convex/uses.ts", 'import { authedQuery } from "./builders";\nexport const d = authedQuery({ handler: async () => null });\n']]),
      new Map([["convex/builders.ts", `${authed}export { authedQuery };\n`]]),
    );
    expect(tree.get("convex/uses.ts")["public-functions"]).toBe(1);
    expect(tree.has("convex/builders.ts")).toBe(false);
  });

  test("cyclic re-exports terminate", () => {
    const tree = analyzeTree(
      new Map([
        ["convex/a.ts", 'export { x } from "./b";\nimport { x as y } from "./b";\nexport const f = y({ handler: 1 });\n'],
        ["convex/b.ts", 'export { x } from "./a";\n'],
      ]),
    );
    expect(tree.get("convex/a.ts")["public-functions"]).toBe(0);
  });
});

describe("custom builder functions through the whole checker", () => {
  const BUILDERS = `${FN_SERVER}import { customQuery } from "convex-helpers/server/customFunctions";\nexport const authedQuery = customQuery(query, { args: {}, input: async () => ({ ctx: {}, args: {} }) });\n`;

  test("negative control: a new unvalidated function built by a custom builder fails the per-function rule", async () => {
    const root = fixtureRepo({ ...VALIDATOR_TARGET, "convex/builders.ts": BUILDERS });
    write(root, "convex/more.ts", 'import { authedQuery } from "./builders";\nexport const fresh = authedQuery({ handler: async () => null });\n');
    const result = await check(root);
    expectFailure(result.errors, /^VALIDATOR-GAP-NEW-FUNCTION[^\n]*\n {2}convex\/more:fresh: missing args, returns$/);
    expectFailure(result.errors, /^VALIDATOR-GAP-GROWN no-args-validator: 2 > target 1 \(\+1\)/);
  }, TIMEOUT);

  test("positive control: a fully validated function built by a custom builder passes", async () => {
    const root = fixtureRepo({ ...VALIDATOR_TARGET, "convex/builders.ts": BUILDERS });
    write(root, "convex/more.ts", 'import { v } from "convex/values";\nimport { authedQuery } from "./builders";\nexport const fresh = authedQuery({ args: {}, returns: v.null(), handler: async () => null });\n');
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);
});
describe("the Convex ratchet allowances cannot be raised from the PR tree", () => {
  test("negative control: a PR-side exemption cannot hide a new .collect() or an unvalidated function", async () => {
    const root = fixtureRepo({ ...READ_TARGET, ...VALIDATOR_TARGET });
    const config = baseConfig();
    config.exemptions.push({ path: "convex/sneaky.ts", reason: "attempting to exempt itself" });
    writeConfig(root, config);
    write(root, "convex/sneaky.ts", `${FN_SERVER}export const s = query({ handler: async (ctx) => ctx.db.query("t").collect() });\n`);
    const result = await check(root);
    expectFailure(result.errors, /^UNBOUNDED-READ-GROWN query-collect: 2 > target 1/);
    expectFailure(result.errors, /^VALIDATOR-GAP-GROWN no-args-validator: 2 > target 1/);
  }, TIMEOUT);
});

describe("tenant builders report without blocking", () => {
  test("a new public query is reported in the advisory and does not fail the check", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/more.ts", `${FN_SERVER}export const fresh = query({ args: {}, returns: v.null(), handler: async () => null });\n`);
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.ratchets?.pr["non-tenant-builder"]).toBe(3);
    expect(result.ratchets?.target["non-tenant-builder"]).toBe(2);
    const line = (result.advisories ?? []).find((a: string) => a.includes("non-tenant-builder")) ?? "";
    expect(result.ratchets?.pr["public-functions"]).toBe(3);
    expect(line).toMatch(/^ADVISORY guardrail-9 non-tenant-builder: 3 of 3 public functions are queries\/mutations/);
    expect(line).toMatch(/\(target 2 of 2\)/);
    expect(line).toMatch(/actions are exempt/);
    expect(line).toMatch(/orgQuery\/orgMutation/);
    expect(line).toMatch(/becomes blocking when the tenant builders land/);
  }, TIMEOUT);
});
