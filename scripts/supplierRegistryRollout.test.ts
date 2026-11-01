import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { initialiseSupplierRegistry, opaqueOrgRef, type RegistryStep as Step } from "./releaseGuard";

/** A fake deployment: `rows` orgs, `deleting` of which are being deleted and never get a registry row. */
function fakeDeployment(input: { live: string[]; deleting?: string[]; pageSize?: number; backfillBroken?: boolean }) {
  const pageSize = input.pageSize ?? 2;
  const doomed = new Set(input.deleting ?? []);
  const all = [...input.live, ...doomed];
  const hasRow = new Set<string>();
  const calls = { backfill: [] as (string | null)[], verify: [] as (string | null)[] };
  const slice = (cursor: string | null) => {
    const start = cursor === null ? 0 : Number(cursor);
    const end = Math.min(start + pageSize, all.length);
    return { ids: all.slice(start, end), isDone: end >= all.length, continueCursor: String(end) };
  };
  const backfillPage = (cursor: string | null): Step => {
    calls.backfill.push(cursor);
    const page = slice(cursor);
    let migrated = 0;
    for (const id of page.ids) {
      if (input.backfillBroken || doomed.has(id) || hasRow.has(id)) continue;
      hasRow.add(id);
      migrated += 1;
    }
    return { ok: true, value: { migrated, isDone: page.isDone, continueCursor: page.isDone ? null : page.continueCursor } };
  };
  const verifyPage = (cursor: string | null): Step => {
    calls.verify.push(cursor);
    const page = slice(cursor);
    const deleting = page.ids.filter((id) => doomed.has(id)).length;
    const missing = page.ids.filter((id) => !doomed.has(id) && !hasRow.has(id));
    return {
      ok: true,
      value: {
        checked: page.ids.length - deleting,
        deleting,
        missing,
        isDone: page.isDone,
        continueCursor: page.isDone ? null : page.continueCursor,
      },
    };
  };
  return { backfillPage, verifyPage, calls, hasRow };
}

const run = (
  d: { backfillPage: (c: string | null) => Step; verifyPage: (c: string | null) => Step },
  overrides: Partial<Parameters<typeof initialiseSupplierRegistry>[0]> = {},
) =>
  initialiseSupplierRegistry({
    backfillPage: d.backfillPage,
    verifyPage: d.verifyPage,
    now: () => 0,
    startedAt: 0,
    timeoutMs: 1000,
    maxPages: 10,
    ...overrides,
  });

