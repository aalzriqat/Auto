// Review-audit controller (SCRUM-644 S3b-2).
//
// Runs only from main's own workflow (trusted-review-evidence.yml), with main's
// checkout as the trusted root. For every open pull request into main it
// derives the requirements from the live merge, reads the candidate's evidence
// record as data, evaluates it, and writes one audit payload per PR into the
// run's artifact. A check-run on the head is a pointer to that artifact, never
// authority: readAuditBinding (reviewAuditAuthority.mjs) is what counts.
//
// Report-only. Nothing lists the check as required; S4 lands the reader.
//
// Candidate content is never executed. The record is JSON-parsed; cited test
// files are parsed for registrations by the TypeScript parser, never run, so a
// registration proves a test exists, not that it ran.

import ts from "typescript";
import { listActiveTestRegistrations } from "../autoflowInvariantCatalog.ts";
import {
  deterministicInvariantImpact,
  deriveReviewMatrix,
  extraDeterministicRequirementsForFiles,
} from "./jevImpact.mjs";
import { evaluateReviewEvidence, isCommitSha, isNonMaterialPath } from "./reviewEvidence.mjs";
import {
  buildAuditPayload,
  conclusionFor,
  NOT_EVALUABLE_REASON,
  OUTCOME_UNAVAILABLE_REASON,
} from "./reviewAuditAuthority.mjs";

export const CHECK_NAME = "trusted-review-evidence";
export const UNCLASSIFIED_REQUIREMENT = "review:unclassified-path";
const MAIN = "main";

export const LIMITS = Object.freeze({
  maxPullRequests: 40,
  requestBudget: 300,
  recordBytes: 256 * 1024,
  testFileBytes: 512 * 1024,
  registryBytes: 8 * 1024 * 1024,
});

// Mirrors how CI's unit job collects tests (runVitestCoverageShards.mjs
// collectUnitTestFiles): a directory with one of these names is skipped at ANY
// depth, and only regular files count. That is narrower than the root
// vitest.config.ts excludes, and CI runs the narrower set. Drift tests pin both.
export const UNIT_SUITE_EXCLUDED_DIRS = Object.freeze(["node_modules", ".next", "out", "build", "apps", "packages", ".claude", ".git"]);
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/** Thrown when the run cannot continue: every PR not yet audited is BATCH_INCOMPLETE. */
export class BatchHalt extends Error {}

const RECORD_PREFIX = "review-evidence/";
const isRecordCandidate = (file) => file.startsWith(RECORD_PREFIX) && file.endsWith(".json");

export function isAdmittedTestFile(file) {
  if (typeof file !== "string" || !/\.test\.tsx?$/.test(file)) return false;
  const segments = file.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return false;
  return !segments.slice(0, -1).some((segment) => UNIT_SUITE_EXCLUDED_DIRS.includes(segment));
}

/**
 * Requirements for a change, with a fallback: a changed path that no catalog
 * source area, governance rule or non-material rule classifies adds
 * review:unclassified-path. Without it, a change the catalog cannot see (for
 * example packages/shared/**) would derive nothing and pass as NOT_REQUIRED.
 *
 * @returns {{requirements: string[], unclassifiedCount: number}}
 */
export function deriveRequirements({ files, invariants, policy }) {
  const impact = deterministicInvariantImpact(files, invariants);
  const extra = extraDeterministicRequirementsForFiles(files);
  const covered = new Set(impact.flatMap((entry) => entry.matchingFiles));
  const governed = new Set(files.filter((file) => extraDeterministicRequirementsForFiles([file]).length > 0));
  const unclassified = files.filter(
    (file) => !covered.has(file) && !governed.has(file) && !isNonMaterialPath(policy, file),
  );
  const matrix = deriveReviewMatrix({
    deterministicImpact: impact,
    extraDeterministicRequirements: unclassified.length > 0 ? [...extra, UNCLASSIFIED_REQUIREMENT] : extra,
    risks: {},
    invariantImpact: {},
  });
  return { requirements: matrix.deterministicRequirements, unclassifiedCount: unclassified.length };
}

