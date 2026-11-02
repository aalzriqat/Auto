import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ACCOUNTANT_COST_PRICE_BACKFILL_FN,
  ACCOUNTANT_COST_PRICE_PAGE_SIZE,
  MAX_ACCOUNTANT_COST_PRICE_PAGES,
  backfillAccountantCostPriceAccessRollout,
  runAccountantCostPricePhase,
} from "./releaseGuard";

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
    const accountant = at(/^accountantCostPriceSummary = runAccountantCostPricePhase\(\{/m);
    const logged = at(/^console\.log\(`  \$\{accountantCostPriceSummary\}`\);$/m);
    const verification = at(/^console\.log\(`Verifying the rollout/m);
    expect(identity).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(vat);
    expect(vat).toBeLessThan(empty);
    expect(empty).toBeLessThan(bank);
    expect(bank).toBeLessThan(registry);
    expect(registry).toBeLessThan(supplierIdentity);
    expect(supplierIdentity).toBeLessThan(accountant);
    expect(accountant).toBeLessThan(logged);
    expect(logged).toBeLessThan(verification);
    // The phase is ONE statement: a single call to the tested helper, handed the shared CLI runner, the shared deadline and
    // the script's own `fail`. The script keeps no branch of its own here, because it cannot be executed under coverage.
    expect(source).toMatch(
      /^accountantCostPriceSummary = runAccountantCostPricePhase\(\{\s*convex,\s*now: Date\.now,\s*startedAt: rolloutStartedAt,\s*timeoutMs: TIMEOUT_MS,\s*fail,?\s*\}\);$/m,
    );
    expect(source.match(/runAccountantCostPricePhase\(/g)).toHaveLength(1);
    // The old shape (a result object the script branched on) is gone.
    expect(source).not.toContain("if (!accountantCostPrice.ok)");
    expect(source).not.toContain("const accountantCostPrice");
    // The page size, page cap and function name live in the helper only; the script cannot drift from what is tested.
    expect(source).not.toMatch(/ACCOUNTANT_COST_PRICE|migrateRoles:/);
    // Public log: the helper's result has no `updates`, and the script must never reach for one.
    expect(source).not.toMatch(/\bupdates\b/);
  });
});

describe("SCRUM-896 runAccountantCostPricePhase (the whole phase, minus the CLI)", () => {
  const deadline = { now: () => 0, startedAt: 0, timeoutMs: 1000 };
  type Convex = Parameters<typeof runAccountantCostPricePhase>[0]["convex"];

  /** The script's `fail` prints, writes the summary and exits; this one records the reason and throws, so it never returns. */
  class Refused extends Error {}

  /**
   * Runs the phase with a recording `fail`. `summary` is what the helper returned (undefined when it refused) and `failed`
   * is every reason handed to `fail`. Both are checked for the sentinel, success and refusal alike (the output is public).
   */
  const phase = (convex: Convex, overrides: Partial<typeof deadline> = {}) => {
    const failed: string[] = [];
    const fail = (reason: string): never => {
      failed.push(reason);
      throw new Refused(reason);
    };
    let summary: string | undefined;
    try {
      summary = runAccountantCostPricePhase({ convex, ...deadline, ...overrides, fail });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
    }
    expect(JSON.stringify({ summary, failed })).not.toContain(SECRET);
    return { summary, failed };
  };

  test("calls the CLI with the exact function name and page size, cursor null first and then the returned cursor", () => {
    const answers = [page(1, false, "c1"), page(0, false, "c2"), page(2, true, "c3")];
    const calls: string[][] = [];
    const result = phase((args) => {
      calls.push(args);
      return { ok: true, value: answers[calls.length - 1] };
    });
    expect(result.summary).toEqual(expect.any(String));
    expect(result.failed).toEqual([]);
    expect(calls).toEqual([
      ["run", "migrateRoles:backfillAccountantCostPriceAccess", JSON.stringify({ cursor: null, numItems: 100 })],
      ["run", "migrateRoles:backfillAccountantCostPriceAccess", JSON.stringify({ cursor: "c1", numItems: 100 })],
      ["run", "migrateRoles:backfillAccountantCostPriceAccess", JSON.stringify({ cursor: "c2", numItems: 100 })],
    ]);
    expect(ACCOUNTANT_COST_PRICE_BACKFILL_FN).toBe("migrateRoles:backfillAccountantCostPriceAccess");
    expect(ACCOUNTANT_COST_PRICE_PAGE_SIZE).toBe(100);
  });

  test("renders the counts-only summary for N updates across P pages", () => {
    const answers = [page(1, false, "c1"), page(0, false, "c2"), page(2, true, "c3")];
    let calls = 0;
    const result = phase(() => ({ ok: true, value: answers[calls++] }));
    expect(result).toEqual({
      failed: [],
      summary:
        "3 stored ACCOUNTANT roles granted view:cost_price in 3 page call(s). Custom and renamed roles are untouched.",
    });
  });

  test("renders the summary for an already-repaired deployment (0 updates, one page)", () => {
    const result = phase(() => ({ ok: true, value: page(0, true, "end") }));
    expect(result).toEqual({
      failed: [],
      summary:
        "0 stored ACCOUNTANT roles granted view:cost_price in 1 page call(s). Custom and renamed roles are untouched.",
    });
  });

  test("success returns the summary string itself and never calls fail", () => {
    const fail = vi.fn((reason: string): never => {
      throw new Error(reason);
    });
    const summary = runAccountantCostPricePhase({
      convex: () => ({ ok: true, value: page(2, true, "end") }),
      ...deadline,
      fail,
    });
    expect(typeof summary).toBe("string");
    expect(summary).toBe(
      "2 stored ACCOUNTANT roles granted view:cost_price in 1 page call(s). Custom and renamed roles are untouched.",
    );
    expect(fail).not.toHaveBeenCalled();
  });

  test("a refusal calls fail exactly once with the walker's reason unchanged and yields no summary", () => {
    const answer = () => ({ ok: true as const, value: { ...page(1, true, "c"), updates: [] } });
    const expected = backfillAccountantCostPriceAccessRollout({
      runPage: answer,
      ...deadline,
      maxPages: MAX_ACCOUNTANT_COST_PRICE_PAGES,
      pageSize: ACCOUNTANT_COST_PRICE_PAGE_SIZE,
    });
    expect(expected.ok).toBe(false);
    const result = phase(answer);
    expect(result.summary).toBeUndefined();
    expect(result.failed).toEqual([(expected as { reason: string }).reason]);
    expect(result.failed[0]).toContain("Production is DEPLOYED, but the ACCOUNTANT cost-price backfill");
  });

  test("a `fail` that returns instead of exiting still yields no summary (the helper throws)", () => {
    const fail = vi.fn() as unknown as (reason: string) => never;
    expect(() =>
      runAccountantCostPricePhase({ convex: () => ({ ok: false, reason: SECRET }), ...deadline, fail }),
    ).toThrow();
    expect(fail).toHaveBeenCalledTimes(1);
  });

  test("a failed CLI call fails with the phase label and never echoes the CLI's reason", () => {
    const result = phase(() => ({ ok: false, reason: `Role:ACCOUNTANT:${SECRET}` }));
    expect(result).toEqual({
      summary: undefined,
      failed: [
        "Production is DEPLOYED, but the ACCOUNTANT cost-price backfill call failed. See backend logs; a re-run resumes it.",
      ],
    });
  });

  test("the shared deadline reaches the walker", () => {
    let calls = 0;
    const result = phase(() => {
      calls += 1;
      return { ok: true, value: page(0, true, "end") };
    }, { now: () => 1001 });
    expect(result.failed).toEqual([expect.stringContaining("deadline")]);
    expect(calls).toBe(0);
  });

  test("a nonterminating backend stops at the exported page cap", () => {
    let calls = 0;
    const result = phase(() => {
      calls += 1;
      return { ok: true, value: page(0, false, `c${calls}`) };
    });
    expect(result.failed).toEqual([expect.stringContaining("page cap")]);
    expect(calls).toBe(MAX_ACCOUNTANT_COST_PRICE_PAGES);
    expect(MAX_ACCOUNTANT_COST_PRICE_PAGES).toBe(10_000);
  });

  test("a page reporting more updates than the exported page size is refused", () => {
    const result = phase(() => ({ ok: true, value: page(ACCOUNTANT_COST_PRICE_PAGE_SIZE + 1, true, "c") }));
    expect(result.failed).toEqual([expect.stringContaining("unrecognised result")]);
  });

  test("the page size is inside the backend's clamp, and the function name is the backend's internal mutation", () => {
    const backend = readFileSync(path.join(__dirname, "..", "convex", "migrateRoles.ts"), "utf8");
    expect(backend).toMatch(/export const backfillAccountantCostPriceAccess = internalMutation\(/);
    const clamp = /Math\.min\(Math\.max\(Math\.floor\(args\.numItems \?\? (\d+)\), (\d+)\), (\d+)\)/.exec(backend);
    expect(clamp, "the backend's numItems clamp changed shape; update this pin").not.toBeNull();
    const [, backendDefault, lower, upper] = clamp!.map(Number);
    expect(ACCOUNTANT_COST_PRICE_PAGE_SIZE).toBeGreaterThanOrEqual(lower);
    expect(ACCOUNTANT_COST_PRICE_PAGE_SIZE).toBeLessThanOrEqual(upper);
    expect(ACCOUNTANT_COST_PRICE_PAGE_SIZE).toBe(backendDefault);
  });
});
