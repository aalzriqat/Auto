// Review-audit authority (SCRUM-644 S3b).
//
// The trusted controller writes one audit payload per pull request into a run
// artifact. This module decides which of those payloads count, maps an outcome
// to a check conclusion, and builds the payload a controller may publish. It
// is pure: the caller fetches the run by id, its artifact listing and the
// payload, and passes them in. Nothing here reads a check-run — a check-run is
// a pointer any same-app token can rewrite, never authority.
//
// The binding is to main's CURRENT tip. A rerun keeps its original SHA, so a
// rerun of an older controller would judge today's merge with yesterday's
// policy; requiring run SHA == payload workflowSha == payload mainTip == the
// tip the reader observes rejects it. Absence of such a binding is UNAVAILABLE,
// never a pass.

import { isCommitSha, OBLIGATION_STATUS, REASON_CODES, VERDICTS } from "./reviewEvidence.mjs";

export const CONTROLLER_WORKFLOW_PATH = ".github/workflows/trusted-review-evidence.yml";
export const AUDIT_ARTIFACT_NAME = "trusted-review-evidence-audit";

// workflow_dispatch runs the dispatching ref's copy of the workflow, and
// pull_request runs the candidate's, so neither is a main-controlled run.
const ADMITTED_EVENTS = new Set(["workflow_run", "push", "schedule"]);
const MAIN_BRANCH = "main";

export const AUTHORITY_REJECTION = Object.freeze({
  RUN_REPOSITORY: "RUN_REPOSITORY",
  RUN_PATH: "RUN_PATH",
  RUN_EVENT: "RUN_EVENT",
  RUN_BRANCH: "RUN_BRANCH",
  RUN_HEAD_REPOSITORY: "RUN_HEAD_REPOSITORY",
  RUN_CONCLUSION: "RUN_CONCLUSION",
  ARTIFACT_BINDING: "ARTIFACT_BINDING",
  PAYLOAD_RUN: "PAYLOAD_RUN",
  PAYLOAD_REVISION: "PAYLOAD_REVISION",
});

export const BINDING_STATUS = Object.freeze({
  BOUND: "BOUND",
  UNAVAILABLE: "UNAVAILABLE",
});

export const UNAVAILABLE_REASON = Object.freeze({
  NO_CURRENT_BINDING: "NO_CURRENT_BINDING",
  STALE_CONTROLLER: "STALE_CONTROLLER",
  HEAD_MOVED: "HEAD_MOVED",
  AMBIGUOUS_BINDING: "AMBIGUOUS_BINDING",
});

// Controller outcomes that are not verdicts: the PR's shape or the
// infrastructure prevented evaluation. None of them is the record's fault.
export const NOT_EVALUABLE_REASON = Object.freeze({
  MERGE_PENDING: "MERGE_PENDING",
  CONFLICTED: "CONFLICTED",
  HEAD_MOVED: "HEAD_MOVED",
  STALE_BASE: "STALE_BASE",
  FORK: "FORK",
  MERGE_REF_MISMATCH: "MERGE_REF_MISMATCH",
  EVALUATION_ERROR: "EVALUATION_ERROR",
  REGISTRY_BUDGET: "REGISTRY_BUDGET",
});

// Controller outcomes for a PR the run never fetched: no check is written.
export const OUTCOME_UNAVAILABLE_REASON = Object.freeze({
  BATCH_INCOMPLETE: "BATCH_INCOMPLETE",
});

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
// An id must be present to be compared: two absent ids are not a match.
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const sameId = (a, b) => isId(a) && a === b;

// The API reports a workflow path as `.github/workflows/x.yml@refs/heads/main`.
// Only an `@` after the last line terminator counts (the ones regex `.` refuses),
// so a path with an embedded line break is left whole and fails the comparison.
const LINE_TERMINATORS = ["\n", "\r", "\u2028", "\u2029"];
const stripRef = (workflowPath) => {
  if (typeof workflowPath !== "string") return workflowPath;
  const lastBreak = Math.max(...LINE_TERMINATORS.map((terminator) => workflowPath.lastIndexOf(terminator)));
  const at = workflowPath.indexOf("@", lastBreak + 1);
  return at === -1 ? workflowPath : workflowPath.slice(0, at);
};

/**
 * Does this controller run, artifact and payload carry authority?
 *
 * Every input is untrusted API output, so any shape may arrive.
 *
 * @param {object} input
 * @param {any} input.run the workflow run, fetched by id
 * @param {any} input.artifact the artifact entry from that run's listing
 * @param {any} input.payload the per-PR audit read from that artifact
 * @param {number} input.repositoryId this repository's numeric id
 * @returns {{accepted: boolean, rejections: string[]}}
 */