// A record the evaluator must refuse as MALFORMED_RECORD: any non-object is.
const UNREADABLE_RECORD = "<unreadable record>";

function readRecord(git, merge, files) {
  const present = files.filter((file) => isRecordCandidate(file) && git.blobSize(merge, file) !== null);
  if (present.length === 0) return { record: null, recordPath: null, recordBlob: null };
  // Two records would let the candidate choose which one is read.
  if (present.length > 1) return { record: UNREADABLE_RECORD, recordPath: null, recordBlob: null };
  const [recordPath] = present;
  const recordBlob = git.blobId(merge, recordPath);
  if (git.blobSize(merge, recordPath) > LIMITS.recordBytes) return { record: UNREADABLE_RECORD, recordPath, recordBlob };
  try {
    return { record: JSON.parse(git.show(merge, recordPath)), recordPath, recordBlob };
  } catch {
    return { record: UNREADABLE_RECORD, recordPath, recordBlob };
  }
}

function citedTestFiles(record) {
  if (record === null || typeof record !== "object" || !Array.isArray(record.obligations)) return [];
  const files = new Set();
  for (const obligation of record.obligations) {
    for (const item of Array.isArray(obligation?.evidence) ? obligation.evidence : []) {
      if (item?.kind === "test" && typeof item.file === "string") files.add(item.file);
    }
  }
  return [...files];
}

/** @returns {Record<string, {title: string, parameterized: boolean}[]> | null} null when over budget */
function buildTestRegistry(git, merge, record) {
  const registry = {};
  let total = 0;
  for (const file of citedTestFiles(record)) {
    // A symlink or submodule is not a file the unit job collects.
    if (!isAdmittedTestFile(file) || !REGULAR_FILE_MODES.has(git.fileMode(merge, file))) continue;
    const size = git.blobSize(merge, file);
    if (size === null) continue;
    total += size;
    if (size > LIMITS.testFileBytes || total > LIMITS.registryBytes) return null;
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    registry[file] = listActiveTestRegistrations(git.show(merge, file), kind).map(({ title, parameterized }) => ({
      title,
      parameterized,
    }));
  }
  return registry;
}

/**
 * Provenance of the live merge. Returns the identities, or a NOT_EVALUABLE reason.
 */
/**
 * What the PR's own metadata says, read both before evaluating and again just
 * before publishing: the live PR can change under a fixed head (TRE-1).
 * @returns {string | null} a NOT_EVALUABLE reason, or null when it is evaluable
 */
function prStateReason(pr, repositoryId) {
  if (pr.mergeable === null) return NOT_EVALUABLE_REASON.MERGE_PENDING;
  if (pr.mergeable !== true) return NOT_EVALUABLE_REASON.CONFLICTED;
  if (pr.head?.repo?.id !== repositoryId) return NOT_EVALUABLE_REASON.FORK;
  if (pr.state !== "open" || pr.base?.ref !== MAIN) return NOT_EVALUABLE_REASON.STALE_BASE;
  return null;
}

function provenance({ pr, repositoryId, mainTip, git }) {
  const stateReason = prStateReason(pr, repositoryId);
  if (stateReason) return { reason: stateReason };
  const head = pr.head?.sha;
  if (!isCommitSha(head) || !isCommitSha(pr.merge_commit_sha)) return { reason: NOT_EVALUABLE_REASON.MERGE_REF_MISMATCH };
  const fetched = git.fetchPull(pr.number);
  if (fetched.head !== head) return { reason: NOT_EVALUABLE_REASON.HEAD_MOVED };
  if (fetched.merge !== pr.merge_commit_sha) return { reason: NOT_EVALUABLE_REASON.MERGE_REF_MISMATCH };
  const parents = git.parents(fetched.merge);
  if (parents.length !== 2 || parents[1] !== head) return { reason: NOT_EVALUABLE_REASON.MERGE_REF_MISMATCH };
  // GitHub has not yet recomputed the merge against today's main.
  if (parents[0] !== mainTip) return { reason: NOT_EVALUABLE_REASON.STALE_BASE };
  return { head, merge: fetched.merge, parents };
}

