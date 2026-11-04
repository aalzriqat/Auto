// SCRUM-761 R3: the regression-library runner for the PR tier (default) and the full tier (nightly, release).
// See docs/adr/2026-11-03-pr-time-scenario-runner.md and docs/adr/2026-11-04-library-execution-cadence.md.
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
const normalise = file => file.replaceAll("\\", "/");

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
      problems.push(`UNREADABLE_RECORD ${normalise(path.relative(root, file))}`);
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
  const out = execFileSync(resolveTrustedGitExecutable(), ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", `${base}...HEAD`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return out.split("\0").filter(Boolean).map(normalise);
}


/**
 * The full tier (nightly, release): every active record is required. Backend records run under Vitest, browser records
 * must appear in the Playwright JSON reports of the same run. An active cloud record has no runner, so it fails; a
 * candidate record is a scenario nobody executes, so it fails too (it is parked, not retired).
 */
export function selectFull(records) {
  const selection = selectForPr(records, []);
  // selectForPr sorts browser records into "not required" or "unmapped"; in this tier all of them are required.
  selection.browserSelected = records.filter(record => record.status === "active" && record.level === "browser");
  selection.browserNotRequired = [];
  selection.browserUnmapped = [];
  return selection;
}

/**
 * One verdict per active browser record from Playwright JSON reports (https://playwright.dev/docs/test-reporters#json-reporter).
 * Every execution of the bound title (one per project that collects the file) must have run as expected; a skipped,
 * unexpected or flaky (passed only on retry) execution fails, and zero executions fail. Spec paths are resolved against
 * the report's rootDir and each project's testDir.
 * @param {object[]} records active browser-level records
 * @param {object[]} reports parsed Playwright JSON reports
 * @param {string} root repository root
 * @returns {{ id: string, code: string }[]}
 */
