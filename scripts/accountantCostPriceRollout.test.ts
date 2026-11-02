import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { backfillAccountantCostPriceAccessRollout } from "./releaseGuard";

type Input = Parameters<typeof backfillAccountantCostPriceAccessRollout>[0];
type RunPage = Input["runPage"];

// The backend's `updates` array holds one line per patched role: the role name and the organization id. The repository is
// public, so none of it may reach a result, on the success path or on any refusal path.
const SECRET = "org_secret";

/** One page as `migrateRoles:backfillAccountantCostPriceAccess` returns it. */
const page = (updatedCount: number, isDone: boolean, continueCursor: string) => ({
  updatedCount,
  updates: Array.from({ length: updatedCount }, (_, i) => `Role:ACCOUNTANT:${SECRET}_${i}`),
  isDone,
  continueCursor,
});

/** Every call through here asserts the no-leak rule, so every test below covers it, success and refusal alike. */
const run = (runPage: RunPage, overrides: Partial<Input> = {}) => {
  const result = backfillAccountantCostPriceAccessRollout({
    runPage,
    now: () => 0,
    startedAt: 0,
    timeoutMs: 1000,
    maxPages: 3,
    pageSize: 100,
    ...overrides,
  });
  expect(JSON.stringify(result)).not.toContain(SECRET);
  return result;
};

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

  // Each malformed value starts from a valid page that carries a secret, so a refusal also proves it does not echo it.
  const base = page(1, true, "c");
  test.each([
    ["null", null],
    ["an empty object", {}],
    ["missing isDone", { ...base, isDone: undefined }],
    ["missing continueCursor", { ...base, continueCursor: undefined }],
    ["continueCursor not a string", { ...base, continueCursor: null }],
    ["negative updatedCount", { ...base, updatedCount: -1 }],
    ["NaN updatedCount", { ...base, updatedCount: NaN }],
    ["non-integer updatedCount", { ...base, updatedCount: 1.5 }],
    ["updatedCount above the page size", page(101, true, "c")],
    ["isDone not a boolean", { ...base, isDone: "true" }],
    ["updates not an array", { ...base, updates: "none" }],
    ["updates shorter than updatedCount", { ...base, updates: [] }],
    ["updates longer than updatedCount", { ...base, updatedCount: 0 }],
  ])("malformed evidence refuses: %s", (_label, value) => {
    expect(run(() => ({ ok: true, value }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Production is DEPLOYED, but"),
    });
  });

  test("a failed call refuses without leaking backend output", () => {
    const result = run(() => ({ ok: false, reason: `Role:ACCOUNTANT:${SECRET}` }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("call failed") });
  });

  test("a cursor that comes back unchanged refuses instead of paging forever", () => {
    let calls = 0;
    const result = run(() => {
      calls += 1;
      return { ok: true, value: page(1, false, "same") };
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("cursor stopped advancing") });
    // Call 1 sends null and gets "same"; call 2 sends "same" and gets "same" again.
    expect(calls).toBe(2);
  });

  test("a nonterminating backend stops at the page cap", () => {
    let calls = 0;
    const result = run(() => {
      calls += 1;
      return { ok: true, value: page(1, false, `c${calls}`) };
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
        return { ok: true, value: page(1, false, `c${calls}`) };
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