/**
 * Audit one pull request. Never throws for a PR-shaped problem: every outcome
 * is typed. A BatchHalt from the GitHub client propagates.
 */
export async function auditPullRequest({ prNumber, context }) {
  const { github, git, trusted, run, repositoryId, mainTip, sleep } = context;
  const base = {
    controllerRunId: run.id,
    runAttempt: run.attempt,
    workflowSha: run.workflowSha,
    mainTip,
    prNumber,
    policyVersion: trusted.policy.policyVersion,
  };
  const notEvaluable = (reason, headSha, mergeSha = null) => ({
    payload: buildAuditPayload({
      ...base,
      headSha,
      mergeSha,
      requirements: [],
      outcome: { kind: "NOT_EVALUABLE", reason },
    }),
    publish: isCommitSha(headSha),
  });

  let pr = await github.getPull(prNumber);
  if (pr.mergeable === null) {
    await sleep(3000);
    pr = await github.getPull(prNumber);
  }
  const headSha = pr.head?.sha;
  try {
    const identity = provenance({ pr, repositoryId, mainTip, git });
    if (identity.reason) return notEvaluable(identity.reason, headSha);
    const { head, merge, parents } = identity;

    const files = git.changedFiles(mainTip, merge);
    const { requirements } = deriveRequirements({ files, invariants: trusted.invariants, policy: trusted.policy });
    const { record, recordPath, recordBlob } = readRecord(git, merge, files);
    const testRegistry = buildTestRegistry(git, merge, record);
    if (testRegistry === null) return notEvaluable(NOT_EVALUABLE_REASON.REGISTRY_BUDGET, head, merge);

    const evaluation = evaluateReviewEvidence({
      policy: trusted.policy,
      record,
      identities: { base: mainTip, head, merge, mergeParents: parents },
      requirements,
      history: {
        isAncestor: (sha) => git.isAncestor(sha, head),
        changedFilesSince: (sha) => git.changedFiles(sha, head),
      },
      testRegistry,
      runtimeEvidence: [],
    });

    // The head must not have moved while we evaluated; a stale verdict on the
    // old head would be read as current by anything that trusts the pointer.
    const latest = await github.getPull(prNumber);
    if (latest.head?.sha !== head) {
      return { ...notEvaluable(NOT_EVALUABLE_REASON.HEAD_MOVED, head, merge), publish: false };
    }
    // Same head, but the PR itself changed: retargeted, closed, conflicted or
    // re-merged. A later run skips a PR that left main, so a verdict written
    // now would never be replaced; publish the refusal on the unchanged head.
    const drift =
      prStateReason(latest, repositoryId) ??
      (latest.merge_commit_sha === merge ? null : NOT_EVALUABLE_REASON.MERGE_REF_MISMATCH);
    if (drift) return notEvaluable(drift, head, merge);

    const outcome = { kind: "VERDICT", verdict: evaluation.verdict };
    return {
      payload: buildAuditPayload({
        ...base,
        headSha: head,
        mergeSha: merge,
        requirements,
        outcome,
        evaluation,
        recordPath,
        recordBlob,
      }),
      publish: true,
    };
  } catch (error) {
    if (error instanceof BatchHalt) throw error;
    console.error(`review audit of #${prNumber} failed`, error);
    return notEvaluable(NOT_EVALUABLE_REASON.EVALUATION_ERROR, headSha);
  }
}

function checkSummary(payload, run) {
  const outcome = payload.outcome.kind === "VERDICT" ? payload.outcome.verdict : `${payload.outcome.kind} ${payload.outcome.reason}`;
  return [
    `Outcome: ${outcome}`,
    `Controller run ${run.id} attempt ${run.attempt}; artifact \`${run.artifactName}\`, file \`audit-${payload.N}.json\`.`,
    "Report-only: this check is a pointer, not authority, and is not a required check.",
  ].join("\n\n");
}

