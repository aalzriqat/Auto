import { isProtectedReplayBinding } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { PR_E2E_CHECK } from "../intelligence/trustedPrE2eGate.mjs";
import { loadRecords, selectForPr } from "./prRunner.mjs";
import { scenarioEvidenceDigest } from "./prScenarioEvidence.mjs";
import { aggregateScenarioEvidence } from "./scenarioRegistrySource.mjs";
import { buildBrowserReplayManifest } from "./trustedBrowserManifest.mjs";
import { matchesTrustedRunIdentity } from "./trustedBrowserReceipt.mjs";
import { collectHostedBrowserReplays, readProtectedReplayDiff, readPublishedLocalScenarios } from "./trustedBrowserSource.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:([a-f0-9]{64})$/u;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const PENDING = new Set(["requested", "queued", "pending", "waiting", "in_progress"]);
const REQUIRED_LOCAL_STEPS = Object.freeze(["Run the static visual projects", "Run the library's bound local scenarios",
  "Publish the selected local verdicts and bindings"]);
const completedSuccessfully = value => value?.status === "completed" && value.conclusion === "success";
const timestamp = value => typeof value === "string" ? Date.parse(value) : Number.NaN;
const stamp = run => ({ id: run?.id, attempt: run?.run_attempt, status: run?.status, conclusion: run?.conclusion ?? null,
  headSha: run?.head_sha, workflowId: run?.workflow_id });
const publicationStamp = check => ({ id: check?.id, externalId: check?.external_id,
  status: check?.status, conclusion: check?.conclusion ?? null, headSha: check?.head_sha,
  summaryDigest: typeof check?.output?.summary === "string" ? scenarioEvidenceDigest(check.output.summary) : null });

function sameStamp(actual, expected) {
  return actual !== null && typeof actual === "object" && !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.keys(expected).every(key => Object.hasOwn(actual, key) && actual[key] === expected[key]);
}

/** Bind receipt reads to the source state that the publisher will revalidate. */
export function matchesScenarioCompletionEvidenceSnapshot(fingerprint, { localRun, publication, producerRun }) {
  try {
    if (typeof fingerprint !== "string" || !positiveId(localRun?.id) || !positiveId(localRun.run_attempt)) return false;
    const value = JSON.parse(fingerprint);
    if (!value || Object.keys(value).length !== 3 || !sameStamp(value.localRun, stamp(localRun))) return false;
    // Unselected protected browsers supply no evidence to this aggregation.
    if (value.publication === null && value.producerRun === null) return true;
    return positiveId(publication?.id) && positiveId(producerRun?.id) && positiveId(producerRun.run_attempt) &&
      sameStamp(value.publication, publicationStamp(publication)) && sameStamp(value.producerRun, stamp(producerRun));
  } catch {
    return false;
  }
}

function inventory(payload, field) {
  const entries = payload?.[field];
  if (!Array.isArray(entries) || entries.length !== payload.total_count || entries.length > 100) {
    throw new Error("SCENARIO_COMPLETION_INVENTORY_INVALID");
  }
  return entries;
}

function localRunMatches(run, candidate) {
  return [candidate?.repositoryId, candidate?.prNumber, candidate?.workflowRunId, candidate?.workflowAttempt].every(positiveId) &&
    [candidate?.baseSha, candidate?.headSha, candidate?.testedSha].every(sha => typeof sha === "string" && SHA.test(sha)) &&
    run?.id === candidate.workflowRunId && run.run_attempt === candidate.workflowAttempt && positiveId(run.workflow_id) &&
    run.path === ".github/workflows/scenario-runner.yml" && run.event === "pull_request" &&
    run.repository?.id === candidate.repositoryId && run.head_repository?.id === candidate.repositoryId &&
    run.head_sha === candidate.headSha && (run.status === "completed" || PENDING.has(run.status));
}

