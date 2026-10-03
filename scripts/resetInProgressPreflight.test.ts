/**
 * SCRUM-565 D-17 (N9) — the release preflight fails CLOSED.
 *
 * The runner is injected, so no Convex CLI is spawned. PASS requires every page
 * read and a zero total; everything else is a refusal that prints no org data.
 */
import { describe, expect, test } from "vitest";
import { PREFLIGHT_PROTOCOL, runResetPreflight } from "./resetInProgressPreflight.mjs";

const DEPLOYMENT = "kindly-hound-172";
const KEY = `prod:${DEPLOYMENT}|secretpart`;

type Page = Record<string, unknown>;
const good = (over: Page = {}): Page => ({
  protocol: PREFLIGHT_PROTOCOL,
  scanned: 3,
  inProgress: 0,
  isDone: true,
  continueCursor: "end",
  ...over,
});

function walk(pages: Array<Page | { ok: false; reason: string }>, extra: Record<string, unknown> = {}) {
  let i = 0;
  const calls: string[] = [];
  const outcome = runResetPreflight({
    run: (args: string) => {
      calls.push(args);
      const next = pages[Math.min(i, pages.length - 1)];
      i += 1;
      return "ok" in next && next.ok === false ? next : { ok: true, value: next };
    },
    deployKey: KEY,
    expectedDeployment: DEPLOYMENT,
    ...extra,
  });
  return { outcome, calls };
}

describe("runResetPreflight", () => {
  test("passes on an all-zero multi-page walk and totals the pages", () => {
    const { outcome, calls } = walk([
      good({ isDone: false, continueCursor: "c1" }),
      good({ isDone: false, continueCursor: "c2", scanned: 5 }),
      good({ scanned: 2 }),
    ]);
    expect(outcome).toEqual({ ok: true, scanned: 10, inProgress: 0 });
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[1]).paginationOpts.cursor).toBe("c1");
  });

  test("fails on a positive count, even on a later page", () => {
    const { outcome } = walk([good({ isDone: false, continueCursor: "c1" }), good({ inProgress: 1 })]);
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toMatch(/1 organization\(s\) are mid financial reset/);
  });

  test("fails on a CLI error", () => {
    expect(walk([{ ok: false, reason: "cli failed" }]).outcome.ok).toBe(false);
  });

  test("fails on a malformed answer", () => {
    for (const bad of [null, [], "x", 5]) {
      const outcome = runResetPreflight({
        run: () => ({ ok: true, value: bad }),
        deployKey: KEY,
        expectedDeployment: DEPLOYMENT,
      });
      expect(outcome.ok, String(bad)).toBe(false);
    }
  });

  test("fails on a wrong or missing protocol", () => {
    expect(walk([good({ protocol: "other" })]).outcome.ok).toBe(false);
    expect(walk([good({ protocol: undefined })]).outcome.ok).toBe(false);
  });

  test("fails on invalid counts", () => {
    for (const over of [{ scanned: -1 }, { inProgress: 1.5 }, { scanned: "3" }, { inProgress: 4, scanned: 3 }, { isDone: "yes" }]) {
      expect(walk([good(over)]).outcome.ok, JSON.stringify(over)).toBe(false);
    }
  });

  test("fails when the cursor does not advance", () => {
    const stuck = good({ isDone: false, continueCursor: "same" });
    const { outcome } = walk([stuck, stuck]);
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toMatch(/cursor stopped advancing/);
  });

  test("fails when the page cap is reached", () => {
    let n = 0;
    const outcome = runResetPreflight({
      run: () => ({ ok: true, value: good({ isDone: false, continueCursor: `c${(n += 1)}` }) }),
      deployKey: KEY,
      expectedDeployment: DEPLOYMENT,
      maxPages: 5,
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toMatch(/within 5 pages/);
    expect(n).toBe(5);
  });

  test("fails on a key for the wrong deployment without calling the runner", () => {
    let called = false;
    const outcome = runResetPreflight({
      run: () => {
        called = true;
        return { ok: true, value: good() };
      },
      deployKey: "prod:some-other-deployment|secretpart",
      expectedDeployment: DEPLOYMENT,
    });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("secretpart");
  });

  test("fails on a missing key or expected deployment", () => {
    expect(runResetPreflight({ run: () => ({ ok: true, value: good() }), deployKey: undefined, expectedDeployment: DEPLOYMENT }).ok).toBe(false);
    expect(runResetPreflight({ run: () => ({ ok: true, value: good() }), deployKey: KEY, expectedDeployment: "" }).ok).toBe(false);
  });

  test("output never contains an org id even if the backend sent one", () => {
    const { outcome } = walk([good({ inProgress: 1, orgId: "jx7abc0org", orgName: "Secret Dealer" })]);
    expect(JSON.stringify(outcome)).not.toMatch(/jx7abc0org|Secret Dealer/);
  });
});
