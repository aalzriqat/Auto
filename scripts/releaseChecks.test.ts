/**
 * The check-reading layer, tested against the failure it was written to fix.
 *
 * ⚠️ These exist because the fix shipped without them. `readCheckResults` was
 * added to close a real defect — `/check-runs` defaults to 30 results per page,
 * and this repository already produces 25 at a single commit, so the gate was
 * one new workflow job away from never seeing a required check. A fix for a
 * deployment-gating bug with no regression coverage is a fix that can be
 * removed by accident, and the symptom would be every future release refusing
 * for a reason nobody would think to look for.
 *
 * The `api` seam is mocked rather than the network: what is under test is the
 * walking and the mapping, not GitHub.
 */
import { describe, expect, test } from "vitest";
import { readCheckResults } from "./releaseChecks.mjs";

type Run = { name: string; app?: { slug: string }; status: string; conclusion: string | null };

const run = (name: string, over: Partial<Run> = {}): Run => ({
  name,
  app: { slug: "github-actions" },
  status: "completed",
  conclusion: "success",
  ...over,
});

/**
 * A GitHub stand-in that pages exactly as the real API does.
 *
 * `reportedTotal` is deliberately separate from the real length so a LYING
 * `total_count` can be exercised — the field this walker must not depend on.
 */
function fakeApi(options: {
  runs: Run[];
  statuses?: { context: string; state: string }[];
  reportedTotal?: number;
  failCheckRuns?: number;
  failStatuses?: number;
}) {
  const calls: { path: string; page?: number; perPage?: number }[] = [];

  const api = async (path: string, query?: Record<string, unknown>) => {
    calls.push({
      path,
      page: query?.page as number | undefined,
      perPage: query?.per_page as number | undefined,
    });

    if (path.endsWith("/check-runs")) {
      if (options.failCheckRuns) return { status: options.failCheckRuns, body: null };
      const page = Number(query?.page ?? 1);
      // ⚠️ GitHub's OWN DEFAULT, honoured deliberately. An earlier version of
      // this mock sliced by its own fixed 100 and ignored `per_page` entirely,
      // so dropping `per_page: PER_PAGE` from the production request still
      // passed here — while against the real API the reader would receive 30,
      // see 30 < 100, stop after one page, and make every check beyond it
      // invisible. A mock that is more generous than the service it stands in
      // for tests nothing.
      const perPage = Number(query?.per_page ?? 30);
      const slice = options.runs.slice((page - 1) * perPage, page * perPage);
      return {
        status: 200,
        body: { total_count: options.reportedTotal ?? options.runs.length, check_runs: slice },
      };
    }

    if (options.failStatuses) return { status: options.failStatuses, body: null };
    return { status: 200, body: { statuses: options.statuses ?? [] } };
  };

  return { api, calls };
}

