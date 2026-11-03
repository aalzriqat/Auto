// SCRUM-761 R3: the PR-time regression-library runner. See docs/adr/2026-11-03-pr-time-scenario-runner.md.
//
// Selects every ACTIVE backend-level scenario record, runs the test each one is bound to (one Vitest invocation over
// the bound files, one worker, no retry), and gives each record a verdict. A scenario that cannot run is a FAIL, never
// a skip: a missing binding, a missing file, a test that is not found, found twice, skipped or failing all fail.
// The output is counts and scenario ids only; the repository and its Actions logs are public.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * Active backend records run here. Active browser records need a browser and a backend, so they are counted as
 * deferred and are not claimed as run. An active cloud record has no runner (SCRUM-762), so it fails.
 */
export function selectForPr(records) {
  const selection = { run: [], browserDeferred: [], cloud: [], candidate: 0, retired: 0 };
  for (const record of records) {
    if (record.status === "retired") selection.retired += 1;
    else if (record.status === "candidate") selection.candidate += 1;
    else if (record.level === "browser") selection.browserDeferred.push(record);
    else if (record.level === "cloud") selection.cloud.push(record);
    else selection.run.push(record);
  }
  return selection;
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
  const failures = verdicts.filter(verdict => verdict.code !== "PASS");
  const issues = [...extraIssues];
  if (verdicts.length === 0) issues.push("ZERO_SCENARIOS_SELECTED");
  if (selection.cloud.length) issues.push(`CLOUD_RECORDS_HAVE_NO_RUNNER:${selection.cloud.length}`);
  return {
    verdict: failures.length === 0 && issues.length === 0 ? "PASS" : "FAIL",
    selected: verdicts.length,
    passed: counts.PASS ?? 0,
    failed: failures.length,
    failureCodes: Object.fromEntries(Object.entries(counts).filter(([code]) => code !== "PASS")),
    failedIds: failures.map(verdict => `${verdict.id} ${verdict.code}`),
    notRunHere: { browserDeferred: selection.browserDeferred.length, candidate: selection.candidate, retired: selection.retired },
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

/** @param {{ root: string, config?: string, execute?: typeof runVitest }} options */
export function runPrScenarios({ root, config, execute = runVitest }) {
  const { records, problems } = loadRecords(root);
  const selection = selectForPr(records);
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
    options: { root: { type: "string" }, config: { type: "string" } } });
  const root = path.resolve(values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  const summary = runPrScenarios({ root, config: values.config });
  const text = JSON.stringify(summary, null, 2);
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## PR scenario runner: ${summary.verdict}\n\n\`\`\`json\n${text}\n\`\`\`\n`);
  }
  return summary.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