function verifiedLocalJob(api, candidate) {
  const jobs = inventory(api(`/actions/runs/${candidate.workflowRunId}/attempts/${candidate.workflowAttempt}/jobs?per_page=100`), "jobs");
  const matches = jobs.filter(job => job?.name === "local-scenarios");
  const [job] = matches;
  const start = timestamp(job?.started_at);
  const end = timestamp(job?.completed_at);
  if (matches.length !== 1 || !completedSuccessfully(job) || job.run_id !== candidate.workflowRunId ||
      job.run_attempt !== candidate.workflowAttempt || !Number.isFinite(start) || !Number.isFinite(end) || end < start ||
      !Array.isArray(job.steps) || !REQUIRED_LOCAL_STEPS.every(name => {
        const steps = job.steps.filter(step => step?.name === name);
        return steps.length === 1 && completedSuccessfully(steps[0]);
      })) throw new Error("SCENARIO_EVIDENCE_INVALID");
  return { start, end };
}

function verifiedLocalArtifact(api, candidate, window) {
  const name = `pr-local-scenarios-${candidate.workflowRunId}-${candidate.workflowAttempt}`;
  const matches = inventory(api(`/actions/runs/${candidate.workflowRunId}/artifacts?name=${name}&per_page=100`), "artifacts")
    .filter(artifact => artifact?.name === name);
  if (matches.length !== 1 || !positiveId(matches[0]?.id)) throw new Error("SCENARIO_EVIDENCE_INVALID");
  const artifact = api(`/actions/artifacts/${matches[0].id}`);
  const created = timestamp(artifact?.created_at);
  const updated = timestamp(artifact?.updated_at);
  if (artifact?.id !== matches[0].id || artifact.name !== name || artifact.expired !== false ||
      !DIGEST.test(artifact.digest ?? "") || !positiveId(artifact.size_in_bytes) || artifact.size_in_bytes > 1024 * 1024 ||
      !Number.isFinite(created) || !Number.isFinite(updated) || created < window.start || updated < created || updated > window.end) {
    throw new Error("SCENARIO_EVIDENCE_INVALID");
  }
  return artifact;
}

function readBrowserState(api, candidate, snapshot) {
  const checks = inventory(api(`/commits/${candidate.headSha}/check-runs?check_name=${PR_E2E_CHECK}&filter=all&per_page=100`), "check_runs");
  const matches = checks.filter(check => check?.name === PR_E2E_CHECK && check.app?.slug === "github-actions");
  if (matches.length === 0) return { kind: "pending", code: "BROWSER_EVIDENCE_PENDING" };
  if (matches.length !== 1) throw new Error("BROWSER_EVIDENCE_INVALID");
  const [check] = matches;
  const match = new RegExp(`^g5:${candidate.prNumber}:([1-9][0-9]{0,14}):([1-9][0-9]{0,14})$`, "u").exec(check.external_id ?? "");
  if (!match || check.head_sha !== candidate.headSha || !["queued", "in_progress", "completed"].includes(check.status)) {
    throw new Error("BROWSER_EVIDENCE_INVALID");
  }
  const runId = Number(match[1]);
  const attempt = Number(match[2]);
  snapshot.publication = publicationStamp(check);
  const workflow = api("/actions/workflows/browser-attack-swarm.yml");
  const run = api(`/actions/runs/${runId}`);
  snapshot.producerRun = stamp(run);
  const expected = { repositoryId: candidate.repositoryId, workflowId: workflow?.id, controllerSha: run?.head_sha,
    runId, attempt: run?.run_attempt };
  if (!positiveId(expected.workflowId) || !positiveId(expected.attempt) || !SHA.test(expected.controllerSha ?? "") ||
      !matchesTrustedRunIdentity(run, expected) || attempt > run.run_attempt ||
      (run.status !== "completed" && !PENDING.has(run.status))) throw new Error("BROWSER_EVIDENCE_INVALID");
  if (PENDING.has(run.status)) return { kind: "pending", code: "BROWSER_EVIDENCE_PENDING" };
  // The workflow has ended: an unfinished publisher or an unreadable receipt
  // can no longer justify holding a runner in a retry loop.
  if (run.conclusion !== "success") return { kind: "failure", code: "BROWSER_EVIDENCE_INVALID" };
  if (attempt !== run.run_attempt || !completedSuccessfully(check)) throw new Error("BROWSER_EVIDENCE_INVALID");
  return null;
}

