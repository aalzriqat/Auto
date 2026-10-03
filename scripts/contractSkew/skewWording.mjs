/**
 * The summary line for a proven-or-unclassified skew (exit 7).
 *
 * ⚠️ THE WORDING CLAIMS ONLY WHAT THE SOURCE OF THE SPEC PROVES. A spec fetched
 * through the credential ladder is, by the deployment-identity check, the
 * production backend, so only that run may say "PRODUCTION SKEW" and tell a
 * person to deploy. A spec handed in as a file (`--spec`) is evidence of
 * whatever deployment it was exported from: calling it production, and
 * instructing a production deploy, would aim a person at the wrong backend.
 */

/** The rung `fetchSpec` reports for a spec file supplied by the caller. */
export const SUPPLIED_FILE_RUNG = "SUPPLIED_FILE";

/**
 * @param {{
 *   rung: string,
 *   specSource: string,
 *   proven: number,
 *   unclassified: number,
 *   basis: string
 * }} input
 * @returns {string}
 */
export function skewSummary({ rung, specSource, proven, unclassified, basis }) {
  const counts = `${proven} proven, ${unclassified} unclassified`;
  if (rung === SUPPLIED_FILE_RUNG) {
    return (
      `CONTRACT SKEW against the supplied spec (${specSource}) — ${counts}. ` +
      `That file is not known to be the production backend, so this run gives no deploy instruction. ` +
      `Basis: ${basis}`
    );
  }
  return (
    `PRODUCTION SKEW — ${counts}. Deploy the Convex backend at this commit. ` +
    `Basis: ${basis}`
  );
}
