/**
 * The `sonar-lint` and `inventories` preflight steps (SCRUM-1011). Split from preflight.mjs, which owns the runner.
 *
 * sonar-lint:  eslint with eslint.preflight.config.mjs on the changed lintable files, JSON output, read back here. Only
 *              `sonarjs/*` messages count: errors (Sonar BUG/VULNERABILITY classes) FAIL, warnings (code smells) are returned
 *              for printing. Only findings on lines the change added or modified count (Sonar's gate judges new code).
 *              ESLint is not Sonar; see README, "Preflight".
 * inventories: the registration-inventory tests CI runs as unit tests, when convex/ or one of them changed.
 */
import path from "node:path";
import { changedLineRanges, newCodeDiffArgs } from "./diffRanges.mjs";
import { sonarNumberOf } from "./sonarRules.mjs";
import { combinedTail, commandCheck, missingFiles, notApplicable } from "./stepKit.mjs";

/** @typedef {import("./stepKit.mjs").StepResult} StepResult */
/** @typedef {import("./stepKit.mjs").RunOutcome} RunOutcome */
/** @typedef {{ file: string, line: number, rule: string, sonar: string, message: string }} SonarFinding */
/** @typedef {{ errors: SonarFinding[], warnings: SonarFinding[], unanalysed: string[] }} Found */

const ESLINT_CHUNK = 120;
const SONAR_ESLINT_CONFIG = "eslint.preflight.config.mjs";
const MAX_LISTED_FINDINGS = 12;
/** Registration inventories CI runs as unit tests: a new Convex module or door must be listed in them. */
const INVENTORY_TESTS = [
  { dir: "scripts", name: /^(tenantWriteGuard|economicCommandCensus)[^/]*\.test\.ts$/ },
  { dir: "scripts/regression", name: /^pilotDoorInventory\.test\.ts$/ },
];

/**
 * One ESLint `--format json` document, reduced to the Sonar-rule findings. A message with no rule id at severity 2 (a parse
 * error) means the file was not analysed, so it is reported separately and the caller fails the step.
 * @param {string} stdout @param {string} root
 * @returns {Found}
 */
export function readSonarFindings(stdout, root) {
  let files;
  try {
    files = JSON.parse(stdout);
  } catch {
    throw new Error("eslint did not print JSON (the plugin or config may have failed to load)");
  }
  if (!Array.isArray(files)) throw new TypeError("eslint JSON output is not a list of files");
  /** @type {Found} */
  const found = { errors: [], warnings: [], unanalysed: [] };
  for (const entry of files) {
    const file = path.relative(root, String(entry.filePath)).split(path.sep).join("/");
    for (const m of entry.messages ?? []) classifyMessage(found, file, m);
  }
  return found;
}

/** @param {Found} found @param {string} file @param {any} m */
function classifyMessage(found, file, m) {
  const rule = typeof m.ruleId === "string" ? m.ruleId : "";
  if (!rule && m.severity === 2) {
    found.unanalysed.push(`${file}:${m.line ?? 0} ${m.message}`);
    return;
  }
  if (!rule.startsWith("sonarjs/")) return;
  const finding = { file, line: m.line ?? 0, rule, sonar: sonarNumberOf(rule) ?? "S?", message: String(m.message).split("\n")[0] };
  (m.severity === 2 ? found.errors : found.warnings).push(finding);
}

export { changedLineRanges, newCodeDiffArgs };

/** @param {Map<string, Array<[number, number]>>} ranges @param {SonarFinding} f */
const onChangedLine = (ranges, f) => {
  const own = ranges.get(f.file);
  return own === undefined || own.some(([from, to]) => f.line >= from && f.line <= to);
};

/** @param {SonarFinding} f */
const describeFinding = (f) => `${f.file}:${f.line}  ${f.rule} (Sonar ${f.sonar})  ${f.message}`;

/**
 * @param {RunOutcome} outcome @param {string} root
 * @returns {{ failure?: string, errors: SonarFinding[], warnings: SonarFinding[] }}
 */
