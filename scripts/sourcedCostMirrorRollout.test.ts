import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { backfillSourcedCostMirrorRollout, runSourcedCostMirrorPhase } from "./releaseGuard";

const secret = "private_backend_text";
const page = (updated = 0, isDone = true, continueCursor = "end") => ({
  scanned: 2, updated, skippedLocked: 0, skippedInvalid: 0, isDone, continueCursor,
});
type Input = Parameters<typeof backfillSourcedCostMirrorRollout>[0];
const run = (runPage: Input["runPage"], overrides: Partial<Input> = {}) => {
  const result = backfillSourcedCostMirrorRollout({
    runPage, now: () => 0, startedAt: 0, timeoutMs: 1000, maxPages: 3, ...overrides,
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  return result;
};

describe("SCRUM-907 sourced cost mirror rollout", () => {
  test("walks cursor pages and totals only measured counts; rerun changes zero rows", () => {
    const cursors: (string | null)[] = [];
    expect(run(cursor => {
      cursors.push(cursor);
      return { ok: true, value: page(1, cursors.length === 2, "next") };
    })).toEqual({ ok: true, pages: 2, scanned: 4, updated: 2, skippedLocked: 0, skippedInvalid: 0 });
    expect(cursors).toEqual([null, "next"]);
    expect(run(() => ({ ok: true, value: page() }))).toMatchObject({ ok: true, updated: 0 });
  });

  test.each([
    null, {}, { ...page(), scanned: -1 }, { ...page(), scanned: 26 }, { ...page(), updated: NaN },
    { ...page(), updated: 1.5 }, { ...page(), skippedLocked: -1 }, { ...page(), skippedInvalid: 3 },
    { ...page(2), skippedLocked: 1 }, { ...page(), isDone: "true" }, { ...page(), continueCursor: null },
  ])("refuses malformed evidence without printing backend data: %j", value => {
    expect(run(() => ({ ok: true, value: value && { ...value, raw: secret } }))).toMatchObject({ ok: false, reason: expect.stringContaining("unrecognised") });
  });

  test("refuses failed calls without forwarding backend text", () => {
    expect(run(() => ({ ok: false, reason: secret }))).toMatchObject({ ok: false, reason: expect.stringContaining("call failed") });
  });

  test("refuses stuck cursors and page-cap exhaustion", () => {
    expect(run(() => ({ ok: true, value: page(0, false, "same") }))).toMatchObject({ ok: false, reason: expect.stringContaining("stopped advancing") });
    expect(run(() => ({ ok: true, value: page(0, false, "next") }), { maxPages: 1 })).toMatchObject({ ok: false });
  });

  test("refuses both an expired deadline and a terminal page that finishes late", () => {
    let now = 0;
    expect(run(() => { throw new Error("must not run"); }, { now: () => 1001 })).toMatchObject({ ok: false });
    expect(run(() => {
      now = 1001;
      return { ok: true, value: page() };
    }, { now: () => now })).toMatchObject({ ok: false, reason: expect.stringContaining("deadline") });
  });

  test.each(["skippedLocked", "skippedInvalid"])("refuses outstanding %s rows with counts only", key => {
    const result = run(() => ({ ok: true, value: { ...page(), [key]: 1, raw: secret } }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("INCOMPLETE") });
  });

  test("phase constructs the internal command, shares the deadline and renders a counts-only summary", () => {
    const calls: string[][] = [];
    const summary = runSourcedCostMirrorPhase({
      convex: args => { calls.push(args); return { ok: true, value: page(1) }; },
      now: () => 0, startedAt: 0, timeoutMs: 1000, fail: reason => { throw new Error(reason); },
    });
    expect(calls).toEqual([["run", "vehicles:backfillSourcedCostMirror", JSON.stringify({ cursor: null, numItems: 25 })]]);
    expect(summary).toBe("Checked 2 vehicles in 1 page call(s); repaired 1 SOURCED cost mirrors; locked 0; invalid 0.");
  });

  test("phase forwards a safe refusal to fail", () => {
    expect(() => runSourcedCostMirrorPhase({
      convex: () => ({ ok: false, reason: secret }), now: () => 0, startedAt: 0, timeoutMs: 1000,
      fail: reason => { expect(reason).not.toContain(secret); throw new Error(reason); },
    })).toThrow(/call failed/);
  });

  test("rollout invokes the tested phase after accountant repair and before inbox verification", () => {
    const source = readFileSync(path.join(__dirname, "rolloutRelease.mjs"), "utf8");
    const invocation = source.indexOf("sourcedCostMirrorSummary = runSourcedCostMirrorPhase({ convex, now: Date.now, startedAt: rolloutStartedAt, timeoutMs: TIMEOUT_MS, fail });");
    expect(invocation).toBeGreaterThan(source.indexOf("accountantCostPriceSummary = runAccountantCostPricePhase("));
    expect(invocation).toBeLessThan(source.indexOf("console.log(`Verifying the rollout"));
    expect(source).toContain("### SOURCED cost mirrors");
  });
});