describe("every check at a commit is read, across every page", () => {
  test("a required check on a LATER page is found", async () => {
    // ⚠️ THE REGRESSION. With single-page reading, `lint` on page 2 is invisible
    // and reads as "no result at this commit" — which refuses every release.
    const runs = [
      ...Array.from({ length: 100 }, (_, i) => run(`filler-${i}`)),
      run("lint"),
    ];
    const { api, calls } = fakeApi({ runs });

    const result = await readCheckResults(api, "a".repeat(40));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const found = result.results ?? [];
    expect(found).toHaveLength(101);
    expect(found.some((r) => r.name === "lint")).toBe(true);

    const checkRunCalls = calls.filter((c) => c.path.endsWith("/check-runs"));
    expect(checkRunCalls.map((c) => c.page)).toEqual([1, 2]);
    // The page size must be REQUESTED, not assumed. Without it GitHub serves
    // 30, and the reader's `runs.length < PER_PAGE` test would end the walk on
    // the first page while believing it had reached the end.
    expect(checkRunCalls.map((c) => c.perPage)).toEqual([100, 100]);
  });

  test("a LYING total_count does not end the walk early", async () => {
    // The walker must terminate on page size, not on a server-reported total.
    // A total that is wrong, or that shrinks mid-walk as a re-run replaces a
    // check, would otherwise truncate the read and hide a required check.
    const runs = [
      ...Array.from({ length: 100 }, (_, i) => run(`filler-${i}`)),
      run("secret-scan"),
    ];
    const { api } = fakeApi({ runs, reportedTotal: 12 });

    const result = await readCheckResults(api, "a".repeat(40));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.results ?? []).some((r) => r.name === "secret-scan")).toBe(true);
  });

  test("a short final page ends the walk without an extra request", async () => {
    const { api, calls } = fakeApi({ runs: [run("lint"), run("type-check")] });

    const result = await readCheckResults(api, "a".repeat(40));

    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.path.endsWith("/check-runs"))).toHaveLength(1);
  });

  test("an implausible number of checks refuses rather than paging forever", async () => {
    const runs = Array.from({ length: 100 * 11 }, (_, i) => run(`filler-${i}`));
    const { api } = fakeApi({ runs });

    const result = await readCheckResults(api, "a".repeat(40));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/1000 or more check runs/);
  });

  test("the cap says what it can actually tell, at the boundary itself", async () => {
    // Exactly 1000 — ten full pages — is the case where "more than 1000" was a
    // false statement. The cap is deliberate and refusing here is intended: a
    // commit with a thousand checks is not a state this gate reasons about.
    // What it may not do is describe that state incorrectly, because the whole
    // point of this round is that claims match what is known.
    const runs = Array.from({ length: 1000 }, (_, i) => run(`filler-${i}`));
    const { api } = fakeApi({ runs });

    const result = await readCheckResults(api, "a".repeat(40));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/1000 or more/);
    expect(result.reason).not.toMatch(/more than 1000/);
  });

  test("either surface failing is a refusal, never an empty result set", async () => {
    // An empty read is indistinguishable from "nothing was required", so an
    // HTTP error must never degrade into one.
    const checkRunsDown = await readCheckResults(fakeApi({ runs: [], failCheckRuns: 502 }).api, "a".repeat(40));
    expect(checkRunsDown.ok).toBe(false);

    const statusesDown = await readCheckResults(
      fakeApi({ runs: [run("lint")], failStatuses: 403 }).api,
      "a".repeat(40)
    );
    expect(statusesDown.ok).toBe(false);
    if (statusesDown.ok) return;
    expect(statusesDown.reason).toMatch(/commit statuses/i);
  });
});

describe("results carry the producer that makes them identifiable", () => {
  test("a check-run keeps its app slug; a status is marked as having none", async () => {
    const { api } = fakeApi({
      runs: [
        run("osv-scanner"),
        run("osv-scanner", { app: { slug: "github-advanced-security" } }),
        run("mystery", { app: undefined }),
      ],
      statuses: [{ context: "CodeRabbit", state: "success" }],
    });

    const result = await readCheckResults(api, "a".repeat(40));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results ?? []).toEqual([
      { producer: "github-actions", name: "osv-scanner", status: "completed", conclusion: "success" },
      { producer: "github-advanced-security", name: "osv-scanner", status: "completed", conclusion: "success" },
      // An app-less check-run must not silently inherit a real producer's
      // identity — "unknown" matches no required entry, so it refuses.
      { producer: "unknown", name: "mystery", status: "completed", conclusion: "success" },
      { producer: "commit-status", name: "CodeRabbit", status: "completed", conclusion: "success" },
    ]);
  });

  test("a pending status is not a passing one", async () => {
    const { api } = fakeApi({ runs: [], statuses: [{ context: "Vercel", state: "pending" }] });

    const result = await readCheckResults(api, "a".repeat(40));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.results ?? [])[0]).toMatchObject({ name: "Vercel", conclusion: "pending" });
  });
});
