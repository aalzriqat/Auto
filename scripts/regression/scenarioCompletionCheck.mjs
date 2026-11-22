import { matchesScenarioCheckUrl } from "./scenarioCompletionCheckUrl.mjs";

export const SCENARIO_COMPLETION_CHECK = "pr-scenario-runner";

const SHA = /^[a-f0-9]{40}$/u;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
const MESSAGES = Object.freeze({
  pending: {
    WAITING_FOR_PRODUCERS: "Awaiting current scenario producers.",
    LOCAL_SCENARIOS_PENDING: "Awaiting current local scenario execution.",
    BROWSER_EVIDENCE_PENDING: "Awaiting current protected browser evidence.",
  },
  failure: {
    LOCAL_SCENARIOS_FAILED: "Current local scenario execution did not succeed.",
    SCENARIO_EVIDENCE_INVALID: "Current scenario evidence could not be verified.",
    SCENARIO_CERTIFICATION_UNAVAILABLE: "Current scenario verification is unavailable.",
    BROWSER_EVIDENCE_INVALID: "Current protected browser evidence could not be verified.",
  },
  success: {
    SCENARIO_EVIDENCE_COMPLETE: "All required current scenario evidence was verified.",
  },
});
const TITLES = Object.freeze({
  pending: "Awaiting scenario evidence",
  failure: "Scenario evidence failed",
  success: "Scenario evidence verified",
});
const DEFAULT_CODES = Object.freeze({
  pending: "WAITING_FOR_PRODUCERS",
  failure: "SCENARIO_CERTIFICATION_UNAVAILABLE",
  success: "SCENARIO_EVIDENCE_COMPLETE",
});

function publicationBody(candidate, verdict, detailsUrl) {
  const hasRun = positiveId(candidate?.workflowRunId) && positiveId(candidate?.workflowAttempt);
  const absentRun = candidate?.workflowRunId === undefined && candidate?.workflowAttempt === undefined;
  if (!positiveId(candidate?.repositoryId) || !positiveId(candidate?.prNumber) ||
      ![candidate.baseSha, candidate.headSha, candidate.testedSha].every(value => typeof value === "string" && SHA.test(value)) ||
      (!hasRun && !absentRun) || !Object.hasOwn(MESSAGES, verdict?.kind ?? "") ||
      (verdict.kind === "success" && !hasRun)) {
    throw new Error("SCENARIO_COMPLETION_PUBLICATION_INVALID");
  }
  if (typeof detailsUrl !== "string" || (detailsUrl !== "" &&
      !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/actions\/runs\/[1-9][0-9]{0,14}(?:\/attempts\/[1-9][0-9]{0,14})?$/u.test(detailsUrl))) {
    throw new Error("SCENARIO_COMPLETION_PUBLICATION_INVALID");
  }
  const counts = verdict.counts;
  if (counts !== undefined && (!count(counts?.selected) || !count(counts?.passed) ||
      counts.passed > counts.selected || (verdict.kind === "success" && counts.passed !== counts.selected))) {
    throw new Error("SCENARIO_COMPLETION_PUBLICATION_INVALID");
  }
  const messages = MESSAGES[verdict.kind];
  const code = typeof verdict.code === "string" && Object.hasOwn(messages, verdict.code)
    ? verdict.code : DEFAULT_CODES[verdict.kind];
  const runText = hasRun ? `Local run ${candidate.workflowRunId}, attempt ${candidate.workflowAttempt}.` : "Local run not yet available.";
  return {
    name: SCENARIO_COMPLETION_CHECK,
    external_id: `scenario:${candidate.prNumber}:${candidate.testedSha}`,
    details_url: detailsUrl,
    // GitHub documents that a supplied conclusion forces completed status.
    // A completed failure also revokes an earlier success on every rerun.
    status: "completed",
    conclusion: verdict.kind === "success" ? "success" : "failure",
    output: {
      title: TITLES[verdict.kind],
      summary: `${messages[code]} Code: ${code}.` +
        (counts === undefined ? "" : ` Selected scenarios: ${counts.selected}. Passed scenarios: ${counts.passed}.`),
      text: `Repository ${candidate.repositoryId}; PR ${candidate.prNumber}. ${runText}\n` +
        `Base ${candidate.baseSha}; head ${candidate.headSha}; tested merge ${candidate.testedSha}.` +
        (detailsUrl === "" ? "" : `\nTrusted verification workflow ${detailsUrl}.`),
    },
  };
}

async function destination(api, testedSha) {
  const inventory = await api("GET", `/commits/${testedSha}/check-runs?check_name=${SCENARIO_COMPLETION_CHECK}&filter=all&per_page=100`);
  if (!Array.isArray(inventory?.check_runs) || !count(inventory.total_count) || inventory.total_count > 100 ||
      inventory.check_runs.length !== inventory.total_count ||
      inventory.check_runs.some(check => !positiveId(check?.id) || check.name !== SCENARIO_COMPLETION_CHECK || check.head_sha !== testedSha) ||
      new Set(inventory.check_runs.map(check => check.id)).size !== inventory.total_count) {
    throw new Error("SCENARIO_COMPLETION_INVENTORY_INVALID");
  }
  const matches = inventory.check_runs.filter(check => check.app?.slug === "github-actions");
  if (matches.length > 1) throw new Error("SCENARIO_COMPLETION_CHECKS_AMBIGUOUS");
  if (inventory.total_count > 0 && matches.length === 0) throw new Error("SCENARIO_COMPLETION_PRODUCER_INVALID");
  return matches[0];
}

function matchesBody(record, body) {
  return record?.name === body.name && record.external_id === body.external_id &&
    matchesScenarioCheckUrl(record, body.details_url) && record.status === body.status && record.conclusion === body.conclusion &&
    ["title", "summary", "text"].every(key => record.output?.[key] === body.output[key]);
}

/**
 * The protected caller serializes publications for a candidate and verifies
 * source identity in snapshot(). Existing check metadata is a destination,
 * never evidence. Only an explicit successful aggregation may publish green.
 */
export async function publishScenarioCompletion({ api, candidate, verdict, detailsUrl = "", snapshot, now = () => new Date() }) {
  if (typeof api !== "function" || typeof snapshot !== "function" || typeof now !== "function") {
    throw new Error("SCENARIO_COMPLETION_PUBLICATION_INVALID");
  }
  const body = publicationBody(candidate, verdict, detailsUrl);
  const previous = await destination(api, candidate.testedSha);
  // Even an identical repeated callback must establish that its source is current.
  if (await snapshot() === false) throw new Error("SCENARIO_COMPLETION_SNAPSHOT_STALE");
  if (previous && matchesBody(previous, body)) return { outcome: "unchanged", record: previous };
  const time = now();
  if (!(time instanceof Date) || !Number.isFinite(time.getTime())) throw new Error("SCENARIO_COMPLETION_PUBLICATION_INVALID");
  let record;
  try {
    record = await api(previous ? "PATCH" : "POST", previous ? `/check-runs/${previous.id}` : "/check-runs", {
      ...body, completed_at: time.toISOString(), ...(previous ? {} : { head_sha: candidate.testedSha }),
    });
  } catch {
    // A lost response may follow a successful write. No retry or fallback POST.
    throw new Error("SCENARIO_COMPLETION_PUBLICATION_UNKNOWN");
  }
  if (!positiveId(record?.id) || (previous && record.id !== previous.id) || record.head_sha !== candidate.testedSha ||
      record.app?.slug !== "github-actions" || !matchesBody(record, body)) {
    throw new Error("SCENARIO_COMPLETION_PUBLICATION_UNKNOWN");
  }
  return { outcome: "written", record };
}