describe("SCRUM-888 supplier registry rollout", () => {
  test("the backfill is invoked page by page from its own cursor, then every org is verified", () => {
    const d = fakeDeployment({ live: ["a", "b", "c", "d", "e"] });
    const result = run(d);
    expect(result).toEqual({ ok: true, created: 5, checked: 5, deleting: 0 });
    expect(d.calls.backfill).toEqual([null, "2", "4"]);
    expect(d.calls.verify).toEqual([null, "2", "4"]);
    expect([...d.hasRow].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("a missing registry row fails the rollout and names only opaque refs", () => {
    const d = fakeDeployment({ live: ["secret-org-id-1", "secret-org-id-2"], backfillBroken: true });
    const result = run(d);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("no supplier registry") });
    const text = JSON.stringify(result);
    expect(text).toContain(opaqueOrgRef("secret-org-id-1"));
    expect(text).toContain("2 organization(s)");
    expect(text).not.toContain("secret-org-id");
  });

  test("a re-run after a completed run creates nothing and still passes", () => {
    const d = fakeDeployment({ live: ["a", "b", "c"] });
    expect(run(d)).toMatchObject({ ok: true, created: 3 });
    expect(run(d)).toEqual({ ok: true, created: 0, checked: 3, deleting: 0 });
  });

  test("an org being deleted is skipped and reported, not counted as a failure", () => {
    const d = fakeDeployment({ live: ["a", "b"], deleting: ["doomed"] });
    expect(run(d)).toEqual({ ok: true, created: 2, checked: 2, deleting: 1 });
  });

  test("a deployment with no organizations passes with zero counts", () => {
    const d = fakeDeployment({ live: [] });
    expect(run(d)).toEqual({ ok: true, created: 0, checked: 0, deleting: 0 });
  });

  test.each([
    ["null", null],
    ["no isDone", { migrated: 0, continueCursor: null }],
    ["negative migrated", { migrated: -1, isDone: true, continueCursor: null }],
    ["non-numeric migrated", { migrated: "1", isDone: true, continueCursor: null }],
  ])("malformed backfill evidence refuses: %s", (_label, value) => {
    const d = fakeDeployment({ live: ["a"] });
    expect(run(d, { backfillPage: () => ({ ok: true, value }) })).toMatchObject({ ok: false });
  });

  test.each([
    ["null", null],
    ["missing list", { checked: 1, deleting: 0, isDone: true, continueCursor: null }],
    ["non-string ids", { checked: 1, deleting: 0, missing: [1], isDone: true, continueCursor: null }],
    ["negative count", { checked: -1, deleting: 0, missing: [], isDone: true, continueCursor: null }],
  ])("malformed verification evidence refuses rather than passing: %s", (_label, value) => {
    const d = fakeDeployment({ live: ["a"] });
    expect(run(d, { verifyPage: () => ({ ok: true, value }) })).toMatchObject({ ok: false });
  });

  test("a failed call refuses without leaking backend output", () => {
    const d = fakeDeployment({ live: ["a"] });
    const failing = run(d, { backfillPage: () => ({ ok: false, reason: "private backend payload" }) });
    expect(failing).toMatchObject({ ok: false });
    expect(JSON.stringify(failing)).not.toContain("private backend payload");
    const verifyFailing = run(d, { verifyPage: () => ({ ok: false, reason: "private backend payload" }) });
    expect(verifyFailing).toMatchObject({ ok: false });
    expect(JSON.stringify(verifyFailing)).not.toContain("private backend payload");
  });

  test("a cursor that stops advancing refuses instead of paging forever", () => {
    const stuck = () => ({ ok: true as const, value: { migrated: 0, isDone: false, continueCursor: "same" } });
    expect(run(fakeDeployment({ live: ["a"] }), { backfillPage: stuck })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("cursor stopped advancing"),
    });
  });

  test("a cursor that stops advancing on the verification walk refuses with that reason, not the page cap", () => {
    const stuck = () => ({
      ok: true as const,
      value: { checked: 0, deleting: 0, missing: [], isDone: false, continueCursor: "same" },
    });
    const d = fakeDeployment({ live: ["a"] });
    const result = run(d, { verifyPage: stuck, maxPages: 10 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("cursor stopped advancing") });
  });

  test("the page cap stops a walk that never finishes", () => {
    let calls = 0;
    const endless = () => ({ ok: true as const, value: { migrated: 0, isDone: false, continueCursor: String(++calls) } });
    expect(run(fakeDeployment({ live: ["a"] }), { backfillPage: endless, maxPages: 3 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("page cap"),
    });
    expect(calls).toBe(3);
  });

  test("the shared deadline stops before another call", () => {
    const d = fakeDeployment({ live: ["a", "b", "c"], pageSize: 1 });
    let now = 0;
    const result = run(d, {
      now: () => now,
      backfillPage: (cursor) => {
        now = 1001;
        return d.backfillPage(cursor);
      },
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("deadline") });
    expect(d.calls.backfill).toHaveLength(1);
  });

  // Seat 2 finding at 100e9d84: the deadline was only checked BEFORE a call, so a terminal page that
  // returned after the budget was spent was accepted and the run went on to verify the Social Inbox.
  test.each(["backfillPage", "verifyPage"] as const)(
    "a terminal %s call that finishes after the deadline is refused, not accepted",
    (phase) => {
      const d = fakeDeployment({ live: ["a"] });
      let now = 0;
      const late = (cursor: string | null): Step => {
        const result = d[phase](cursor);
        now = 1001; // budget is 1000 ms: this call finished 1 ms late
        return result;
      };
      const result = run(d, { now: () => now, [phase]: late });
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("deadline") });
    },
  );

  test("a terminal verification call that finishes exactly on the deadline is still accepted", () => {
    const d = fakeDeployment({ live: ["a"] });
    let now = 0;
    const onTime = (cursor: string | null): Step => {
      const result = d.verifyPage(cursor);
      now = 1000;
      return result;
    };
    expect(run(d, { now: () => now, verifyPage: onTime })).toEqual({ ok: true, created: 1, checked: 1, deleting: 0 });
  });

  test("the refusal counts every missing org but lists a bounded number of opaque refs", () => {
    const live = Array.from({ length: 40 }, (_, index) => `secret-org-${index}`);
    const d = fakeDeployment({ live, backfillBroken: true, pageSize: 10 });
    const result = run(d, { maxPages: 10 });
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("40 organization(s)");
    expect(reason.match(/org-[0-9a-f]{10}/g)?.length).toBe(10);
    expect(reason).toContain("and 30 more");
    expect(reason).not.toContain("secret-org");
  });

  test("rollout wiring: runs before Social Inbox verification, refuses before any success path, uses continueAutomatically false", () => {
    const source = readFileSync(path.join(__dirname, "rolloutRelease.mjs"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const at = (pattern: RegExp) => {
      const match = pattern.exec(source);
      expect(match, `missing from rolloutRelease.mjs: ${pattern}`).not.toBeNull();
      return match!.index;
    };
    const bank = at(/^const bank = rebuildBankBalances\(\{$/m);
    const bankStop = at(/^if \(bankStop\) fail\(bankStop\);$/m);
    const registry = at(/^const supplierRegistry = initialiseSupplierRegistry\(\{$/m);
    const failure = at(/^if \(!supplierRegistry.ok\) fail\(supplierRegistry.reason\);$/m);
    const verification = at(/^const startedAt = rolloutStartedAt;$/m);
    expect(bank).toBeLessThan(bankStop);
    expect(bankStop).toBeLessThan(registry);
    expect(registry).toBeLessThan(failure);
    expect(failure).toBeLessThan(verification);
    expect(source).toContain('const SUPPLIER_REGISTRY_BACKFILL_FN = "suppliers:backfillRegistry";');
    expect(source).toContain('const SUPPLIER_REGISTRY_VERIFY_FN = "suppliers:registryCoverageForRelease";');
    expect(source).toMatch(/continueAutomatically: false/);
    expect(source).toMatch(/startedAt: rolloutStartedAt,\s*timeoutMs: TIMEOUT_MS,\s*maxPages: MAX_SUPPLIER_REGISTRY_PAGES/);
  });
});
