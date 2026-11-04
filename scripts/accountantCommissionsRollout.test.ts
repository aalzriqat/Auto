import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { runAccountantCommissionsPhase } from "./releaseGuard";

type Input = Parameters<typeof runAccountantCommissionsPhase>[0];
const SECRET = "private-role-and-org";
const page = (updatedCount = 0, isDone = true, continueCursor = "end") => ({
  updatedCount, isDone, continueCursor, updates: Array.from({ length: updatedCount }, () => SECRET),
});
const deadline = { now: () => 0, startedAt: 0, timeoutMs: 1000 };
const run = (convex: Input["convex"], overrides: Partial<Input> = {}) => runAccountantCommissionsPhase({
  convex, ...deadline, log: () => {}, fail: (reason) => { throw new Error(reason); }, ...overrides,
});

test("SCRUM-908: commission phase sends the exact cursor contract and publishes only counts", () => {
  const answers = [page(1, false, "c1"), page(0, false, "c2"), page(2, true, "end")];
  const calls: string[][] = [];
  const logs: string[] = [];
  const summary = run((args) => {
    calls.push(args);
    return { ok: true, value: answers[calls.length - 1] };
  }, { log: (message) => logs.push(message) });
  expect(calls).toEqual([null, "c1", "c2"].map((cursor) => ["run", "migrateRoles:backfillAccountantCommissionsAccess", JSON.stringify({ cursor, numItems: 100 })]));
  expect(summary).toBe("3 stored ACCOUNTANT roles granted view:commissions in 3 page call(s). Only unmarked roles matching the exact pre-change ACCOUNTANT template were changed.");
  expect(summary).not.toContain(SECRET);
  expect(logs).toEqual(["Granting view:commissions to unmarked default ACCOUNTANT roles…", `  ${summary}`]);
  expect(logs.join()).not.toContain(SECRET);
  expect(run(() => ({ ok: true, value: page() }))).toContain("0 stored ACCOUNTANT roles");
});

test.each([
  null, {}, { ...page(), isDone: "true" }, { ...page(), continueCursor: null },
  { ...page(), updatedCount: -1 }, { ...page(), updatedCount: NaN }, { ...page(), updatedCount: 1.5 },
  page(101), { ...page(1), updates: [] }, { ...page(), updates: SECRET }, { ...page(), updates: [SECRET] },
])("SCRUM-908: malformed commission backfill evidence refuses without backend detail (%#)", (value) => {
  expect(() => run(() => ({ ok: true, value }))).toThrow(/ACCOUNTANT commissions backfill.*unrecognised/);
  try { run(() => ({ ok: true, value })); } catch (error) { expect(String(error)).not.toContain(SECRET); }
});

test("SCRUM-908: failed commission calls, stalled cursors and the page cap refuse", () => {
  expect(() => run(() => ({ ok: false, reason: SECRET }))).toThrow("Production is DEPLOYED, but the ACCOUNTANT commissions backfill call failed. See backend logs; a re-run resumes it.");
  expect(() => run(() => ({ ok: true, value: page(0, false, "same") }))).toThrow(/cursor stopped advancing/);
  let calls = 0;
  expect(() => run(() => ({ ok: true, value: page(0, false, `c${++calls}`) }))).toThrow(/page cap/);
  expect(calls).toBe(10_000);
});

test("SCRUM-908: commission phase uses the shared deadline before and after its call", () => {
  const convex = vi.fn(() => ({ ok: true as const, value: page() }));
  expect(() => run(convex, { now: () => 1001 })).toThrow(/deadline/);
  expect(convex).not.toHaveBeenCalled();
  let now = 0;
  expect(() => run(() => { now = 1001; return { ok: true, value: page() }; }, { now: () => now })).toThrow(/deadline/);
});

test("SCRUM-908: a commission failure handler that returns still cannot produce a success summary", () => {
  const fail = vi.fn() as unknown as Input["fail"];
  expect(() => run(() => ({ ok: false, reason: SECRET }), { fail })).toThrow(/fail handler returned/);
  expect(fail).toHaveBeenCalledTimes(1);
});

test("SCRUM-908: deploy wiring repairs commissions before cost and publishes the helper's counts only", () => {
  const source = readFileSync(path.join(__dirname, "rolloutRelease.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const invocation = "accountantCommissionsSummary = runAccountantCommissionsPhase({ convex, now: Date.now, startedAt: rolloutStartedAt, timeoutMs: TIMEOUT_MS, fail, log: console.log });";
  expect(source).toContain(invocation);
  expect(source.match(/runAccountantCommissionsPhase\(/g)).toHaveLength(1);
  expect(source.indexOf("const supplierIdentity = repairAndVerifySupplierIdentity(")).toBeLessThan(source.indexOf(invocation));
  expect(source.indexOf(invocation)).toBeLessThan(source.indexOf("accountantCostPriceSummary = runAccountantCostPricePhase("));
  expect(source.indexOf("accountantCostPriceSummary = runAccountantCostPricePhase(")).toBeLessThan(source.indexOf("console.log(`Verifying the rollout"));
  expect(source).toContain("if (accountantCommissionsSummary) body += `\\n### ACCOUNTANT commissions backfill\\n\\n${accountantCommissionsSummary}\\n`;");
  expect(source).not.toMatch(/\bupdates\b|migrateRoles:/);
  const backend = readFileSync(path.join(__dirname, "..", "convex", "migrateRoles.ts"), "utf8");
  expect(backend).toMatch(/export const backfillAccountantCommissionsAccess = internalMutation\(/);
});
