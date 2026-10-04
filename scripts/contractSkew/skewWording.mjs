/**
 * The summary line for a proven-or-unclassified skew (exit 7).
 *
 * ⚠️ THE WORDING CLAIMS ONLY WHAT THE SOURCE OF THE SPEC PROVES. A spec fetched
 * through the credential ladder is, by the deployment-identity check, the
 * production backend, so only that run may say "PRODUCTION SKEW" and tell a
 * person to deploy. A spec handed in as a file (`--spec`) is evidence of
 * whatever deployment it was exported from: calling it production, and
 * instructing a production deploy, would aim a person at the wrong backend.
 *
 * ⚠️ AND THE DEPLOY ADVICE IS CONDITIONAL ON WHAT IS PROVEN (SCRUM-178 v2
 * batches 5, 6 and 7, D-30/D-31: advice is given only when deploying is proven to
 * fix the call). THE DECISION IS PER CALL (a call = surface + siteId), never per
 * break: a call with two accepted breaks is one call, and a call is fixed only when
 * EVERY deployed break at it is accepted. Every "call(s)" figure is a count of
 * distinct call sites (`callOutcomes`); the break counts string is separate. Cases,
 * all still exit 7:
 *
 *   PROVEN        `fixed > 0` and no call still fails, none is unproven, and no
 *                 break is unclassified: the plain "Deploy the Convex backend at
 *                 this commit."
 *   LIKELY ONLY   nothing fixed-and-clean to claim, but a call is unproven
 *                 (a sibling-path break could not be compared, or the SHA / tree /
 *                 no-evidence rungs could not classify it): a deploy is the likely
 *                 remedy and is worded as NOT proven.
 *   WITHHELD      a call STILL FAILS (the current spec ALSO refuses it,
 *                 `rejectedElsewhere`, or a standing defect sits at the same call):
 *                 deploying alone will not make it succeed, and those are listed.
 *                 If other calls ARE fully accepted, the summary says a deploy
 *                 fixes those K and M call(s) will still fail; unproven calls are
 *                 counted too (never a silent blanket withhold).
 */

/** The rung `fetchSpec` reports for a spec file supplied by the caller. */
export const SUPPLIED_FILE_RUNG = "SUPPLIED_FILE";

/**
 * @param {Record<string, any>} f  a deployed break the current spec also refuses
 * @returns {string}
 */
function describeRejected(f) {
  const there = (f.currentRejects ?? []).map((/** @type {any} */ c) => c.path).join(", ") || "another path";
  return `${f.identifier} ${f.path} at ${f.file}:${f.line}, still refused by the current spec at ${there}`;
}

/**
 * @param {{
 *   rung: string,
 *   specSource: string,
 *   proven: number,
 *   unclassified: number,
 *   basis: string,
 *   rejectedElsewhere?: Array<Record<string, any>>,
 *   callOutcomes: { fixed: number, stillFails: number, unproven: number }
 * }} input
 *   `proven` / `unclassified` are BREAK counts (the pinned counts string). Every
 *   "call(s)" figure comes from `callOutcomes`, which counts distinct call sites
 *   (classify.mjs `callOutcomesOf`). It is REQUIRED: there is no fallback, because
 *   deriving it from break counts would bring back one-break-is-one-call, and a
 *   caller that forgets it must fail loudly rather than print a wrong count.
 * @returns {string}
 */
export function skewSummary({ rung, specSource, proven, unclassified, basis, rejectedElsewhere = [], callOutcomes }) {
  const valid = (/** @type {unknown} */ n) => Number.isInteger(n) && /** @type {number} */ (n) >= 0;
  if (!callOutcomes || !valid(callOutcomes.fixed) || !valid(callOutcomes.stillFails) || !valid(callOutcomes.unproven)) {
    throw new Error(`skewSummary: callOutcomes is required, with non-negative integer fixed / stillFails / unproven (got ${JSON.stringify(callOutcomes)})`);
  }
  const counts = `${proven} proven, ${unclassified} unclassified`;
  const listed = rejectedElsewhere.map(describeRejected).join("; ");
  const { fixed, stillFails, unproven } = callOutcomes;
  // U-7: name only what is true. The current spec is quoted as refusing the calls only
  // when `rejectedElsewhere` says so; a call that fails solely through a standing
  // defect at the same call is worded as that, not as a current-spec refusal.
  const notFixed =
    stillFails > 0
      ? listed
        ? `Deploying the backend alone will not make ${stillFails} of these call(s) succeed — the current spec still refuses them: ${listed}. `
        : `Deploying the backend alone will not make ${stillFails} call(s) succeed, because a standing defect sits at the same call. `
      : "";
  const stillFailsWhy = listed
    ? `because the current spec also refuses them: ${listed}`
    : "because a standing defect sits at the same call";
  if (rung === SUPPLIED_FILE_RUNG) {
    return (
      `CONTRACT SKEW against the supplied spec (${specSource}) — ${counts}. ` +
      notFixed +
      `That file is not known to be the production backend, so this run gives no deploy instruction. ` +
      `Basis: ${basis}`
    );
  }
  // The plain instruction needs every call proven fixed and nothing left uncertain.
  if (fixed > 0 && stillFails === 0 && unproven === 0 && unclassified === 0) {
    return `PRODUCTION SKEW — ${counts}. Deploy the Convex backend at this commit. Basis: ${basis}`;
  }
  const notProven =
    unproven > 0
      ? `${unproven} call(s) are not proven to be fixed by a deploy. `
      : unclassified > 0
        ? `${unclassified} more break(s) are unclassified, so a deploy is not proven to fix those. `
        : "";
  let advice;
  if (stillFails > 0) {
    advice =
      fixed > 0
        ? `Deploying the Convex backend at this commit fixes ${fixed} call(s), but ${stillFails} call(s) will still fail ${stillFailsWhy}. `
        : notFixed;
    advice += notProven;
  } else if (fixed > 0 && unproven > 0) {
    advice = `Deploying the Convex backend at this commit fixes ${fixed} call(s), but ${notProven}`;
  } else {
    const tail =
      unproven > 0
        ? `but ${unproven} call(s) are not proven to be fixed by a deploy, so this is not proven. `
        : `but ${unclassified} break(s) are unclassified, so this is not proven. `;
    advice = `Deploying the Convex backend at this commit is the likely remedy, ${tail}`;
  }
  return `PRODUCTION SKEW — ${counts}. ${advice}Basis: ${basis}`;
}
