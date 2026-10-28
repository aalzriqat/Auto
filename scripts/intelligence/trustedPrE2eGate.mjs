// SCRUM-757. This module is loaded exclusively from the default-branch revision.
import { compareCodeUnits } from "../contractSkew/compareCodeUnits.mjs";
export const PR_E2E_CHECK = "authenticated-pr-e2e";
const definition = (file) =>
  /^playwright\/tests\/.*\.(?:spec|setup)\.[cm]?[jt]sx?$/.test(file);

export function planPrE2e(changedFiles, mainFiles) {
  if (
    !Array.isArray(changedFiles) ||
    !Array.isArray(mainFiles) ||
    [...changedFiles, ...mainFiles].some(
      (file) => typeof file !== "string" || !file || /[\x00-\x1f]/.test(file),
    )
  ) {
    throw new Error("The trusted file inventory is unavailable.");
  }
  // Unknown files fail into scope. MDX and executable examples are not docs.
  const inScope =
    changedFiles.length === 0 ||
    changedFiles.some((file) => !/^(?:docs\/.*\.md|[^/]+\.md)$/.test(file));
  return {
    inScope,
    reason: inScope
      ? "Full trusted authenticated suite required for non-documentation or unavailable impact."
      : "Out of scope: changes contain documentation Markdown only.",
    mainDefinitions: [...new Set(mainFiles.filter(definition))].sort(compareCodeUnits),
    changedDefinitions: [...new Set(changedFiles.filter(definition))].sort(compareCodeUnits),
  };
}

function collectedTests(report) {
  if (!report || !Array.isArray(report.suites))
    throw new Error("Playwright suites are unavailable.");
  const tests = [];
  const visit = (suites) => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        if (
          typeof spec.id !== "string" ||
          typeof spec.file !== "string" ||
          !Array.isArray(spec.tests)
        )
          throw new Error("Invalid test definition.");
        for (const test of spec.tests) {
          if (test.projectName !== "chromium")
            throw new Error("Unexpected project in authenticated suite.");
          tests.push({
            key: spec.file + ":" + spec.id + ":" + test.projectName,
            file: spec.file,
            test,
          });
        }
      }
      visit(suite.suites ?? []);
    }
  };
  visit(report.suites);
  if (
    !tests.length ||
    new Set(tests.map((entry) => entry.key)).size !== tests.length
  )
    throw new Error("Empty or duplicate test inventory.");
  return tests;
}

export function executionEvidence(report, discovery, identity) {
  if (
    ![identity?.headSha, identity?.testedSha, identity?.controllerSha].every(
      (sha) => /^[a-f0-9]{40}$/.test(sha ?? ""),
    )
  )
    throw new Error("Exact candidate identity is unavailable.");
  const actual = collectedTests(report);
  const expected = collectedTests(discovery);
  if (
    JSON.stringify(actual.map((entry) => entry.key).sort(compareCodeUnits)) !==
    JSON.stringify(expected.map((entry) => entry.key).sort(compareCodeUnits))
  )
    throw new Error("Executed tests differ from trusted discovery.");
  if (!Array.isArray(report.errors) || report.errors.length)
    throw new Error("Playwright reported a global error.");
  let flaky = 0;
  for (const { test } of actual) {
    const results = test.results;
    if (
      test.expectedStatus !== "passed" ||
      !["expected", "flaky"].includes(test.status) ||
      !Array.isArray(results) ||
      !results.length ||
      results.at(-1)?.status !== "passed" ||
      results.some(
        (result) => !["passed", "failed", "timedOut"].includes(result.status),
      )
    )
      throw new Error("An applicable authenticated test did not pass.");
    if (test.status === "flaky") flaky++;
  }
  const stats = report.stats;
  if (
    !stats ||
    stats.unexpected !== 0 ||
    stats.skipped !== 0 ||
    stats.flaky !== flaky ||
    stats.expected !== actual.length - flaky
  )
    throw new Error("Playwright counts do not match executed tests.");
  return {
    ...identity,
    total: actual.length,
    passed: actual.length,
    flaky,
    skipped: 0,
    executedDefinitions: [...new Set(actual.map((entry) => entry.file))].sort(compareCodeUnits),
  };
}

/**
 * @param {{ plan?: ReturnType<typeof planPrE2e>, fresh: boolean, sameRepository?: boolean,
 * result?: string, evidence?: ReturnType<typeof executionEvidence>, headSha?: string,
 * testedSha?: string, controllerSha?: string }} input
 */