export function acceptAuditRun({ run, artifact, payload, repositoryId }) {
  const rejections = [];
  const reject = (code) => rejections.push(code);
  if (!isPlainObject(run) || !isPlainObject(artifact) || !isPlainObject(payload)) {
    return { accepted: false, rejections: [AUTHORITY_REJECTION.PAYLOAD_RUN] };
  }

  if (!sameId(run.repository?.id, repositoryId)) reject(AUTHORITY_REJECTION.RUN_REPOSITORY);
  if (stripRef(run.path) !== CONTROLLER_WORKFLOW_PATH) reject(AUTHORITY_REJECTION.RUN_PATH);
  if (!ADMITTED_EVENTS.has(run.event)) reject(AUTHORITY_REJECTION.RUN_EVENT);
  if (run.head_branch !== MAIN_BRANCH) reject(AUTHORITY_REJECTION.RUN_BRANCH);
  if (!sameId(run.head_repository?.id, repositoryId)) reject(AUTHORITY_REJECTION.RUN_HEAD_REPOSITORY);
  // A failed controller may have uploaded a partial artifact; it is not authority.
  if (run.status !== "completed" || run.conclusion !== "success") reject(AUTHORITY_REJECTION.RUN_CONCLUSION);

  if (
    artifact.name !== AUDIT_ARTIFACT_NAME ||
    artifact.expired !== false ||
    !sameId(artifact.workflow_run?.id, run.id)
  ) {
    reject(AUTHORITY_REJECTION.ARTIFACT_BINDING);
  }

  if (!sameId(payload.controllerRunId, run.id) || !sameId(payload.runAttempt, run.run_attempt)) {
    reject(AUTHORITY_REJECTION.PAYLOAD_RUN);
  }
  // Equality, not ancestry: the controller evaluated with the policy at the
  // tip it records, and that tip is the commit the run executed.
  if (
    !isCommitSha(run.head_sha) ||
    payload.workflowSha !== run.head_sha ||
    payload.mainTip !== run.head_sha
  ) {
    reject(AUTHORITY_REJECTION.PAYLOAD_REVISION);
  }

  return { accepted: rejections.length === 0, rejections };
}

// Newest first: a higher run id, then a higher attempt, observed later state.
const newerFirst = (a, b) => b.run.id - a.run.id || b.run.run_attempt - a.run.run_attempt;
const byCodeUnit = (a, b) => (a < b ? -1 : Number(a > b));

/**
 * The audit currently in force for pull request N at head H, or UNAVAILABLE.
 *
 * Every controller binding the caller can find for N is passed in, never a
 * single pre-selected one: choosing between two accepted runs at the same tip
 * is itself an authority decision, so it is made here — the newest run wins —
 * and not by whichever pointer the caller happened to follow.
 *
 * @param {object} input
 * @param {any} input.candidates the bindings found for this PR (following a
 *        carry-forward reference if there was one); empty or absent when no
 *        artifact or payload exists
 * @param {number} input.repositoryId
 * @param {string | undefined} input.currentMainTip main's tip as the reader observes it
 * @param {number} input.prNumber
 * @param {string} input.headSha the PR's current head
 * @returns {{status: string, reason?: string, rejections?: string[], payload?: any}}
 */
export function readAuditBinding({ candidates, repositoryId, currentMainTip, prNumber, headSha }) {
  const unavailable = (reason, rejections = []) => ({ status: BINDING_STATUS.UNAVAILABLE, reason, rejections });
  const present = (Array.isArray(candidates) ? candidates : []).filter(Boolean);

  const rejected = new Set();
  const trusted = [];
  for (const candidate of present) {
    const { accepted, rejections } = acceptAuditRun({ ...candidate, repositoryId });
    if (accepted) trusted.push(candidate);
    else rejections.forEach((code) => rejected.add(code));
  }
  // Nothing present, or nothing trusted, is the same absence: no binding.
  if (trusted.length === 0) return unavailable(UNAVAILABLE_REASON.NO_CURRENT_BINDING, [...rejected].sort(byCodeUnit));

  // The predicate has proven payload.mainTip is a commit SHA, so an unreadable
  // current tip can never equal it.
  const current = trusted.filter((candidate) => candidate.payload.mainTip === currentMainTip);
  if (current.length === 0) return unavailable(UNAVAILABLE_REASON.STALE_CONTROLLER);
  const forThisPr = current.filter((candidate) => isId(prNumber) && candidate.payload.N === prNumber);
  if (forThisPr.length === 0) return unavailable(UNAVAILABLE_REASON.NO_CURRENT_BINDING);

  forThisPr.sort(newerFirst);
  const [newest] = forThisPr;
  // A tie on (run, attempt) would otherwise be settled by the caller's order.
  const tied = forThisPr.filter((candidate) => newerFirst(newest, candidate) === 0);
  if (tied.some((candidate) => JSON.stringify(candidate.payload) !== JSON.stringify(newest.payload))) {
    return unavailable(UNAVAILABLE_REASON.AMBIGUOUS_BINDING);
  }
  if (!isCommitSha(headSha) || newest.payload.H !== headSha) return unavailable(UNAVAILABLE_REASON.HEAD_MOVED);
  return { status: BINDING_STATUS.BOUND, payload: newest.payload };
}

