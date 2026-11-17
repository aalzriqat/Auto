import { PR_E2E_CHECK } from "../intelligence/trustedPrE2eGate.mjs";
import { matchesTrustedG5Artifact } from "../intelligence/trustedG5Artifact.mjs";
import { EXPLORER_SPEC, OPENING_PROOF_CASES, OPENING_PROOF_SPEC, SOURCED_SCENARIO_IDS, SOURCED_SPEC, TRUSTED_REPLAY_BINDINGS,
  isTrustedOpeningReplayBinding } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { readTrustedBrowserArchive } from "./trustedBrowserArchive.mjs";

const WORKFLOW_PATH = ".github/workflows/browser-attack-swarm.yml";
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const completedSuccessfully = (entry) => entry?.status === "completed" && entry.conclusion === "success";

function validIdentity(expected) {
  const { repositoryId, workflowId, runId, attempt, artifactId, prNumber, baseSha, headSha, testedSha, controllerSha } = expected;
  return [repositoryId, workflowId, runId, attempt, artifactId, prNumber].every((id) => Number.isSafeInteger(id) && id > 0) &&
    [baseSha, headSha, testedSha, controllerSha].every((sha) => typeof sha === "string" && SHA.test(sha));
}

export function matchesTrustedRunIdentity(run, expected) {
  return run?.id === expected.runId && run.run_attempt === expected.attempt &&
    run.workflow_id === expected.workflowId && run.path === WORKFLOW_PATH && run.event === "workflow_run" &&
    run.repository?.id === expected.repositoryId && run.head_repository?.id === expected.repositoryId &&
    run.head_branch === "main" && run.head_sha === expected.controllerSha;
}

function successfulJob(jobs, name, expected) {
  const matching = jobs.filter((job) => job?.name === name);
  const [job] = matching;
  return matching.length === 1 && completedSuccessfully(job) &&
    job.run_id === expected.runId && job.run_attempt === expected.attempt;
}

function replayStepPassed(jobs, name) {
  const steps = jobs.find((job) => job.name === "trusted-e2e")?.steps;
  const matches = steps?.filter((step) => step?.name === name) ?? [];
  return matches.length === 1 && completedSuccessfully(matches[0]);
}

function matchesPublication(check, expected) {
  return completedSuccessfully(check) && check.name === PR_E2E_CHECK && check.app?.slug === "github-actions" &&
    check.head_sha === expected.headSha && check.external_id === `g5:${expected.prNumber}:${expected.runId}:${expected.attempt}`;
}

function isCurrentPull(pull, mergeRef, expected) {
  return pull?.number === expected.prNumber && pull.state === "open" && pull.draft === false &&
    pull.base?.ref === "main" && pull.base.sha === expected.baseSha && pull.base.repo?.id === expected.repositoryId &&
    pull.head?.sha === expected.headSha && pull.head.repo?.id === expected.repositoryId &&
    mergeRef?.ref === `refs/pull/${expected.prNumber}/merge` &&
    mergeRef.object?.type === "commit" && mergeRef.object.sha === expected.testedSha;
}

function matchesCandidate(merge, evidence, expected) {
  return merge?.sha === expected.testedSha && Array.isArray(merge.parents) && merge.parents.length === 2 &&
    merge.parents[0]?.sha === expected.baseSha && merge.parents[1]?.sha === expected.headSha &&
    evidence?.testedSha === expected.testedSha && evidence.headSha === expected.headSha &&
    evidence.controllerSha === expected.controllerSha;
}

// The caller gets run, job, artifact, check and live pull/merge metadata from
// GitHub and supplies evidence and the computed digest from the same archive.
// A valid envelope permits per-record judging. It is never a scenario verdict.
export function verifyTrustedBrowserReceipt({ expected, run, jobs, artifact, archiveSha256, check, pull, mergeRef, merge, evidence }) {
  return Boolean(expected && validIdentity(expected) && completedSuccessfully(run) && matchesTrustedRunIdentity(run, expected) && Array.isArray(jobs) &&
    successfulJob(jobs, "trusted-e2e", expected) && successfulJob(jobs, "authenticated-pr-e2e-publish", expected) &&
    matchesTrustedG5Artifact(artifact, expected) && typeof archiveSha256 === "string" && SHA256.test(archiveSha256) &&
    artifact.digest === `sha256:${archiveSha256}` && matchesPublication(check, expected) &&
    isCurrentPull(pull, mergeRef, expected) && matchesCandidate(merge, evidence, expected));
}