export function prE2eVerdict({
  plan,
  fresh,
  sameRepository,
  result,
  evidence,
  headSha,
  testedSha,
  controllerSha,
}) {
  const fail = (reason) => ({ conclusion: "failure", reason });
  if (!fresh)
    return fail("The PR head, base or tested merge is stale or unreadable.");
  if (!plan) return fail("Trusted scope is unavailable.");
  if (plan.inScope === false)
    return { conclusion: "success", reason: plan.reason };
  if (!sameRepository)
    return fail(
      "In-scope fork execution is unsupported by the trusted credential boundary.",
    );
  if (result !== "success")
    return fail(
      "The applicable authenticated suite could not run successfully.",
    );
  if (
    !evidence ||
    !/^[a-f0-9]{40}$/.test(testedSha ?? "") ||
    evidence.headSha !== headSha ||
    evidence.testedSha !== testedSha ||
    evidence.controllerSha !== controllerSha ||
    !Number.isSafeInteger(evidence.total) ||
    evidence.total <= 0 ||
    evidence.passed !== evidence.total ||
    evidence.skipped !== 0 ||
    !Number.isSafeInteger(evidence.flaky) ||
    evidence.flaky < 0 ||
    evidence.flaky > evidence.total ||
    !Array.isArray(evidence.executedDefinitions) ||
    !evidence.executedDefinitions.length ||
    evidence.executedDefinitions.some(
      (file) => typeof file !== "string" || !file,
    )
  ) {
    return fail(
      "Counted exact-candidate authenticated evidence is unavailable.",
    );
  }
  return {
    conclusion: "success",
    reason: `Full trusted suite passed: ${evidence.passed}/${evidence.total}, skipped 0, flaky ${evidence.flaky ?? 0}.`,
  };
}

// ---------------------------------------------------------------------------
// Publication. Origin of an existing record is PROVEN, never read from fields a
// writer chooses. `external_id`, `output` and `details_url` are writable by any
// workflow token in the repository, so they are informational only. The proof
// follows scripts/releaseChecks.mjs: check suite -> workflow run -> workflow
// path, event and branch. Only `workflow_run` and `pull_request_target` load the
// workflow definition from the default branch; a run of the same path under any
// other event ran the branch's own copy and is refused.
//
// This is detection and neutralisation by trusted code, NOT a barrier: any
// workflow of this repository holding `checks: write` shares the GitHub Actions
// app identity and can still write or patch the check after this code runs.
// Docs: Checks API (create/update a check run), List workflow runs
// (`check_suite_id` filter), workflow-syntax `permissions`.
// ---------------------------------------------------------------------------
export const TRUSTED_WRITERS = Object.freeze([
  Object.freeze({
    kind: "admission",
    path: ".github/workflows/authenticated-pr-e2e.yml",
    event: "pull_request_target",
    branch: undefined,
  }),
  Object.freeze({
    kind: "swarm",
    path: ".github/workflows/browser-attack-swarm.yml",
    event: "workflow_run",
    branch: "main",
  }),
]);
const MODES = new Set(["initialize", "begin", "reset", "finish"]);

/** @returns {Promise<{ok: true, kind: string, runId: number} | {ok: false, reason: string}>} */
async function establishOrigin(api, record, repository) {
  const unproven = (reason) => ({ ok: false, reason });
  const suiteId = record.check_suite?.id;
  if (!Number.isSafeInteger(suiteId) || suiteId <= 0)
    return unproven("the record has no check suite");
  let payload;
  try {
    payload = await api(
      "GET",
      `/actions/runs?check_suite_id=${suiteId}&per_page=2`,
    );
  } catch {
    return unproven("the owning workflow run could not be read");
  }
  const runs = payload?.workflow_runs;
  if (!Array.isArray(runs) || runs.length !== 1)
    return unproven("the check suite does not resolve to exactly one run");
  const run = runs[0];
  const writer = TRUSTED_WRITERS.find(
    (entry) => entry.path === run.path && entry.event === run.event,
  );
  if (
    !writer ||
    run.check_suite_id !== suiteId ||
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    run.repository?.full_name !== repository ||
    (writer.branch !== undefined && run.head_branch !== writer.branch)
  )
    return unproven("the owning run is not a default-branch gate workflow");
  return { ok: true, kind: writer.kind, runId: run.id };
}