const VERDICT_CONCLUSIONS = Object.freeze({
  [VERDICTS.COMPLETE]: "success",
  [VERDICTS.NOT_REQUIRED]: "success",
  [VERDICTS.INCOMPLETE]: "failure",
  [VERDICTS.INVALID]: "failure",
  [VERDICTS.REVIEW_UNRESOLVED]: "action_required",
});

/**
 * The check-run conclusion for an outcome, or null when no check is written.
 * Only COMPLETE and NOT_REQUIRED pass; there is no neutral. An unknown outcome
 * throws rather than defaulting to anything.
 *
 * @param {{kind: string, verdict?: string, reason?: string}} outcome
 * @returns {"success" | "failure" | "action_required" | null}
 */
export function conclusionFor(outcome) {
  // Object.hasOwn coerces its key, so ["COMPLETE"] would otherwise match.
  const isKey = (table, key) => typeof key === "string" && Object.hasOwn(table, key);
  if (outcome?.kind === "VERDICT" && isKey(VERDICT_CONCLUSIONS, outcome.verdict)) {
    return VERDICT_CONCLUSIONS[outcome.verdict];
  }
  if (outcome?.kind === "NOT_EVALUABLE" && isKey(NOT_EVALUABLE_REASON, outcome.reason)) {
    return "action_required";
  }
  // The PR was never fetched, so there is nothing to write on its head.
  if (outcome?.kind === "UNAVAILABLE" && isKey(OUTCOME_UNAVAILABLE_REASON, outcome.reason)) return null;
  throw new Error(`unknown review-audit outcome: ${JSON.stringify(outcome)}`);
}

const RECORD_PATH = /^review-evidence\/[A-Za-z0-9._/-]+\.json$/;
const isRecordPath = (path) =>
  typeof path === "string" && RECORD_PATH.test(path) && !path.split("/").includes("..");
const CODES = new Set(REASON_CODES);
// Set.has does not coerce, so ["NO_EVIDENCE"] is not a code.
const isCode = (code) => CODES.has(code);
const OBLIGATION_STATUSES = new Set(Object.values(OBLIGATION_STATUS));
const shortSha = (sha) => (isCommitSha(sha) ? sha.slice(0, 7) : "unknown");

/**
 * The publishable audit: controller-derived fields only. Evaluator `detail`
 * strings quote the candidate's record, so they never reach output, and a
 * requirement id is published only if it came from the trusted requirement
 * list.
 */
export function buildAuditPayload({
  controllerRunId,
  runAttempt,
  workflowSha,
  mainTip,
  prNumber,
  headSha,
  mergeSha,
  policyVersion,
  requirements,
  outcome,
  evaluation,
  recordPath,
  recordBlob,
}) {
  const trusted = new Set(requirements);
  const keep = (requirement) => (trusted.has(requirement) ? requirement : undefined);
  // The evaluator's verdict and the outcome being published must be the same
  // judgement; a mismatch is a controller bug, not something to paper over.
  // The evaluator always returns a verdict, so a missing one is a mismatch too.
  if (outcome?.kind === "VERDICT" && evaluation?.verdict !== outcome.verdict) {
    throw new Error("review-audit outcome disagrees with the evaluation verdict");
  }
  // One reason per failing evidence item would let a record size the payload;
  // (code, requirement) is bounded by the code list times the trusted list.
  const seen = new Set();
  const reasons = (evaluation?.reasons ?? [])
    .filter((reason) => isCode(reason?.code))
    .map((reason) => ({ code: reason.code, requirement: keep(reason.requirement) }))
    .filter((reason) => {
      const key = `${reason.code}\u0000${reason.requirement ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const runtimeOnly = reasons.length > 0 && reasons.every((reason) => reason.code === "RUNTIME_UNPROVEN");

  return {
    controllerRunId,
    runAttempt,
    workflowSha,
    mainTip,
    N: prNumber,
    H: headSha,
    M: mergeSha,
    policyVersion,
    // Rebuilt from its two known fields, so nothing else on the object rides along.
    outcome: outcome.kind === "VERDICT" ? { kind: outcome.kind, verdict: outcome.verdict } : { kind: outcome.kind, reason: outcome.reason },
    conclusion: conclusionFor(outcome),
    // RUNTIME_UNPROVEN covers both "never collected" and "collected and not
    // green", so the title names only what is certain.
    title: `record audit${runtimeOnly ? ": runtime unproven" : ""} · valid for main @ ${shortSha(mainTip)}`,
    reasons,
    obligations: (evaluation?.obligations ?? [])
      .filter((obligation) => trusted.has(obligation?.requirement) && OBLIGATION_STATUSES.has(obligation.status))
      .map((obligation) => ({ requirement: obligation.requirement, status: obligation.status })),
    unresolvedReviews: (evaluation?.unresolvedReviews ?? []).filter((requirement) => trusted.has(requirement)),
    tests: "registered-not-executed",
    runtime: "not-collected",
    reviews: "unauthenticated",
    recordPath: isRecordPath(recordPath) ? recordPath : "<redacted>",
    recordBlob: isCommitSha(recordBlob) ? recordBlob : null,
  };
}