export function evaluatePlaywright(records, reports, root) {
  const executions = new Map();
  const add = (file, title, status) => {
    const key = `${normalise(path.relative(root, file))}\0${title}`;
    executions.set(key, [...(executions.get(key) ?? []), status]);
  };
  const walk = (suite, report) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const project = (report.config?.projects ?? []).find(candidate => candidate.name === test.projectName || candidate.id === test.projectId);
        const bases = new Set([report.config?.rootDir, project?.testDir].filter(base => typeof base === "string" && base));
        for (const base of bases) add(path.resolve(base, spec.file ?? suite.file ?? ""), spec.title, test.status);
      }
    }
    for (const child of suite.suites ?? []) walk(child, report);
  };
  for (const report of reports) for (const suite of report?.suites ?? []) walk(suite, report);
  return records.map(record => {
    const file = record.impl?.file;
    const name = record.impl?.testName;
    if (typeof file !== "string" || typeof name !== "string" || !file || !name) return { id: record.id, code: "BINDING_MISSING" };
    if (!existsSync(path.join(root, file))) return { id: record.id, code: "BINDING_FILE_MISSING" };
    const found = executions.get(`${normalise(file)}\0${name}`) ?? [];
    if (found.length === 0) return { id: record.id, code: "BROWSER_REPLAY_NOT_EXECUTED" };
    if (found.includes("skipped")) return { id: record.id, code: "TEST_SKIPPED" };
    if (found.includes("flaky")) return { id: record.id, code: "TEST_FLAKY" };
    if (found.some(status => status !== "expected")) return { id: record.id, code: "TEST_FAILED" };
    return { id: record.id, code: "PASS" };
  });
}

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
export function summarise(selection, verdicts, extraIssues, browserVerdicts = null, tier = "pr") {
  const counts = {};
  // A browser record this PR requires cannot be executed here, so it is a failed verdict, not a skip.
  // In the full tier the browser records carry verdicts read from the Playwright reports.
  const all = [...verdicts, ...(browserVerdicts ?? selection.browserSelected.map(record => ({ id: record.id, code: "BROWSER_REPLAY_NOT_EXECUTED" })))];
  for (const verdict of all) counts[verdict.code] = (counts[verdict.code] ?? 0) + 1;
  const failures = all.filter(verdict => verdict.code !== "PASS");
  const issues = [...extraIssues];
  if (all.length === 0) issues.push("ZERO_SCENARIOS_SELECTED");
  if (selection.cloud.length) issues.push(`CLOUD_RECORDS_HAVE_NO_RUNNER:${selection.cloud.length}`);
  if (tier === "full" && selection.candidate) issues.push(`CANDIDATE_RECORDS_ARE_NOT_EXECUTED:${selection.candidate}`);
  if (browserVerdicts === null && selection.browserSelected.length) issues.push(`SELECTED_BROWSER_RECORDS_NEED_A_BROWSER_AND_BACKEND_SCRUM762:${selection.browserSelected.length}`);
  if (selection.changedFilesUnavailable) issues.push("PR_DIFF_UNAVAILABLE");
  return {
    tier,
    verdict: failures.length === 0 && issues.length === 0 ? "PASS" : "FAIL",
    selected: all.length,
    passed: counts.PASS ?? 0,
    failed: failures.length,
    failureCodes: Object.fromEntries(Object.entries(counts).filter(([code]) => code !== "PASS")),
    failedIds: failures.map(verdict => `${verdict.id} ${verdict.code}`),
    browser: { selected: selection.browserSelected.length, notRequiredAtPrTime: selection.browserNotRequired.length, unmappedToAScreen: selection.browserUnmapped.length },
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

/**
 * @param {{ root: string, config?: string, execute?: typeof runVitest, changedFiles?: string[] | null,
 *   tier?: "pr" | "full", playwrightReports?: object[], reportProblems?: string[] }} options
 */
export function runPrScenarios({ root, config, execute = runVitest, changedFiles = null, tier = "pr", playwrightReports = [], reportProblems = [] }) {
  const { records, problems } = loadRecords(root);
  const selection = tier === "full" ? selectFull(records) : selectForPr(records, changedFiles);
  const files = [...new Set(selection.run.map(record => record.impl?.file).filter(file => typeof file === "string" && file && existsSync(path.join(root, file))))].sort(codeUnitCompare);
  const issues = [...problems, ...reportProblems];
  let report = null;
  if (files.length) {
    const result = execute(root, files, config);
    report = result.report;
    if (!report) issues.push("VITEST_REPORT_MISSING");
    else if (result.exitCode !== 0) issues.push(`VITEST_EXIT_${result.exitCode}`);
  }
  const browserVerdicts = tier === "full" ? evaluatePlaywright(selection.browserSelected, playwrightReports, root) : null;
  return summarise(selection, evaluate(selection.run, report, root), issues, browserVerdicts, tier);
}

/** Reads Playwright JSON reports. An unreadable or non-report file is a problem (FAIL), never dropped. */
export function readPlaywrightReports(paths) {
  const reports = [];
  const problems = [];
  for (const file of paths) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed?.suites)) reports.push(parsed);
      else problems.push("PLAYWRIGHT_REPORT_INVALID");
    } catch {
      problems.push("PLAYWRIGHT_REPORT_UNREADABLE");
    }
  }
  return { reports, problems };
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
    options: { root: { type: "string" }, config: { type: "string" }, base: { type: "string", default: "origin/main" },
      tier: { type: "string", default: "pr" }, "playwright-report": { type: "string", multiple: true } } });
  if (values.tier !== "pr" && values.tier !== "full") {
    process.stderr.write("--tier must be pr or full\n");
    return 2;
  }
  const root = path.resolve(values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  let changedFiles = null;
  if (values.tier === "pr") {
    try {
      changedFiles = changedFilesSince(root, values.base);
    } catch {
      // Left null: the PR diff is unknown, so every active browser record counts as selected and the run fails.
    }
  }
  const { reports, problems } = readPlaywrightReports(values["playwright-report"] ?? []);
  const summary = runPrScenarios({ root, config: values.config, changedFiles, tier: values.tier, playwrightReports: reports, reportProblems: problems });
  const text = JSON.stringify(summary, null, 2);
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Regression library runner (${summary.tier} tier): ${summary.verdict}\n\n\`\`\`json\n${text}\n\`\`\`\n`);
  }
  return summary.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
