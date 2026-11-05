import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEAL_NUMBER_BACKFILL_FN,
  DEAL_NUMBER_PAGE_SIZE,
  MAX_DEAL_NUMBER_PAGES,
  backfillDealNumbersRollout,
  runDealNumberBackfillPhase,
} from "./releaseGuard";

type Input = Parameters<typeof backfillDealNumbersRollout>[0];
type RunPage = Input["runPage"];

/** One page as `dealNumberBackfill:runPage` returns it. */
const page = (numberedCount: number, isDone: boolean, continueCursor: string, checkedCount = numberedCount) => ({
  numberedCount,
  checkedCount,
  isDone,
  continueCursor,
});

const run = (runPage: RunPage, overrides: Partial<Input> = {}) =>
  backfillDealNumbersRollout({ runPage, now: () => 0, startedAt: 0, timeoutMs: 1000, maxPages: 3, pageSize: 100, ...overrides });

describe("SCRUM-808 deal number backfill rollout", () => {
  test("pages from a null cursor, passing continueCursor back until isDone, summing numberedCount", () => {
    const answers = [page(150, false, "1"), page(0, false, "2", 3), page(4, true, "3")];
    const seen: (string | null)[] = [];
    const result = run((cursor) => {
      seen.push(cursor);
      return { ok: true, value: answers[seen.length - 1] };
    });
    expect(result).toEqual({ ok: true, pages: 3, numbered: 154 });
    expect(seen).toEqual([null, "1", "2"]);
  });

  test("a finished walk answers in one empty page (re-run on a later deploy)", () => {
    const seen: (string | null)[] = [];
    const result = run((cursor) => {
      seen.push(cursor);
      return { ok: true, value: page(0, true, "") };
    });
    expect(result).toEqual({ ok: true, pages: 1, numbered: 0 });
    expect(seen).toEqual([null]);
  });

  const base = page(1, true, "c");
  test.each([
    ["null", null],
    ["an empty object", {}],
    ["missing isDone", { ...base, isDone: undefined }],
    ["continueCursor not a string", { ...base, continueCursor: null }],
    ["negative numberedCount", { ...base, numberedCount: -1 }],
    ["NaN numberedCount", { ...base, numberedCount: NaN }],
    ["non-integer checkedCount", { ...base, checkedCount: 1.5 }],
    ["numberedCount above checkedCount", { ...base, numberedCount: 2, checkedCount: 1 }],
    ["checkedCount above two tables' page size", page(201, true, "c")],
  ])("refuses a malformed page: %s", (_label, value) => {
    const result = run(() => ({ ok: true, value }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("unrecognised result") });
  });

  test("a cursor that does not advance is refused instead of paging forever", () => {
    const result = run(() => ({ ok: true, value: page(1, false, "same") }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("stopped advancing") });
  });

  test("the page cap ends the walk as a resumable refusal", () => {
    let n = 0;
    const result = run(() => ({ ok: true, value: page(1, false, `c${++n}`) }), { maxPages: 2 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("page cap") });
    expect(n).toBe(2);
  });

  test("a failed call is refused without echoing backend text", () => {
    const result = run(() => ({ ok: false, reason: "org_secret backend text" }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("call failed") });
    expect(JSON.stringify(result)).not.toContain("org_secret");
  });

  test("a call that returns past the shared deadline is refused, not accepted", () => {
    let now = 0;
    const result = run(
      () => {
        now = 1001;
        return { ok: true, value: page(1, true, "c") };
      },
      { now: () => now },
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("deadline") });
  });

  test("rollout wiring: after the ACCOUNTANT phase, before the verification, one statement", () => {
    const source = readFileSync(path.join(__dirname, "rolloutRelease.mjs"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const at = (pattern: RegExp) => {
      const match = pattern.exec(source);
      expect(match, `missing from rolloutRelease.mjs: ${pattern}`).not.toBeNull();
      return match!.index;
    };
    const empty = at(/^if \(before.verdict.orgCount === 0\) \{$/m);
    const accountant = at(/^accountantCostPriceSummary = runAccountantCostPricePhase\(\{/m);
    const dealNumbers = at(/^dealNumberSummary = runDealNumberBackfillPhase\(\{/m);
    const logged = at(/^console\.log\(`  \$\{dealNumberSummary\}`\);$/m);
    const verification = at(/^console\.log\(`Verifying the rollout/m);
    expect(empty).toBeLessThan(accountant);
    expect(accountant).toBeLessThan(dealNumbers);
    expect(dealNumbers).toBeLessThan(logged);
    expect(logged).toBeLessThan(verification);
    expect(source).toMatch(
      /^dealNumberSummary = runDealNumberBackfillPhase\(\{\s*convex,\s*now: Date\.now,\s*startedAt: rolloutStartedAt,\s*timeoutMs: TIMEOUT_MS,\s*fail,?\s*\}\);$/m,
    );
    expect(source.match(/runDealNumberBackfillPhase\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/DEAL_NUMBER_|dealNumberBackfill:/);
  });
});

describe("SCRUM-808 runDealNumberBackfillPhase", () => {
  class Refused extends Error {}
  const phase = (convex: Parameters<typeof runDealNumberBackfillPhase>[0]["convex"]) => {
    const failed: string[] = [];
    const fail = (reason: string): never => {
      failed.push(reason);
      throw new Refused(reason);
    };
    let summary: string | undefined;
    try {
      summary = runDealNumberBackfillPhase({ convex, now: () => 0, startedAt: 0, timeoutMs: 1000, fail });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
    }
    return { summary, failed };
  };

  test("calls the internal backfill with the page size and the cursor, and returns a counts-only summary", () => {
    const calls: string[][] = [];
    const answers = [page(3, false, "10"), page(2, true, "20")];
    const { summary, failed } = phase((args) => {
      calls.push(args);
      return { ok: true, value: answers[calls.length - 1] };
    });
    expect(failed).toEqual([]);
    expect(calls).toEqual([
      ["run", DEAL_NUMBER_BACKFILL_FN, JSON.stringify({ cursor: null, numItems: DEAL_NUMBER_PAGE_SIZE })],
      ["run", DEAL_NUMBER_BACKFILL_FN, JSON.stringify({ cursor: "10", numItems: DEAL_NUMBER_PAGE_SIZE })],
    ]);
    expect(summary).toBe("5 existing deal rows given a deal number in 2 page call(s). Rows that already had one are untouched.");
    expect(DEAL_NUMBER_BACKFILL_FN).toBe("dealNumberBackfill:runPage");
    expect(MAX_DEAL_NUMBER_PAGES * DEAL_NUMBER_PAGE_SIZE * 2).toBe(2_000_000);
  });

  test("a refusal goes to the script's fail exactly once and no summary is returned", () => {
    const { summary, failed } = phase(() => ({ ok: true, value: null }));
    expect(summary).toBeUndefined();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/^Production is DEPLOYED, but the deal number backfill/);
  });

  test("a fail handler that returns still cannot produce a summary", () => {
    expect(() =>
      runDealNumberBackfillPhase({
        convex: () => ({ ok: true, value: null }),
        now: () => 0,
        startedAt: 0,
        timeoutMs: 1000,
        fail: (() => undefined) as unknown as (reason: string) => never,
      }),
    ).toThrow("returned");
  });
});