function readLintOutcome(outcome, root) {
  const none = { errors: [], warnings: [] };
  if (outcome.error || typeof outcome.status !== "number") {
    return { ...none, failure: outcome.error?.message ?? "no exit status (killed by a signal?)" };
  }
  // ESLint exits 0 (clean or warnings only) or 1 (rule errors); anything else is a crash or a configuration problem.
  if (outcome.status > 1) return { ...none, failure: `eslint exited ${outcome.status}\n${combinedTail(outcome)}` };
  try {
    const found = readSonarFindings(outcome.stdout ?? "", root);
    if (found.unanalysed.length) return { ...none, failure: `eslint could not analyse: ${found.unanalysed.slice(0, 3).join("; ")}` };
    return found;
  } catch (error) {
    return { ...none, failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Lint the files in chunks and keep only findings on lines this change added or modified.
 * @param {{ deps: import("./preflight.mjs").Ctx["deps"], root: string, node: string, mergeBase: string, bin: string, id: string, files: string[] }} p
 * @returns {{ failure?: string, errors: SonarFinding[], warnings: SonarFinding[] }}
 */
function collectNewCodeFindings({ deps, root, node, mergeBase, bin, id, files }) {
  /** @type {SonarFinding[]} */
  const errors = [];
  /** @type {SonarFinding[]} */
  const warnings = [];
  for (let i = 0; i < files.length; i += ESLINT_CHUNK) {
    const part = files.slice(i, i + ESLINT_CHUNK);
    // --no-inline-config: SonarCloud does not honour eslint-disable comments, so neither may this check.
    // https://eslint.org/docs/latest/use/command-line-interface#--no-inline-config
    const args = [bin, "--config", SONAR_ESLINT_CONFIG, "--no-warn-ignored", "--no-inline-config", "--format", "json", "--", ...part];
    const chunk = readLintOutcome(deps.run({ id, command: node, args, cwd: root }), root);
    if (chunk.failure) return { failure: chunk.failure, errors, warnings };
    // Sonar's gate judges new code only, so a finding on a line this change did not touch is not this change's problem.
    const ranges = changedLineRanges(deps.git(newCodeDiffArgs(mergeBase, part)));
    errors.push(...chunk.errors.filter((f) => onChangedLine(ranges, f)));
    warnings.push(...chunk.warnings.filter((f) => onChangedLine(ranges, f)));
  }
  return { errors, warnings };
}

/** @param {import("./preflight.mjs").Ctx} ctx @returns {StepResult} */
export function sonarLintStep({ deps, root, cls, node, mergeBase }) {
  const id = "sonar-lint";
  if (cls.lintable.length === 0) return notApplicable(id, "no changed lintable file (.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts outside the lint ignores)");
  const bin = "node_modules/eslint/bin/eslint.js";
  const missing = missingFiles(deps, root, [bin, SONAR_ESLINT_CONFIG, "node_modules/eslint-plugin-sonarjs/package.json"]);
  if (missing.length) {
    return { id, status: "FAIL", detail: `cannot run: ${missing.join(", ")} not found (run pnpm install, or check out the repository files)`, fix: ["pnpm install --frozen-lockfile"] };
  }
  const sample = cls.lintable.slice(0, 6).join(" ");
  const ellipsis = cls.lintable.length > 6 ? " ..." : "";
  const rerun = `node ${bin} --config ${SONAR_ESLINT_CONFIG} --no-warn-ignored --no-inline-config -- ${sample}${ellipsis}`;
  const collected = collectNewCodeFindings({ deps, root, node, mergeBase, bin, id, files: cls.lintable });
  if (collected.failure) return { id, status: "FAIL", detail: `cannot run: ${collected.failure}`, fix: [rerun, "if eslint-plugin-sonarjs cannot load: pnpm install --frozen-lockfile"] };
  const { errors, warnings } = collected;
  const warningLines = warnings.map(describeFinding);
  if (errors.length === 0) {
    return { id, status: "PASS", detail: `${cls.lintable.length} file(s): 0 errors, ${warnings.length} warning(s) (Sonar code smells; they do not fail preflight)`, fix: [], warnings: warningLines };
  }
  const shown = errors.slice(0, MAX_LISTED_FINDINGS);
  const listed = shown.map((f) => "  - " + describeFinding(f));
  if (errors.length > shown.length) listed.push(`  ... ${errors.length - shown.length} more`);
  return {
    id, status: "FAIL",
    detail: `${errors.length} Sonar bug/vulnerability-class finding(s):\n${listed.join("\n")}`,
    fix: [...shown.map((f) => `${f.file}:${f.line}: fix ${f.rule} (Sonar ${f.sonar}); Sonar would fail the quality gate on this`), rerun],
    warnings: warningLines,
  };
}

/** @param {string} p */
function isInventoryTestPath(p) {
  const dir = path.posix.dirname(p);
  const name = path.posix.basename(p);
  return INVENTORY_TESTS.some((t) => t.dir === dir && t.name.test(name));
}

/** @param {import("./preflight.mjs").Ctx} ctx @returns {StepResult} */
export function inventoriesStep({ deps, root, cls, node }) {
  const id = "inventories";
  const touched = cls.paths.filter((p) => p.startsWith("convex/") || isInventoryTestPath(p));
  if (touched.length === 0) return notApplicable(id, "no convex/ file or inventory test changed");
  const files = INVENTORY_TESTS.flatMap((t) =>
    deps.readDir(path.join(root, ...t.dir.split("/"))).filter((n) => t.name.test(n)).sort((a, b) => a.localeCompare(b)).map((n) => `./${t.dir}/${n}`));
  if (files.length === 0) throw new Error("no inventory test files found under scripts/ (the test names or locations changed; update INVENTORY_TESTS)");
  const bin = "node_modules/vitest/vitest.mjs";
  const args = [bin, "run", "--maxWorkers=1", ...files];
  const r = commandCheck(deps, root, id, "", [bin], [{ id, command: node, args, cwd: root }], () => [
    `node ${args.join(" ")}`,
    "a registration inventory is out of date: add the new convex module/door to the inventory the failing test names (the message above says where); do not weaken the test",
  ]);
  return r.status === "PASS" ? { ...r, detail: `${files.length} inventory test file(s) passed (changed: ${touched.slice(0, 3).join(", ")})` } : r;
}
