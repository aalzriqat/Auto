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
 * batches 5 and 6, D-30: advice is given only when deploying is proven to fix the
 * call). Exactly three cases, all still exit 7:
 *
 *   PROVEN        `proven > 0`, `unclassified === 0`, nothing rejected elsewhere:
 *                 the plain "Deploy the Convex backend at this commit."
 *   LIKELY ONLY   `unclassified > 0` (and nothing rejected elsewhere): the SHA /
 *                 tree / no-evidence rungs could not classify some breaks, so a
 *                 deploy is the likely remedy and is worded as NOT proven.
 *   WITHHELD      the current spec ALSO refuses a call (`rejectedElsewhere`), so
 *                 deploying alone will not make it succeed: those calls are
 *                 listed. If other calls ARE accepted by the current spec, the
 *                 summary says a deploy fixes those K and the M listed will still
 *                 fail (never a silent blanket withhold).
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
 *   rejectedElsewhere?: Array<Record<string, any>>
 * }} input
 * @returns {string}
 */
export function skewSummary({ rung, specSource, proven, unclassified, basis, rejectedElsewhere = [] }) {
  const counts = `${proven} proven, ${unclassified} unclassified`;
  const listed = rejectedElsewhere.map(describeRejected).join("; ");
  // `rejectedElsewhere` is a subset of the proven skew: the rest are accepted by
  // the current spec, so a deploy does fix them (L-1).
  const fixable = proven - rejectedElsewhere.length;
  const notFixed = rejectedElsewhere.length
    ? `Deploying the backend alone will not make ${rejectedElsewhere.length} of these call(s) succeed — the current spec still refuses them: ${listed}. `
    : "";
  if (rung === SUPPLIED_FILE_RUNG) {
    return (
      `CONTRACT SKEW against the supplied spec (${specSource}) — ${counts}. ` +
      notFixed +
      `That file is not known to be the production backend, so this run gives no deploy instruction. ` +
      `Basis: ${basis}`
    );
  }
  if (rejectedElsewhere.length) {
    const mixed =
      fixable > 0
        ? `Deploying the Convex backend at this commit fixes ${fixable} call(s), but ${rejectedElsewhere.length} call(s) will still fail because the current spec also refuses them: ${listed}. `
        : notFixed;
    const unproven = unclassified > 0 ? `${unclassified} more break(s) are unclassified, so a deploy is not proven to fix those. ` : "";
    return `PRODUCTION SKEW — ${counts}. ${mixed}${unproven}Basis: ${basis}`;
  }
  if (unclassified > 0) {
    return (
      `PRODUCTION SKEW — ${counts}. Deploying the Convex backend at this commit is the likely remedy, ` +
      `but ${unclassified} break(s) are unclassified, so this is not proven. ` +
      `Basis: ${basis}`
    );
  }
  return (
    `PRODUCTION SKEW — ${counts}. Deploy the Convex backend at this commit. ` +
    `Basis: ${basis}`
  );
}