export function readVerifiedBrowserReceipt({ archivePath, onInvalidArchive = () => {}, ...provenance }) {
  const { artifact, expected } = provenance;
  if (!expected || !validIdentity(expected) || !matchesTrustedG5Artifact(artifact, expected)) return null;
  let receipt;
  try {
    receipt = readTrustedBrowserArchive(archivePath, artifact.digest);
  } catch {
    // Raw errors can contain paths or artifact text. An unreadable receipt
    // cannot supply any scenario cases.
    onInvalidArchive();
    return null;
  }
  if (!verifyTrustedBrowserReceipt({ ...provenance, ...receipt })) return null;
  const { jobs } = provenance;
  return {
    ...receipt,
    explorer: replayStepPassed(jobs, "Prove the selected explorer walks against the exact candidate") ? receipt.explorer : undefined,
    sourced: replayStepPassed(jobs, "Prove the selected sourced deals against the exact candidate") ? receipt.sourced : undefined,
  };
}

function matchesAttempt(replay, expected) {
  return replay?.producerRunId === String(expected.runId) && replay.producerAttempt === String(expected.attempt);
}

function authenticatedCases(evidence, expected) {
  if (!Array.isArray(evidence?.executedDefinitions)) return new Map();
  const cases = new Map();
  for (const [field, { id, definition }] of Object.entries(TRUSTED_REPLAY_BINDINGS)) {
    const replay = evidence[field];
    if (matchesAttempt(replay, expected) && replay.id === id && replay.code === "PASS" &&
        evidence.executedDefinitions.includes(definition)) cases.set(id, `playwright/tests/${definition}`);
  }
  return cases;
}

function scenarioCases(replay, expected, count) {
  if (!matchesAttempt(replay, expected) || replay.baseSha !== expected.baseSha ||
      replay.headSha !== expected.headSha || replay.testedSha !== expected.testedSha ||
      replay.controllerSha !== expected.controllerSha || !Array.isArray(replay.records) || replay.records.length !== count) return [];
  const ids = new Set();
  for (const record of replay.records) {
    if (typeof record?.id !== "string" || !record.id || record.code !== "PASS" || ids.has(record.id)) return [];
    ids.add(record.id);
  }
  return [...ids];
}

function sameBinding(record, trusted, spec) {
  return record.status === "active" && trusted.status === "active" &&
    record.level === "browser" && trusted.level === "browser" && record.domain === "screen" && trusted.domain === "screen" &&
    typeof record.fingerprint === "string" && SHA256.test(record.fingerprint) && record.fingerprint === trusted.fingerprint &&
    record.impl?.file === spec && trusted.impl?.file === spec &&
    typeof record.impl.testName === "string" && Boolean(record.impl.testName) && record.impl.testName === trusted.impl.testName;
}

function openingCases(proof, expected) {
  const binding = proof?.binding;
  if (proof?.schemaVersion !== 1 || proof.checked !== true || proof.expected !== OPENING_PROOF_CASES.length ||
      proof.passed !== OPENING_PROOF_CASES.length ||
      !["skipped", "flaky", "unexpected", "errors"].every(field => proof[field] === 0) ||
      binding?.runId !== `gh-${expected.runId}-${expected.attempt}` ||
      !["baseSha", "headSha", "testedSha", "controllerSha"].every(field => binding[field] === expected[field]) ||
      !Array.isArray(proof.cases) || proof.cases.length !== OPENING_PROOF_CASES.length ||
      !OPENING_PROOF_CASES.every(({ proofId }) => proof.cases.includes(proofId))) return [];
  return OPENING_PROOF_CASES.map(({ scenarioId }) => scenarioId);
}

// Inputs are the already-verified receipt, PR selection, and registry loaded
// from the immutable controller revision. The current candidate may change its
// own registry, so a receipt keyed by id alone cannot satisfy a changed binding.
export function bindTrustedBrowserReplays({ expected, evidence, explorer,
  sourced = /** @type {unknown} */ (undefined), opening = /** @type {unknown} */ (undefined), selected, trusted }) {
  const cases = authenticatedCases(evidence, expected);
  for (const id of scenarioCases(explorer, expected, 12)) cases.set(id, EXPLORER_SPEC);
  const sourcedCases = scenarioCases(sourced, expected, SOURCED_SCENARIO_IDS.length);
  if (SOURCED_SCENARIO_IDS.every(id => sourcedCases.includes(id))) {
    for (const id of sourcedCases) cases.set(id, SOURCED_SPEC);
  }
  for (const id of openingCases(opening, expected)) cases.set(id, OPENING_PROOF_SPEC);
  const joined = [];
  for (const record of selected) {
    const spec = cases.get(record.id);
    if (!spec || (spec === OPENING_PROOF_SPEC && !isTrustedOpeningReplayBinding(record)) ||
        selected.filter((row) => row.id === record.id).length !== 1) continue;
    const matches = trusted.filter((row) => row?.id === record.id);
    if (matches.length === 1 && sameBinding(record, matches[0], spec)) joined.push({ id: record.id, code: "PASS" });
  }
  return joined;
}
