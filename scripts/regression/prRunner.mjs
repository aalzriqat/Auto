// SCRUM-761 R3: the PR-time regression-library runner. See docs/adr/2026-11-03-pr-time-scenario-runner.md.
//
// Selects every ACTIVE backend-level scenario record, runs the test each one is bound to (one Vitest invocation over
// the bound files, one worker, no retry), and gives each record a verdict. A scenario that cannot run is a FAIL, never
// a skip: a missing binding, a missing file, a test that is not found, found twice, skipped or failing all fail.
// The output is counts and scenario ids only; the repository and its Actions logs are public.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globMatches } from "../intelligence/jevImpact.mjs";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { parseArgs } from "node:util";

const codeUnitCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {string} dir @param {string[]} out */
function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith(".scenario.json")) out.push(full);
  }
  return out;
}

/** Reads every scenario record. An unreadable record is a problem (FAIL), never silently dropped. */
export function loadRecords(root) {
  const dir = path.join(root, "regression", "scenarios");
  const records = [];
  const problems = [];
  if (!existsSync(dir)) return { records, problems: ["SCENARIO_DIRECTORY_MISSING"] };
  for (const file of collect(dir, []).sort(codeUnitCompare)) {
    try {
      records.push(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      problems.push(`UNREADABLE_RECORD ${path.relative(root, file).replaceAll("\\", "/")}`);
    }
  }
  return { records, problems };
}

/**
 * Active backend records run here. An active browser record is required at PR time only when the PR touches its
 * screen: a changed file matches one of its `sourceGlobs`, or its own bound spec changed. A selected browser record
 * cannot be executed here (it needs a browser and a backend, SCRUM-762), so it FAILS. Browser records without
 * `sourceGlobs` cannot be mapped to a screen; they are listed as a gap, never guessed at. The rest belong to the nightly
 * and release runs. An active cloud record has no runner, so it fails.
 * @param {object[]} records
 * @param {string[] | null} changedFiles repo-relative paths of the PR diff; null when they could not be determined
 */
export function selectForPr(records, changedFiles = null) {
  const selection = { run: [], browserSelected: [], browserNotRequired: [], browserUnmapped: [], changedFilesUnavailable: false, cloud: [], candidate: 0, retired: 0 };
  for (const record of records) {
    if (record.status === "retired") selection.retired += 1;
    else if (record.status === "candidate") selection.candidate += 1;
    else if (record.level === "cloud") selection.cloud.push(record);
    else if (record.level !== "browser") selection.run.push(record);
    else if (changedFiles === null) {
      selection.changedFilesUnavailable = true;
      selection.browserSelected.push(record);
    } else {
      const globs = Array.isArray(record.sourceGlobs) ? record.sourceGlobs : [];
      const touched = changedFiles.some(file => file === record.impl?.file || globs.some(glob => globMatches(glob, file)));
      if (touched) selection.browserSelected.push(record);
      else if (globs.length === 0) selection.browserUnmapped.push(record);
      else selection.browserNotRequired.push(record);
    }
  }
  return selection;
}

/** Files changed between `base` and HEAD (three-dot: since the merge base). Throws when Git cannot say. */
export function changedFilesSince(root, base) {
  const out = execFileSync(resolveTrustedGitExecutable(), ["diff", "--name-only", "-z", `${base}...HEAD`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return out.split("\0").filter(Boolean).map(file => file.replaceAll("\\", "/"));
}
const normalise = file => file.replaceAll("\\", "/");

/**
 * One verdict per selected record from Vitest's JSON report (assertionResults are the executed tests).
 * @returns {{ id: string, code: string }[]} code "PASS" or the failure code
 */
export function evaluate(selected, report, root) {
  const byFile = new Map();
  for (const result of report?.testResults ?? []) {
    byFile.set(normalise(path.relative(root, result.name)), result);
  }
  return selected.map(record => {
    const file = record.impl?.file;
    const name = record.impl?.testName;
    if (typeof file !== "string" || typeof name !== "string" || !file || !name) return { id: record.id, code: "BINDING_MISSING" };
    if (!existsSync(path.join(root, file))) return { id: record.id, code: "BINDING_FILE_MISSING" };
    const result = byFile.get(normalise(file));
    if (!result) return { id: record.id, code: "FILE_NOT_EXECUTED" };
    const tests = result.assertionResults ?? [];
    const matches = tests.filter(test => test.title === name);
    if (matches.length === 0) return { id: record.id, code: result.status === "failed" && tests.length === 0 ? "FILE_FAILED_TO_RUN" : "TEST_NOT_FOUND" };
    if (matches.length > 1) return { id: record.id, code: "TEST_AMBIGUOUS" };
    const status = matches[0].status;
    if (status === "passed") return { id: record.id, code: "PASS" };
    if (status === "failed") return { id: record.id, code: "TEST_FAILED" };
    return { id: record.id, code: "TEST_SKIPPED" };
  });
}

/** Counts only. Failing ids are listed because the records are already public in the repository. */
export function summarise(selection, verdicts, extraIssues) {
  const counts = {};
  for (const verdict of verdicts) counts[verdict.code] = (counts[verdict.code] ?? 0) + 1;
  if (selection.browserSelected.length) counts.BROWSER_REPLAY_NOT_EXECUTED = selection.browserSelected.length;
  const failures = [...verdicts, ...selection.browserSelected.map(record => ({ id: record.id, code: "BROWSER_REPLAY_NOT_EXECUTED" }))].filter(verdict => verdict.code !== "PASS");
  const issues = [...extraIssues];
  if (verdicts.length === 0 && selection.browserSelected.length === 0) issues.push("ZERO_SCENARIOS_SELECTED");
  if (selection.cloud.length) issues.push(`CLOUD_RECORDS_HAVE_NO_RUNNER:${selection.cloud.length}`);
  if (selection.browserSelected.length) issues.push(`SELECTED_BROWSER_RECORDS_NEED_A_BROWSER_AND_BACKEND_SCRUM762:${selection.browserSelected.length}`);
  if (selection.changedFilesUnavailable) issues.push("PR_DIFF_UNAVAILABLE");
  return {
    verdict: failures.length === 0 && issues.length === 0 ? "PASS" : "FAIL",
    selected: verdicts.length + selection.browserSelected.length,
    passed: counts.PASS ?? 0,
    failed: failures.length,
    failureCodes: Object.fromEntries(Object.entries(counts).filter(([code]) => code !== "PASS")),
    failedIds: failures.map(verdict => `${verdict.id} ${verdict.code}`),
    browser: { selectedForThisPr: selection.browserSelected.length, notRequiredAtPrTime: selection.browserNotRequired.length, unmappedToAScreen: selection.browserUnmapped.length },
    notRunHere: { candidate: selection.candidate, retired: selection.retired },
    issues,
  };
}

/** Runs Vitest once over the bound files: one worker, no file parallelism, no retry. Its console output is discarded: it carries test titles and error text, and the Actions log is public. */
export function runVitest(root, files, config) {
  const require = createRequire(import.meta.url);
  const vitestBin = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "pr-scenarios-"));
  const outputFile = path.join(dir, "report.json");
  try {
    const args = [vitestBin, "run", "--root", root, "--maxWorkers=1", "--no-file-parallelism", "--retry=0",
      ...(config ? ["--config", config] : []), "--reporter=json", `--outputFile=${outputFile}`, ...files];
    const child = spawnSync(process.execPath, args, { cwd: root, stdio: "ignore", env: process.env });
    const report = existsSync(outputFile) ? JSON.parse(readFileSync(outputFile, "utf8")) : null;
    return { report, exitCode: child.status ?? 1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {{ root: string, config?: string, execute?: typeof runVitest, changedFiles?: string[] | null }} options */
export function runPrScenarios({ root, config, execute = runVitest, changedFiles = null }) {
  const { records, problems } = loadRecords(root);
  const selection = selectForPr(records, changedFiles);
  const files = [...new Set(selection.run.map(record => record.impl?.file).filter(file => typeof file === "string" && file && existsSync(path.join(root, file))))].sort(codeUnitCompare);
  const issues = [...problems];
  let report = null;
  if (files.length) {
    const result = execute(root, files, config);
    report = result.report;
    if (!report) issues.push("VITEST_REPORT_MISSING");
    else if (result.exitCode !== 0) issues.push(`VITEST_EXIT_${result.exitCode}`);
  }
  return summarise(selection, evaluate(selection.run, report, root), issues);
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
    options: { root: { type: "string" }, config: { type: "string" }, base: { type: "string", default: "origin/main" } } });
  const root = path.resolve(values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  let changedFiles = null;
  try {
    changedFiles = changedFilesSince(root, values.base);
  } catch {
    // Left null: the PR diff is unknown, so every active browser record counts as selected and the run fails.
  }
  const summary = runPrScenarios({ root, config: values.config, changedFiles });
  const text = JSON.stringify(summary, null, 2);
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## PR scenario runner: ${summary.verdict}\n\n\`\`\`json\n${text}\n\`\`\`\n`);
  }
  return summary.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
