import { PR_E2E_CHECK } from "../intelligence/trustedPrE2eGate.mjs";
import { matchesTrustedG5Artifact } from "../intelligence/trustedG5Artifact.mjs";

const WORKFLOW_PATH = ".github/workflows/browser-attack-swarm.yml";
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const completedSuccessfully = (entry) => entry?.status === "completed" && entry.conclusion === "success";

function validIdentity(expected) {
  const { repositoryId, workflowId, runId, attempt, artifactId, prNumber, baseSha, headSha, testedSha, controllerSha } = expected;
  return [repositoryId, workflowId, runId, attempt, artifactId, prNumber].every((id) => Number.isSafeInteger(id) && id > 0) &&
    [baseSha, headSha, testedSha, controllerSha].every((sha) => typeof sha === "string" && SHA.test(sha));
}

function matchesTrustedRun(run, expected) {
  return completedSuccessfully(run) && run.id === expected.runId && run.run_attempt === expected.attempt &&
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
  return Boolean(expected && validIdentity(expected) && matchesTrustedRun(run, expected) && Array.isArray(jobs) &&
    successfulJob(jobs, "trusted-e2e", expected) && successfulJob(jobs, "authenticated-pr-e2e-publish", expected) &&
    matchesTrustedG5Artifact(artifact, expected) && typeof archiveSha256 === "string" && SHA256.test(archiveSha256) &&
    artifact.digest === `sha256:${archiveSha256}` && matchesPublication(check, expected) &&
    isCurrentPull(pull, mergeRef, expected) && matchesCandidate(merge, evidence, expected));
}
