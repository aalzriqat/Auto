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
const RELEASE_CHECK = "trusted-accounting-release-verdict";
const TRUSTED_REHEARSAL_WORKFLOW = ".github/workflows/trusted-accounting-rehearsal.yml";

async function readCheckRuns(api, sha, filter) {
  const found = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await api(`/commits/${sha}/check-runs`, { per_page: PER_PAGE, page, filter });
    if (response.status !== 200) {
      return { ok: false, reason: `Could not read check runs for this commit (HTTP ${response.status}).` };
    }
    const runs = response.body.check_runs ?? [];
    found.push(...runs);
    // The page length, not total_count, determines whether another page exists.
    if (runs.length < PER_PAGE) return { ok: true, runs: found };
    if (page === MAX_PAGES) {
      return {
        ok: false,
        reason: `This commit has ${MAX_PAGES * PER_PAGE} or more check runs, which is not a state this gate understands.`,
      };
    }
  }
  throw new Error("Check-run pagination ended without a final page.");
}

async function verifyReleaseCheckOrigin(api, sha, check) {
  if (!Number.isSafeInteger(check.id) || check.id <= 0) {
    return "Release verdict has no GitHub Actions job identity.";
  }
  const jobResponse = await api(`/actions/jobs/${check.id}`);
  if (jobResponse.status !== 200) return "Release verdict is not a readable GitHub Actions job.";
  const job = jobResponse.body;
  if (job.id !== check.id || job.name !== RELEASE_CHECK || job.head_sha !== sha ||
      !Number.isSafeInteger(job.run_id) || job.run_id <= 0 ||
      typeof job.check_run_url !== "string" ||
      !job.check_run_url.endsWith(`/check-runs/${check.id}`)) {
    return "Release verdict job identity does not match the check run and release SHA.";
  }
  const runResponse = await api(`/actions/runs/${job.run_id}`);
  if (runResponse.status !== 200) return "Release verdict workflow run is unavailable.";
  const workflow = runResponse.body;
  if (workflow.id !== job.run_id || workflow.path !== TRUSTED_REHEARSAL_WORKFLOW ||
      workflow.event !== "repository_dispatch" || workflow.head_sha !== sha ||
      workflow.head_branch !== "main") {
    return "Release verdict did not originate from the trusted main-only dispatch workflow.";
  }
  return null;
}

/**
 * Current ordinary check results plus every release-verdict attempt at one
 * commit, from BOTH surfaces, fully paginated.
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
 * Ordinary checks use the existing GitHub App slug or commit-status identity.
 * The release verdict also proves the check-run ID belongs to a real Actions
 * job in this default-branch repository_dispatch workflow; a matching name
 * and GitHub Actions app slug alone are forgeable.
 */
export async function readCheckResults(api, sha) {
  const results = [];
  // Preserve the established "rerun failed jobs" policy for ordinary checks.
  // The new release verdict has a stronger rule: every same-SHA attempt counts.
  const latest = await readCheckRuns(api, sha, "latest");
  if (!latest.ok) return { ok: false, reason: latest.reason, results: [] };
  const all = await readCheckRuns(api, sha, "all");
  if (!all.ok) return { ok: false, reason: all.reason, results: [] };
  const runs = [
    ...latest.runs.filter((run) => run.name !== RELEASE_CHECK),
    ...all.runs.filter((run) => run.name === RELEASE_CHECK),
  ];
  for (const run of runs) {
    if (run.name === RELEASE_CHECK) {
      const originError = await verifyReleaseCheckOrigin(api, sha, run);
      if (originError) return { ok: false, reason: originError, results: [] };
    }
    results.push({
      producer: run.app?.slug ?? "unknown",
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
    });
  }

  const statuses = await api(`/commits/${sha}/status`, { per_page: PER_PAGE });
  if (statuses.status !== 200) {
    return { ok: false, reason: `Could not read commit statuses (HTTP ${statuses.status}).`, results: [] };
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

  return { ok: true, reason: "", results };
}
