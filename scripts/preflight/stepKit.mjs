/**
 * What every preflight step shares: running one child command and mapping its outcome to PASS/FAIL (a command that cannot run is a
 * FAIL, never a skip), the missing-file check, and the NOT APPLICABLE result. Split out of preflight.mjs (SCRUM-1011) so step
 * modules can use it without importing the runner.
 *
 * @typedef {{ id: string, command: string, args: string[], cwd?: string }} RunSpec
 * @typedef {{ status: number | null, stdout?: string, stderr?: string, error?: Error }} RunOutcome
 * @typedef {{ run: (spec: RunSpec) => RunOutcome, exists: (p: string) => boolean }} KitDeps
 * @typedef {{ id: string, title?: string, status: "PASS" | "FAIL" | "NOT APPLICABLE", detail: string, fix: string[], warnings?: string[] }} StepResult
 */
import path from "node:path";

export const TAIL_LINES = 30;
export const PNPM_FIX = "run it as `pnpm preflight` (pnpm scripts run only through pnpm's own JS entry, never a shell or a PATH lookup)";

/** @param {RunOutcome} o */
export function combinedTail(o) {
  const errText = o.stderr ? `\n${o.stderr}` : "";
  const text = `${o.stdout ?? ""}${errText}`.replaceAll("\r", "").trim();
  const lines = text.split("\n");
  if (lines.length <= TAIL_LINES) return text;
  return [`... (${lines.length - TAIL_LINES} earlier lines omitted)`, ...lines.slice(-TAIL_LINES)].join("\n");
}

/**
 * Run one command; map every outcome to PASS/FAIL. A spawn error or a missing exit status is "cannot run", a FAIL.
 * @param {KitDeps} deps @param {RunSpec} spec
 * @returns {{ ok: boolean, cannotRun: boolean, status: number | null, text: string }}
 */
export function execute(deps, spec) {
  const outcome = deps.run(spec);
  if (outcome.error || typeof outcome.status !== "number") {
    const why = outcome.error?.message ?? "no exit status (killed by a signal?)";
    return { ok: false, cannotRun: true, status: null, text: `cannot run \`${spec.command} ${spec.args.join(" ")}\`: ${why}` };
  }
  return { ok: outcome.status === 0, cannotRun: false, status: outcome.status, text: combinedTail(outcome) };
}

/** @param {KitDeps} deps @param {string} root @param {string[]} rels */
export function missingFiles(deps, root, rels) {
  return rels.filter((rel) => !deps.exists(path.join(root, ...rel.split("/"))));
}

/** The fix line for a command that could not run at all. @param {RunSpec} spec */
export function cannotRunFix(spec) {
  return spec.command === "pnpm" ? [PNPM_FIX] : [`make \`${spec.command}\` runnable, then re-run pnpm preflight`];
}

/**
 * @param {KitDeps} deps @param {string} root @param {string} id @param {string} title @param {string[]} requiredFiles
 * @param {RunSpec[]} specs @param {(r: { status: number | null, text: string }) => string[]} fixFor
 * @returns {StepResult}
 */
export function commandCheck(deps, root, id, title, requiredFiles, specs, fixFor) {
  const missing = missingFiles(deps, root, requiredFiles);
  if (missing.length) {
    return { id, title, status: "FAIL", detail: `cannot run: ${missing.join(", ")} not found (run pnpm install, or check out the repository files)`, fix: ["pnpm install --frozen-lockfile"] };
  }
  let lastLine = "";
  for (const spec of specs) {
    const r = execute(deps, spec);
    if (!r.ok) return { id, title, status: "FAIL", detail: r.text, fix: r.cannotRun ? cannotRunFix(spec) : fixFor(r) };
    lastLine = r.text.split("\n").findLast((l) => l.trim())?.trim().slice(0, 110) ?? "";
  }
  return { id, title, status: "PASS", detail: lastLine, fix: [] };
}

/** @param {string} id @param {string} detail @returns {StepResult} */
export function notApplicable(id, detail) {
  return { id, status: "NOT APPLICABLE", detail, fix: [] };
}
