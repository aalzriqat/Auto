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
 * ⚠️ AND THE DEPLOY INSTRUCTION IS CONDITIONAL ON THE PER-CALL DISPOSITION
 * (SCRUM-178 v2 batch 5, D-30). It is given only when deploying is proven to fix
 * EVERY exit-7 break: either no current spec is in use (the SHA / tree rungs), or
 * each break is accepted by the current spec at that call. If the current spec
 * ALSO refuses any call (`rejectedElsewhere`), deploying alone will not make that
 * call succeed, so the instruction is withheld and those calls are listed.
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
  const notFixed = rejectedElsewhere.length
    ? `Deploying the backend alone will not make ${rejectedElsewhere.length} of these call(s) succeed — the current spec still refuses them: ${rejectedElsewhere
        .map(describeRejected)
        .join("; ")}. `
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
    return `PRODUCTION SKEW — ${counts}. ${notFixed}Basis: ${basis}`;
  }
  return (
    `PRODUCTION SKEW — ${counts}. Deploy the Convex backend at this commit. ` +
    `Basis: ${basis}`
  );
}
