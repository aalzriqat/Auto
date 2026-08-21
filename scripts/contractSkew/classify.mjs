/**
 * Two different facts wear the same symptom.
 *
 * "The client sends a field the live backend refuses" can mean either of two
 * things, and they call for opposite responses:
 *
 *   REVISION SKEW    — the backend contract HAS moved and the deployed backend
 *                      is behind. Someone must deploy. This is #227 and #235,
 *                      and it is the incident SCRUM-178 exists to catch.
 *
 *   STANDING DEFECT  — the current backend and the live backend already agree.
 *                      Deploying changes nothing. The client is simply wrong,
 *                      and has been for as long as both have existed. This is
 *                      SCRUM-179.
 *
 * Conflating them makes the skew alarm permanently red for something we have
 * proved is not skew, which is how an alarm stops being read. So the alarm is
 * split: the skew signal fires only on skew, and a standing defect is reported
 * as its own contract-health failure — visible, un-suppressed, and not
 * downgraded to UNKNOWN, because it is not uncertainty. It is a known bug.
 */
import { pathsOverlap } from "./compare.mjs";

export const CLASSIFICATION = {
  REVISION_SKEW: "REVISION_SKEW",
  STANDING_DEFECT: "STANDING_DEFECT",
  UNCLASSIFIED: "UNCLASSIFIED",
};

/**
 * Evidence that the current backend contract agrees with the live one, in
 * descending order of precision. Each rung is sound on its own; the classifier
 * uses the best one available and says which it used.
 *
 * 1. `changedPaths` — derived by diffing a RENDERED current/candidate spec
 *    against the live spec. Precise to the path, and the only rung that can
 *    tell "this function moved" from "some other function moved".
 *
 * 2. `backendIdenticalToDeployed` — the whole `convex/` tree is byte-identical
 *    between the deployed commit and HEAD. Coarse, but a proof rather than an
 *    inference: if no backend source changed at all, no contract changed.
 *
 * 3. Neither — UNCLASSIFIED, which alarms. "Not proven to be a standing defect"
 *    must never be reported as "not skew"; that is the silent-compatibility
 *    failure this whole control exists to avoid.
 *
 * ⚠️ Rung 2 is deliberately WHOLE-TREE, not per-module. A validator shared from
 * `convex/schema.ts` or `convex/utils/*.ts` can change a function's contract
 * without that function's own module changing by a byte, so per-module
 * granularity would be unsound in the one direction that matters — it would
 * call a real skew a standing defect and turn the alarm green during an actual
 * outage. Coarse and sound beats fine and wrong.
 *
 * ⚠️ `changedPaths` entries carry more than identifier+path — `changedContractPaths`
 * also returns `change`, `deployed` and `candidate`. The narrow shape here made
 * a type error out of passing the REAL data, which is the wrong way round.
 *
 * @typedef {{ changedPaths?: {identifier: string, path: string, change?: string,
 *                            deployed?: string|null, candidate?: string|null}[],
 *             backendIdenticalToDeployed?: boolean,
 *             deployedSha?: string,
 *             basis?: string }} BackendEvidence
 */

/**
 * @typedef {{ identifier: string, path: string, severity?: string, dimension?: string,
 *             file?: string, line?: number, detail?: string }} BreakingFinding
 * @typedef {BreakingFinding & { classification: string }} ClassifiedFinding
 */

/**
 * @param {BreakingFinding[]} breaking
 * @param {BackendEvidence} evidence
 * @returns {{ classified: ClassifiedFinding[], revisionSkew: ClassifiedFinding[],
 *             standingDefects: ClassifiedFinding[], unclassified: ClassifiedFinding[], basis: string }}
 */
