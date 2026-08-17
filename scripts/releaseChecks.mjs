/**
 * Reading a commit's CI results, shared by the two places that need them.
 *
 * The `authorize` job asks before any credential exists. The `deploy` job asks
 * again immediately before deploying, because approval is asynchronous: a run
 * can sit waiting for a human for hours, and a check can be re-run red in that
 * window without `main` moving an inch. An earlier revision checked only main's
 * tip at that point, so "CI is green at that exact commit" was a statement about
 * authorisation time being quoted as though it were about deploy time.
 *
 * Both callers pass their own `api(path, query)` so each keeps its own refusal
 * behaviour; only the reading and the policy live here.
 */
import { readFileSync } from "node:fs";

export const POLICY_URL = new URL("../.github/release-waivers.json", import.meta.url);

/** The required-check policy, as data. */
export function loadReleasePolicy() {
  return JSON.parse(readFileSync(POLICY_URL, "utf8"));
}

/** Pages beyond this are a bug, not a busy commit. */
const MAX_PAGES = 10;
const PER_PAGE = 100;

/**
 * Every check result at one commit, from BOTH surfaces, fully paginated.
 *
 * ⚠️ Pagination is not a nicety here. `/check-runs` defaults to 30 per page and
 * this repository already produces 25 at a single commit, so the gate was one
 * new workflow job away from silently not seeing a required check — which reads
 * as "no result at this commit" and refuses every release. Fail-closed, but
 * inoperable, and for a reason nobody would look for.
 *
 * Both surfaces are read because they are different APIs and a check present in
 * one is invisible to the other: Actions jobs are check-runs, app integrations
 * report commit statuses. The combined `/status` endpoint is used rather than
 * `/statuses` deliberately — the latter returns the full history for a context,
 * which would look like several results for one identity and refuse as
 * ambiguous.
 *
 * `producer` is what makes a result identifiable: a GitHub App slug for a
 * check-run, or `commit-status` for a status, which carries no app identity at
 * all (`creator` is null).
 */
export async function readCheckResults(api, sha) {
  const results = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await api(`/commits/${sha}/check-runs`, { per_page: PER_PAGE, page });
    if (response.status !== 200) {
      return { ok: false, reason: `Could not read check runs for this commit (HTTP ${response.status}).` };
    }
    const runs = response.body.check_runs ?? [];
    for (const run of runs) {
      results.push({
        producer: run.app?.slug ?? "unknown",
        name: run.name,
        status: run.status,
        conclusion: run.conclusion ?? null,
      });
    }

    // ⚠️ Termination is decided by the PAGE SIZE, never by `total_count`.
    // Trusting a server-reported total means a total that is wrong — or that
    // shrinks mid-walk as a re-run replaces a check — silently ends the walk
    // early, and a required check on the page never fetched reads as "no result
    // at this commit". That refuses rather than passes, so it is safe; but it
    // refuses EVERY release, for a reason nobody would think to look for.
    if (runs.length < PER_PAGE) break;

    if (page === MAX_PAGES) {
      // ⚠️ A deliberate runaway cap, and the wording matters. Reaching here
      // means page `MAX_PAGES` came back FULL, so the true count is at least
      // `MAX_PAGES * PER_PAGE` and may be more — this cannot tell which, and
      // does not try. An earlier version said "more than 1000", which is a
      // false statement at exactly 1000. Refusing is right either way (a
      // commit with a thousand checks is not a state this gate reasons about);
      // saying something untrue about it is not.
      return {
        ok: false,
        reason: `This commit has ${MAX_PAGES * PER_PAGE} or more check runs, which is not a state this gate understands.`,
      };
    }
  }

  const statuses = await api(`/commits/${sha}/status`, { per_page: PER_PAGE });
  if (statuses.status !== 200) {
    return { ok: false, reason: `Could not read commit statuses (HTTP ${statuses.status}).` };
  }
  for (const status of statuses.body.statuses ?? []) {
    results.push({
      producer: "commit-status",
      name: status.context,
      // A status has no queued/in-progress distinction; `pending` is its
      // in-flight state and is carried through as the conclusion.
      status: "completed",
      conclusion: status.state === "success" ? "success" : status.state,
    });
  }

  return { ok: true, results };
}
