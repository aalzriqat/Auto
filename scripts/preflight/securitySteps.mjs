/**
 * The `picomatch-backport` preflight step (SCRUM-1011): CI's required dependency-audit job runs
 * scripts/security/verifyPicomatchBackport.mjs after install. It fails on any lockfile change that adds, removes or duplicates a
 * picomatch consumer (a second snapshot of the same parent counts), so a lockfile change that passes install can still fail CI.
 * Runs in about 2 s and reads only the working tree.
 */
import { commandCheck, notApplicable } from "./stepKit.mjs";

const VERIFIER = "scripts/security/verifyPicomatchBackport.mjs";
/** Inputs the verifier reads: the root lock and manifest, the workspace overrides, the vendored backports, the worker's own lock. */
const INPUTS = [/^package\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/, /^vendor\/picomatch\//, /^dealer-worker\/package-lock\.json$/, /^scripts\/security\/verifyPicomatchBackport\./];

/** @param {import("./preflight.mjs").Ctx} ctx @returns {import("./stepKit.mjs").StepResult} */
export function picomatchBackportStep({ deps, root, cls, node }) {
  const id = "picomatch-backport";
  const touched = cls.paths.filter((p) => INPUTS.some((re) => re.test(p)));
  if (touched.length === 0) return notApplicable(id, "no dependency manifest, lockfile, workspace override or picomatch backport changed");
  const r = commandCheck(deps, root, id, "", [VERIFIER], [{ id, command: node, args: [VERIFIER], cwd: root }], () => [
    `node ${VERIFIER}`,
    "a lockfile change added, removed or duplicated a picomatch consumer, or an unpatched picomatch is reachable: minimise the lockfile diff (start from origin/main's lockfile, add only the new importer entries) first; update the reviewed baseline in that script only for a verified, legitimate new consumer; do not weaken the check",
  ]);
  return r.status === "PASS" ? { ...r, detail: `verifier passed (changed: ${touched.slice(0, 3).join(", ")})` } : r;
}
