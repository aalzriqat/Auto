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

// The caller serializes all writers for a PR with one Actions concurrency group.
// Reuse a check rather than creating duplicate producer/name results on reruns.
/** @param {(method: string, route: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>} api
 * @param {{headSha: string, prNumber: number, runKey?: string, mode: string,
 * verdict?: {conclusion: string, reason: string} | null, summary?: string, detailsUrl?: string}} options */
export async function publishPrE2eCheck(
  api,
  {
    headSha,
    prNumber,
    runKey = "",
    mode,
    verdict = null,
    summary = "",
    detailsUrl = "",
  },
) {
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
  if (matches.length > 1)
    throw new Error("Duplicate GitHub Actions PR gates require investigation.");
  const previous = matches[0];
  const prefix = `g5:${prNumber}:`;
  if (previous && !previous.external_id?.startsWith(prefix))
    throw new Error("PR gate has an unexpected writer.");
  if (mode === "initialize" && previous) return previous;
  const externalId = prefix + runKey;
  const [oldRun, oldAttempt] = (previous?.external_id ?? "")
    .slice(prefix.length)
    .split(":")
    .map(Number);
  const [newRun, newAttempt] = runKey.split(":").map(Number);
  // GitHub can rerun a failed job and its dependents without rerunning begin.
  // Accept that run's later attempt; never accept an older attempt or run.
  const laterJobRerun = oldRun === newRun && newAttempt > oldAttempt;
  if (
    mode === "finish" &&
    previous?.external_id !== externalId &&
    !laterJobRerun
  )
    throw new Error("An obsolete attempt cannot publish a verdict.");
  if (mode === "begin" && previous) {
    if (oldRun > newRun || (oldRun === newRun && oldAttempt > newAttempt))
      throw new Error("An obsolete attempt cannot restart the gate.");
  }
  const pending = mode === "begin";
  const body = {
    name: PR_E2E_CHECK,
    external_id: externalId,
    details_url: detailsUrl,
    // A retry revokes an older success before I/O. Completed failure is also
    // blocking if this workflow is then cancelled or its final job never starts.
    status: "completed",
    conclusion: pending ? "failure" : (verdict?.conclusion ?? "failure"),
    output: {
      title: pending
        ? "Authenticated PR execution pending"
        : (verdict?.reason ?? "Authenticated PR execution unavailable"),
      summary: summary ?? "No counted authenticated evidence is available.",
    },
  };
  return previous
    ? api("PATCH", `/check-runs/${previous.id}`, body)
    : api("POST", "/check-runs", { ...body, head_sha: headSha });
}
