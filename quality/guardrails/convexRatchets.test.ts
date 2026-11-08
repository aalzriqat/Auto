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

import { analyzeSource } from "./ratchets.mjs";
import {
  TIMEOUT,
  baseConfig,
  check,
  expectFailure,
  fixtureRepo,
  remove,
  useFixtureCleanup,
  write,
  writeConfig,
} from "./testkit";

useFixtureCleanup();

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
    const nested = 'import { mutation } from "../functions";\nexport const a = mutation({ handler: async () => null });\n';
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

  test("positive control: a new fully validated public function passes", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/more.ts", `${FN_SERVER}export const fresh = query({ args: { id: v.string() }, returns: v.null(), handler: async () => null });\n`);
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("positive control: moving the unvalidated function to another file passes", async () => {
    const root = fixtureRepo(VALIDATOR_TARGET);
    write(root, "convex/fns.ts", `${FN_SERVER}export const list = query({ args: {}, returns: v.null(), handler: async () => null });\n`);
    write(root, "convex/moved.ts", `${FN_SERVER}export const old = mutation({ handler: async () => null });\n`);
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
    expect(line).toMatch(/^ADVISORY guardrail-9 non-tenant-builder: 3 public queries\/mutations/);
    expect(line).toMatch(/orgQuery\/orgMutation/);
    expect(line).toMatch(/becomes blocking when the tenant builders land/);
  }, TIMEOUT);
});
