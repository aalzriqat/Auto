// Shared fake GitHub for the trusted PR gate tests: a non-test helper so the
// own-record tests can live in their own file (SOURCE-LINES-MAX).
export const load = () => import("../scripts/intelligence/trustedPrE2eGate.mjs");
export const identity = {
  headSha: "a".repeat(40),
  testedSha: "b".repeat(40),
  controllerSha: "c".repeat(40),
};

/** The record id a publication returned; fails loudly if it is not a number. */
export function recordIdOf(result: { record?: Record<string, unknown> }): number {
  const id = result.record?.id;
  if (typeof id !== "number") throw new Error("The publication returned no numeric record id.");
  return id;
}

export type Run = {
  id: number;
  path: string;
  event: string;
  head_branch: string;
};
export type Rec = {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  external_id?: string;
  app: { slug: string };
  check_suite?: { id: number };
  output?: { title?: string; text?: string };
};
export const REPOSITORY = "aalzriqat/Auto";
export const SWARM_PATH = ".github/workflows/browser-attack-swarm.yml";
export const swarm = (id: number): Run => ({
  id,
  path: SWARM_PATH,
  event: "workflow_run",
  head_branch: "main",
});
export const forgedRun: Run = {
  id: 7,
  path: ".github/workflows/forge.yml",
  event: "push",
  head_branch: "feature",
};

/** API-created checks share an app suite; in this repository GitHub places them
 * in the dynamic CodeQL suite, independently of the workflow holding the token.
 * PATCH retains that suite. Explicit insert() fixtures also exercise legacy data. */
export function github() {
  const records: Rec[] = [];
  const runsBySuite = new Map<number, Run>();
  const calls: string[] = [];
  const publications: Array<Record<string, unknown>> = [];
  let nextId = 9;
  let runLookup: "ok" | "fail" = "ok";
  let lagAfterPost = 0;
  let getFailures = 0;
  const scriptedListings: number[][] = [];
  let listing: Rec[] = [];
  let listingFailure: { page: number; times: number; skip: number } | undefined;
  let getOverride: Rec | undefined;
  const lag = new Map<number, number>();
  const api = async (
    method: string,
    route: string,
    body?: Record<string, unknown>,
  ) => {
    calls.push(`${method} ${route.split("?")[0]}`);
    if (method !== "GET" && body) publications.push(structuredClone(body));
    if (method === "GET" && route.startsWith("/commits/")) {
      // GitHub's commit check-run listing is eventually consistent: a record
      // POSTed moments ago may be absent for a few listings.
      // Pages of 100, as GitHub serves them. One snapshot per listing (page 1).
      const page = Number(new URL(`https://x${route}`).searchParams.get("page") ?? 1);
      if (page === 1) {
        const scripted = scriptedListings.shift();
        listing = scripted
          ? records.filter((entry) => scripted.includes(entry.id as number)).map((entry) => structuredClone(entry))
          : records.filter((entry) => {
              const remaining = lag.get(entry.id) ?? 0;
              if (remaining <= 0) return true;
              lag.set(entry.id, remaining - 1);
              return false;
            });
      }
      if (listingFailure?.page === page && listingFailure.skip > 0) listingFailure.skip--;
      else if (listingFailure?.page === page && listingFailure.times > 0) {
        listingFailure.times--;
        throw new Error("GitHub gate request failed.");
      }
      return { check_runs: listing.slice((page - 1) * 100, page * 100) };
    }
    if (method === "GET" && route.startsWith("/actions/runs?")) {
      if (runLookup === "fail") throw new Error("GitHub gate request failed.");
      const suite = Number(
        new URL(`https://x${route}`).searchParams.get("check_suite_id"),
      );
      const run = runsBySuite.get(suite);
      return {
        total_count: run ? 1 : 0,
        workflow_runs: run
          ? [{ ...run, check_suite_id: suite, repository: { full_name: REPOSITORY } }]
          : [],
      };
    }
    if (method === "POST") {
      const id = nextId++;
      runsBySuite.set(110584846427, {
        id: 40796582338,
        path: "dynamic/github-code-scanning/codeql",
        event: "dynamic",
        head_branch: "feature",
      });
      const record = {
        id,
        app: { slug: "github-actions" },
        check_suite: { id: 110584846427 },
        ...body,
      } as Rec;
      records.push(record);
      if (lagAfterPost > 0) lag.set(id, lagAfterPost);
      return record;
    }
    if (method === "GET" && /^\/check-runs\/\d+$/.test(route)) {
      if (getFailures > 0) {
        getFailures--;
        throw new Error("GitHub gate request failed.");
      }
      if (getOverride) return getOverride;
    }
    const record = records.find((entry) => `/check-runs/${entry.id}` === route);
    if (!record) throw new Error("no such check");
    Object.assign(record, body);
    return record;
  };
  const insert = (
    overrides: Partial<Rec>,
    run: Run | undefined,
    suite = 2000 + records.length,
  ) => {
    if (run) runsBySuite.set(suite, run);
    const record = {
      id: 500 + records.length,
      name: "authenticated-pr-e2e",
      head_sha: identity.headSha,
      status: "completed",
      conclusion: "success",
      app: { slug: "github-actions" },
      check_suite: { id: suite },
      ...overrides,
    } as Rec;
    records.push(record);
    return record;
  };
  return {
    api,
    records,
    calls,
    publications,
    insert,
    /** Records POSTed after this call stay out of the next `listings` listings. */
    lagNextPosts: (listings: number) => {
      lagAfterPost = listings;
    },
    /** Hide an existing record from the next `listings` listings. */
    hide: (record: Rec, listings: number) => {
      lag.set(record.id as number, listings);
    },
    /** The next `reads` GET /check-runs/{id} calls fail (5xx, timeout or 404 lag). */
    failGetById: (reads: number) => {
      getFailures = reads;
    },
    /** GET /check-runs/{id} returns this payload instead of the stored record. */
    answerGetWith: (record: Rec) => {
      getOverride = record;
    },
    clearLag: () => lag.clear(),
    /** The next `times` requests for listing page `page` throw (a 5xx or timeout). */
    failListingPage: (page: number, times: number, skip = 0) => {
      listingFailure = { page, times, skip };
    },
    /** The next listings show exactly these record ids, one array per listing. */
    scriptListings: (...listings: number[][]) => {
      scriptedListings.push(...listings);
    },
    breakRunLookup: () => {
      runLookup = "fail";
    },
    writes: () => calls.filter((call) => !call.startsWith("GET")),
  };
}
export const publishInput = (runId: number, attempt = 1) => ({
  headSha: identity.headSha,
  prNumber: 42,
  repository: REPOSITORY,
  runId,
  runKey: `${runId}:${attempt}`,
  summary: "counts pending",
  detailsUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
});
export const success = { conclusion: "success", reason: "counted suite passed" };