/**
 * The artifact entry for one PR (see buildAuditPayload).
 * @typedef {{
 *   N: number, H: string | null, M: string | null, mainTip: string,
 *   outcome: {kind: string, verdict?: string, reason?: string},
 *   conclusion: string | null, title: string,
 *   reasons: {code: string, requirement?: string}[], unresolvedReviews: string[],
 *   [field: string]: unknown,
 * }} AuditPayload
 */

/**
 * Audit every open pull request into main.
 *
 * @returns {Promise<{payloads: AuditPayload[], published: number, halted: boolean}>}
 */
export async function runController(context) {
  const { github, run } = context;
  const open = (await github.listOpenPulls())
    .filter((pr) => pr?.base?.ref === MAIN && Number.isSafeInteger(pr.number))
    .map((pr) => pr.number)
    .sort((a, b) => a - b);

  const payloads = [];
  let published = 0;
  let halted = false;
  // No head was read, so nothing can be published for these.
  const headless = (prNumber, outcome) =>
    buildAuditPayload({
      controllerRunId: run.id,
      runAttempt: run.attempt,
      workflowSha: run.workflowSha,
      mainTip: context.mainTip,
      prNumber,
      headSha: null,
      mergeSha: null,
      policyVersion: context.trusted.policy.policyVersion,
      requirements: [],
      outcome,
    });
  const unavailable = (prNumber) =>
    headless(prNumber, { kind: "UNAVAILABLE", reason: OUTCOME_UNAVAILABLE_REASON.BATCH_INCOMPLETE });

  for (const [index, prNumber] of open.entries()) {
    if (halted || index >= LIMITS.maxPullRequests) {
      payloads.push(unavailable(prNumber));
      continue;
    }
    try {
      const { payload, publish } = await auditPullRequest({ prNumber, context });
      if (publish && conclusionFor(payload.outcome) !== null) {
        await github.createCheckRun({
          name: CHECK_NAME,
          head_sha: payload.H,
          status: "completed",
          conclusion: payload.conclusion,
          output: { title: payload.title, summary: checkSummary(payload, run) },
        });
        published += 1;
      }
      // Recorded only once its pointer (if any) exists, so a failed publish
      // leaves one payload for the PR, not two.
      payloads.push(payload);
    } catch (error) {
      if (error instanceof BatchHalt) {
        console.error(`review audit halted at #${prNumber}: ${error.message}`);
        halted = true;
        payloads.push(unavailable(prNumber));
      } else {
        // Reading the PR itself failed (or publishing did); one PR never aborts the batch.
        console.error(`review audit of #${prNumber} failed`, error);
        payloads.push(headless(prNumber, { kind: "NOT_EVALUABLE", reason: NOT_EVALUABLE_REASON.EVALUATION_ERROR }));
      }
    }
  }
  return { payloads, published, halted };
}

/**
 * A GitHub client over fetch with a request budget. A 403, a 429 or the budget
 * running out halts the batch; anything else non-2xx throws for that PR.
 *
 * @param {{token: string | undefined, repository: string | undefined, fetchImpl?: typeof fetch, budget?: number}} options
 */
export function createGithubClient({ token, repository, fetchImpl = fetch, budget = LIMITS.requestBudget }) {
  let used = 0;
  async function request(method, route, body) {
    if (used >= budget) throw new BatchHalt("request budget exhausted");
    used += 1;
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${route}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 403 || response.status === 429) throw new BatchHalt(`GitHub answered ${response.status}`);
    if (!response.ok) throw new Error(`GitHub ${method} ${route} answered ${response.status}`);
    return response.json();
  }
  return {
    getPull: (number) => request("GET", `/pulls/${number}`),
    listOpenPulls: () => request("GET", `/pulls?state=open&base=${MAIN}&per_page=100`),
    createCheckRun: (checkRun) => request("POST", "/check-runs", checkRun),
    used: () => used,
  };
}
