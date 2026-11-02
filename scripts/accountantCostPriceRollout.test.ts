import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { backfillAccountantCostPriceAccessRollout } from "./releaseGuard";

type Input = Parameters<typeof backfillAccountantCostPriceAccessRollout>[0];
type RunPage = Input["runPage"];

/** One page as `migrateRoles:backfillAccountantCostPriceAccess` returns it. `updates` holds role identifiers in production. */
const page = (updatedCount: number, isDone: boolean, continueCursor: string) => ({
  updatedCount,
  updates: Array.from({ length: updatedCount }, (_, i) => `Role:ACCOUNTANT:org_secret_${i}`),
  isDone,
  continueCursor,
});

const run = (runPage: RunPage, overrides: Partial<Input> = {}) =>
  backfillAccountantCostPriceAccessRollout({
    runPage,
    now: () => 0,
    startedAt: 0,
    timeoutMs: 1000,
    maxPages: 3,
    pageSize: 100,
    ...overrides,
  });

describe("SCRUM-896 ACCOUNTANT view:cost_price backfill rollout", () => {
  test("serially pages from a null cursor, passing continueCursor back until isDone, summing updatedCount", () => {
    const answers = [page(2, false, "c1"), page(0, false, "c2"), page(1, true, "c3")];
    const seen: (string | null)[] = [];
    const result = run((cursor) => {
      seen.push(cursor);
      return { ok: true, value: answers[seen.length - 1] };
    });
    expect(result).toEqual({ ok: true, pages: 3, updated: 3 });
    // An empty page before isDone is legitimate (Convex does not promise a full page), so it does not end the walk.
    expect(seen).toEqual([null, "c1", "c2"]);
  });

  test("a backend that is already done answers in one page with no updates (idempotent re-run)", () => {
    const seen: (string | null)[] = [];
    const result = run((cursor) => {
      seen.push(cursor);
      return { ok: true, value: page(0, true, "end") };
    });
    expect(result).toEqual({ ok: true, pages: 1, updated: 0 });
    expect(seen).toEqual([null]);
  });

  test.each([
    ["null", null],
    ["an empty object", {}],
    ["missing isDone", { updatedCount: 0, updates: [], continueCursor: "c" }],
    ["missing continueCursor", { updatedCount: 0, updates: [], isDone: true }],
    ["continueCursor not a string", { updatedCount: 0, updates: [], isDone: true, continueCursor: null }],
    ["negative updatedCount", { updatedCount: -1, updates: [], isDone: true, continueCursor: "c" }],
    ["NaN updatedCount", { updatedCount: NaN, updates: [], isDone: true, continueCursor: "c" }],
    ["non-integer updatedCount", { updatedCount: 1.5, updates: ["x"], isDone: true, continueCursor: "c" }],
    ["updatedCount above the page size", { ...page(101, true, "c") }],
    ["isDone not a boolean", { updatedCount: 0, updates: [], isDone: "true", continueCursor: "c" }],
    ["updates not an array", { updatedCount: 0, updates: "none", isDone: true, continueCursor: "c" }],
    ["updates shorter than updatedCount", { updatedCount: 1, updates: [], isDone: true, continueCursor: "c" }],
  ])("malformed evidence refuses: %s", (_label, value) => {
    expect(run(() => ({ ok: true, value }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Production is DEPLOYED, but"),
    });
  });

  test("a failed call refuses without leaking backend output", () => {
    const result = run(() => ({ ok: false, reason: "private backend payload" }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("call failed") });
    expect(JSON.stringify(result)).not.toContain("private backend payload");
  });

  test("a cursor that comes back unchanged refuses instead of paging forever", () => {
    let calls = 0;
    const result = run(() => {
      calls += 1;
      return { ok: true, value: page(0, false, "same") };
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("cursor stopped advancing") });
    // Call 1 sends null and gets "same"; call 2 sends "same" and gets "same" again.
    expect(calls).toBe(2);
  });

  test("a nonterminating backend stops at the page cap", () => {
    let calls = 0;
    const result = run(() => {
      calls += 1;
      return { ok: true, value: page(0, false, `c${calls}`) };
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("page cap") });
    expect(calls).toBe(3);
  });

  test("the shared deadline stops before another call", () => {
    let calls = 0;
    let now = 0;
    const result = run(
      () => {
        calls += 1;
        now = 1001;
        return { ok: true, value: page(0, false, `c${calls}`) };
      },
      { now: () => now },
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("deadline") });
    expect(calls).toBe(1);
  });

  // The rollout deadline is shared by every phase and is checked on both sides of a call: a call that returns past the
  // budget must not be accepted as complete, or the run would go on to later phases having overrun it (fail closed).
  test.each([
    ["terminal", true],
    ["non-terminal", false],
  ])("a well-formed %s page whose call finishes after the deadline is refused, not accepted", (_label, isDone) => {
    let now = 0;
    const result = run(
      () => {
        now = 1001;
        return { ok: true, value: page(1, isDone, "c1") };
      },
      { now: () => now },
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("deadline") });
    expect(JSON.stringify(result)).not.toContain("org_secret");
  });

  test("a terminal call that finishes exactly on the deadline is still accepted", () => {
    let now = 0;
    const result = run(
      () => {
        now = 1000;
        return { ok: true, value: page(0, true, "end") };
      },
      { now: () => now },
    );
    expect(result).toEqual({ ok: true, pages: 1, updated: 0 });
  });

  // The backend's `updates` array holds one line per patched role: the role name and the organization id.
  // The repository is public, so none of it may reach a reason, on the success path or on any refusal path.
  test("no result ever contains an element of updates, on success or on any refusal path", () => {
    const leaky = { updatedCount: 1, updates: ["Role:ACCOUNTANT:org_secret"], isDone: false, continueCursor: "c1" };
    const results = [
      run(() => ({ ok: true, value: { ...leaky, isDone: true } })),
      // malformed, with the secret still present in the same value
      run(() => ({ ok: true, value: { ...leaky, updatedCount: NaN } })),
      run(() => ({ ok: true, value: { ...leaky, isDone: "no" } })),
      run(() => ({ ok: true, value: { ...leaky, updatedCount: 2 } })),
      // a cursor that does not advance
      run(() => ({ ok: true, value: { ...leaky, continueCursor: "c1" } })),
      // the page cap
      (() => {
        let n = 0;
        return run(() => ({ ok: true, value: { ...leaky, continueCursor: `c${(n += 1)}` } }));
      })(),
      // the shared deadline, after a page that carried the secret
      (() => {
        let now = 0;
        return run(
          () => {
            now = 1001;
            return { ok: true, value: leaky };
          },
          { now: () => now },
        );
      })(),
      // a failed call whose backend text carries the secret
      run(() => ({ ok: false, reason: "Role:ACCOUNTANT:org_secret" })),
    ];
    for (const result of results) expect(JSON.stringify(result)).not.toContain("org_secret");
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  test("rollout wiring: runs after the supplier identity repair, refuses before the verification, counts only", () => {
    // Same wiring pin as the supplier VAT hold and supplier registry phases.
    const source = readFileSync(path.join(__dirname, "rolloutRelease.mjs"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const at = (pattern: RegExp) => {
      const match = pattern.exec(source);
      expect(match, `missing from rolloutRelease.mjs: ${pattern}`).not.toBeNull();
      return match!.index;
    };
    const identity = at(/^const before = collectReport\(undefined\);$/m);
    const refusal = at(/^if \(!before.ok\) fail\(before.reason\);$/m);
    const vat = at(/^const supplierVat = recoverSupplierVatHolds\(\{$/m);
    const empty = at(/^if \(before.verdict.orgCount === 0\) \{$/m);
    const bank = at(/^const bank = rebuildBankBalances\(\{$/m);
    const registry = at(/^const supplierRegistry = initialiseSupplierRegistry\(\{$/m);
    const supplierIdentity = at(/^const supplierIdentity = repairAndVerifySupplierIdentity\(\{$/m);
    const accountant = at(/^const accountantCostPrice = backfillAccountantCostPriceAccessRollout\(\{$/m);
    const failure = at(/^if \(!accountantCostPrice.ok\) fail\(accountantCostPrice.reason\);$/m);
    const verification = at(/^console\.log\(`Verifying the rollout/m);
    expect(identity).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(vat);
    expect(vat).toBeLessThan(empty);
    expect(empty).toBeLessThan(bank);
    expect(bank).toBeLessThan(registry);
    expect(registry).toBeLessThan(supplierIdentity);
    expect(supplierIdentity).toBeLessThan(accountant);
    expect(accountant).toBeLessThan(failure);
    expect(failure).toBeLessThan(verification);
    expect(source).toContain('const ACCOUNTANT_COST_PRICE_BACKFILL_FN = "migrateRoles:backfillAccountantCostPriceAccess";');
    expect(source).toMatch(/JSON\.stringify\(\{ cursor, numItems: ACCOUNTANT_COST_PRICE_PAGE_SIZE \}\)/);
    // The size the script asks for and the size the helper validates against are one constant.
    expect(source).toMatch(/pageSize: ACCOUNTANT_COST_PRICE_PAGE_SIZE,/);
    expect(source).toMatch(/startedAt: rolloutStartedAt,\s*timeoutMs: TIMEOUT_MS,\s*maxPages: MAX_ACCOUNTANT_COST_PRICE_PAGES/);
    // Public log: the helper's result has no `updates`, and the script must never reach for one.
    expect(source).not.toMatch(/\bupdates\b/);
  });
});