/** Determine browser dependencies before reading any browser producer metadata. */
export function selectProtectedScenarioReplays({ checkout, candidate }) {
  const changed = readProtectedReplayDiff(checkout, candidate);
  const registry = loadRecords(checkout);
  if (registry.problems.length) throw new Error("SCENARIO_REGISTRY_INVALID");
  return selectForPr(registry.records, changed).browserSelected.filter(isProtectedReplayBinding);
}

/** One read-only continuation. No tests are rerun and no runner waits for another producer. */
export function evaluateScenarioCompletion({ checkout, candidate, localRun, api, downloadZip, env }) {
  const snapshot = { localRun: stamp(localRun), publication: null, producerRun: null };
  const result = (kind, code, counts = undefined) => ({ kind, code, ...(counts === undefined ? {} : { counts }),
    fingerprint: JSON.stringify(snapshot) });
  let failureCode = "SCENARIO_CERTIFICATION_UNAVAILABLE";
  try {
    if (!localRunMatches(localRun, candidate)) return result("failure", failureCode);
    if (PENDING.has(localRun.status)) return result("pending", "LOCAL_SCENARIOS_PENDING");
    if (!completedSuccessfully(localRun)) return result("failure", "LOCAL_SCENARIOS_FAILED");

    // Reuse each immutable metadata response within this evaluation. The
    // protected publisher re-reads live source attempts before writing a check.
    const responses = new Map();
    const read = route => {
      if (!responses.has(route)) responses.set(route, api(route));
      return responses.get(route);
    };
    failureCode = "SCENARIO_EVIDENCE_INVALID";
    const selected = selectProtectedScenarioReplays({ checkout, candidate });
    if (selected.length) {
      failureCode = "BROWSER_EVIDENCE_INVALID";
      const state = readBrowserState(read, candidate, snapshot);
      if (state) return result(state.kind, state.code);
    }

    failureCode = "SCENARIO_EVIDENCE_INVALID";
    const window = verifiedLocalJob(read, candidate);
    failureCode = "SCENARIO_EVIDENCE_INVALID";
    const artifact = verifiedLocalArtifact(read, candidate, window);
    const transport = { api: read, downloadZip };
    const localRaw = readPublishedLocalScenarios({ candidate, artifactId: artifact.id,
      digest: artifact.digest.slice("sha256:".length), ...transport });

    failureCode = "BROWSER_EVIDENCE_INVALID";
    const replay = collectHostedBrowserReplays({ root: checkout, candidate, selected, env, transport });
    if (!replay.ready || replay.verdicts.length !== selected.length) return result("failure", failureCode);
    const browserRaw = JSON.stringify(buildBrowserReplayManifest(candidate, selected, replay.verdicts));
    failureCode = "SCENARIO_EVIDENCE_INVALID";
    // The archive's GitHub digest verifies the downloaded bytes first. The
    // report digest is derived from the decoded, verified report itself.
    const summary = aggregateScenarioEvidence({ checkout, candidate, localRaw,
      localDigest: scenarioEvidenceDigest(localRaw), browserRaw });
    const counts = { selected: summary.selected, passed: summary.passed, failed: summary.failed,
      browserSelected: summary.browser.selected, issues: summary.issues.length };
    return result(summary.verdict === "PASS" ? "success" : "failure",
      summary.verdict === "PASS" ? "SCENARIO_EVIDENCE_COMPLETE" : failureCode, counts);
  } catch {
    // API, Git and archive errors may include private text. Public verdicts use
    // fixed codes; an unavailable or malformed proof can never grant a pass.
    return result("failure", failureCode);
  }
}