export function classifyBreaking(breaking, evidence = {}) {
  const { changedPaths, backendIdenticalToDeployed, deployedSha } = evidence;

  let basis;
  let classifyOne;

  if (Array.isArray(changedPaths)) {
    basis = `rendered current backend spec (${changedPaths.length} changed contract path(s) vs live)`;
    classifyOne = (finding) => {
      // The backend contract moved AT THIS PATH — that difference is what
      // explains the client's incompatibility.
      const moved = changedPaths.some(
        (change) =>
          change.identifier === finding.identifier && pathsOverlap(change.path, finding.path)
      );
      return moved ? CLASSIFICATION.REVISION_SKEW : CLASSIFICATION.STANDING_DEFECT;
    };
  } else if (backendIdenticalToDeployed === true) {
    // ⚠️ The caveat travels WITH the verdict, not in a source comment nobody
    // reads at 3am. This rung assumes production is actually running the commit
    // the deploy workflow last recorded. Two ways that can be false, both
    // documented in AGENTS.md and both open today: the production deploy key
    // still exists on a developer workstation, so `npx convex deploy` from a
    // laptop reaches production without leaving a run record (SCRUM-125); and
    // the recorded commit is the run's `head_sha`, which is main's tip at
    // DISPATCH, never cross-checked against the `commit_sha` the operator
    // actually typed. If either is wrong here, a real skew can be reported as a
    // standing defect — the direction that sends a responder hunting a client
    // bug instead of deploying.
    basis =
      `convex/ is byte-identical between the deployed commit ${deployedSha ?? "(unknown)"} and HEAD ` +
      `(assumes production is running that commit: no out-of-band deploy, and the run's head_sha is the deployed commit)`;
    classifyOne = () => CLASSIFICATION.STANDING_DEFECT;
  } else if (backendIdenticalToDeployed === false) {
    basis = `convex/ has changed since the deployed commit ${deployedSha ?? "(unknown)"}; which contract moved cannot be established without a rendered current spec`;
    classifyOne = () => CLASSIFICATION.UNCLASSIFIED;
  } else if (deployedSha) {
    // ⚠️ A SHA was supplied and git could not answer with it — an unknown commit,
    // or a shallow clone that does not contain it. That is a DIFFERENT failure
    // from "nobody told us the deployed commit", and naming it wrongly sends the
    // reader to fix the wrong thing. Both fail closed; only the message differs.
    basis = `the deployed commit ${deployedSha} could not be compared against HEAD — unknown commit, or a shallow clone that does not contain it`;
    classifyOne = () => CLASSIFICATION.UNCLASSIFIED;
  } else {
    basis = "no evidence about the current backend contract was supplied";
    classifyOne = () => CLASSIFICATION.UNCLASSIFIED;
  }

  const classified = breaking.map((finding) => ({
    ...finding,
    classification: classifyOne(finding),
  }));

  return {
    classified,
    revisionSkew: classified.filter((f) => f.classification === CLASSIFICATION.REVISION_SKEW),
    standingDefects: classified.filter((f) => f.classification === CLASSIFICATION.STANDING_DEFECT),
    unclassified: classified.filter((f) => f.classification === CLASSIFICATION.UNCLASSIFIED),
    basis,
  };
}

/**
 * Two independent signals, deliberately not merged into one boolean.
 *
 * ⚠️ `productionSkew` includes UNCLASSIFIED. A finding we could not prove to be
 * a standing defect is not thereby proven harmless, and during a genuine skew
 * window the backend source HAS moved — which is exactly when the evidence
 * degrades to unclassified. Failing closed there is the whole point.
 */
/**
 * @param {{ revisionSkew: unknown[], standingDefects: unknown[], unclassified: unknown[] }} classification
 *   Only the three lengths are read; the findings themselves are not inspected here.
 * @param {boolean} coverageWarning
 * @param {number} needsEvidenceCount
 * @param {number} unresolvedCount
 */
export function alertsFor(classification, coverageWarning, needsEvidenceCount, unresolvedCount) {
  const skewCount = classification.revisionSkew.length + classification.unclassified.length;
  const standingCount = classification.standingDefects.length;

  const parts = [];
  if (classification.revisionSkew.length) {
    parts.push(`PRODUCTION SKEW: ${classification.revisionSkew.length} path(s) where the deployed backend is behind the current one`);
  }
  if (classification.unclassified.length) {
    parts.push(`${classification.unclassified.length} incompatibility(ies) could not be classified — treated as skew`);
  }
  if (standingCount) {
    parts.push(`STANDING CONTRACT DEFECT: ${standingCount} path(s) where the client disagrees with a backend that is already deployed — deploying will not fix these`);
  }
  if (!parts.length && coverageWarning) {
    parts.push(
      `coverage warning: compatibility not proven for ${unresolvedCount} call site(s) and ${needsEvidenceCount} path(s) — this is control health, NOT a confirmed outage`
    );
  }

  return {
    productionSkew: skewCount > 0,
    standingContractDefect: standingCount > 0,
    coverageWarning,
    summary: parts.join("; ") || "no incompatibility detected",
  };
}

/**
 * The findings a RELEASE is answerable for.
 *
 * ⚠️ Standing defects are excluded on purpose. By definition the current
 * backend and the live backend already agree about them, so they are not
 * introduced by any candidate — and blocking on them would stop every unrelated
 * release forever. That is the same "permanently red for something proven not
 * to be skew" failure as in the monitor, merely relocated into the release gate.
 * They are still reported on every release outcome; they are just not this
 * release's fault.
 *
 * @param {{ revisionSkew: ClassifiedFinding[], unclassified: ClassifiedFinding[] }} classification
 * @returns {ClassifiedFinding[]}
 */
export function releaseBlockingFindings(classification) {
  return [...classification.revisionSkew, ...classification.unclassified];
}