async function listGateRecords(api, headSha) {
  const matches = [];
  for (let page = 1; page <= 100; page++) {
    const payload = await api(
      "GET",
      `/commits/${headSha}/check-runs?check_name=${PR_E2E_CHECK}&filter=all&per_page=100&page=${page}`,
    );
    if (!Array.isArray(payload.check_runs))
      throw new Error("Check inventory unavailable.");
    matches.push(
      ...payload.check_runs.filter(
        (check) =>
          check.name === PR_E2E_CHECK && check.app?.slug === "github-actions",
      ),
    );
    if (payload.check_runs.length < 100) break;
    if (page === 100) throw new Error("Check inventory exceeded its bound.");
  }
  return matches;
}

/**
 * Read-only arming assertion for jobs that run or feed candidate code and hold
 * only `checks: read`. A job-level rerun starts without re-running
 * `e2e-gate-begin` (GitHub re-runs a selected job and its dependents, never its
 * ancestors), so such a job must not work beside a standing success. Any
 * same-app success counts, proven or not: nothing here needs origin to refuse.
 */
export async function gateIsArmed(api, headSha) {
  const records = await listGateRecords(api, headSha);
  return !records.some(
    (record) => record.status === "completed" && record.conclusion === "success",
  );
}

async function quarantine(api, records, reasons, detailsUrl) {
  const body = {
    status: "completed",
    conclusion: "failure",
    details_url: detailsUrl,
    output: {
      title: "Authenticated PR gate records are unproven or duplicated",
      summary:
        "This head has a same-name GitHub Actions check that trusted code cannot prove it wrote, or more than one such check. GitHub cannot delete check runs, so this head stays failed. Push a new commit. Reasons: " +
        reasons.join("; "),
    },
  };
  for (const record of records) {
    if (record.status === "completed" && record.conclusion === "failure")
      continue;
    await api("PATCH", `/check-runs/${record.id}`, body);
  }
  return { outcome: "quarantined", record: records[0] };
}

// The caller serializes initialize, begin and finish for a head with one Actions
// concurrency group; reset only updates a record that already exists.
/** @param {(method: string, route: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>} api
 * @param {{headSha: string, prNumber: number, repository: string, runId: number, runKey?: string,
 * mode: "initialize" | "begin" | "reset" | "finish",
 * verdict?: {conclusion: string, reason: string} | null, summary?: string, detailsUrl?: string}} options
 * @returns {Promise<{outcome: "written" | "kept" | "obsolete" | "quarantined", record?: Record<string, unknown>}>} */
export async function publishPrE2eCheck(
  api,
  {
    headSha,
    prNumber,
    repository,
    runId,
    runKey = "",
    mode,
    verdict = null,
    summary = "",
    detailsUrl = "",
  },
) {
  if (!MODES.has(mode)) throw new Error("Unknown gate publication mode.");
  if (!Number.isSafeInteger(runId) || runId <= 0)
    throw new Error("Trusted run identity is unavailable.");
  const records = await listGateRecords(api, headSha);
  const origins = [];
  for (const record of records)
    origins.push(await establishOrigin(api, record, repository));
  const reasons = origins.flatMap((origin) => (origin.ok ? [] : [origin.reason]));
  if (records.length > 1) reasons.push("more than one same-name record exists");
  // Any unexpected or unprovable record is failure at this head, never a throw
  // that leaves an existing success standing.
  if (reasons.length) return quarantine(api, records, reasons, detailsUrl);

  const previous = records[0];
  const origin = origins[0];
  if (previous && mode === "initialize") return { outcome: "kept", record: previous };
  // Run ids only order two swarm runs. Admission and swarm ids are not
  // comparable evidence of recency, and attempts of one run are serial.
  if (
    previous &&
    mode !== "initialize" &&
    origin?.ok &&
    origin.kind === "swarm" &&
    origin.runId > runId
  )
    return { outcome: "obsolete", record: previous };
  if (!previous && mode === "reset")
    throw new Error("There is no gate record to reset.");

  const pending = mode === "begin" || mode === "reset" || mode === "initialize";
  const body = {
    name: PR_E2E_CHECK,
    external_id: `g5:${prNumber}:${runKey}`,
    details_url: detailsUrl,
    // A retry revokes an older success before I/O. Completed failure is also
    // blocking if this workflow is then cancelled or its final job never starts.
    status: "completed",
    conclusion: pending ? "failure" : (verdict?.conclusion ?? "failure"),
    output: {
      title: pending
        ? "Authenticated PR execution pending"
        : (verdict?.reason ?? "Authenticated PR execution unavailable"),
      summary: summary || "No counted authenticated evidence is available.",
    },
  };
  const record = previous
    ? await api("PATCH", `/check-runs/${previous.id}`, body)
    : await api("POST", "/check-runs", { ...body, head_sha: headSha });
  return { outcome: "written", record };
}
