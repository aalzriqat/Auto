// SCRUM-761 R3: the regression-library runner for the PR tier (default) and the full tier (nightly, release).
// See docs/adr/2026-11-03-pr-time-scenario-runner.md and docs/adr/2026-11-04-library-execution-cadence.md.
//
// Selects every ACTIVE backend-level scenario record, runs the test each one is bound to (one Vitest invocation over
// the bound files, one worker, no retry), and gives each record a verdict. A scenario that cannot run is a FAIL, never
// a skip: a missing binding, a missing file, a test that is not found, found twice, skipped or failing all fail.
// The output is counts and scenario ids only; the repository and its Actions logs are public.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globMatches } from "../intelligence/jevImpact.mjs";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { parseArgs } from "node:util";

const codeUnitCompare = (a, b) => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};
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

function classifyBrowserRecord(record, changedFiles) {
  const globs = Array.isArray(record.sourceGlobs) ? record.sourceGlobs : [];
  if (globs.length === 0) return "browserUnmapped";
  if (changedFiles === null) return "browserSelected";
  const touched = changedFiles.some(file => file === record.impl?.file || globs.some(glob => globMatches(glob, file)));
  if (touched) return "browserSelected";
  return "browserNotRequired";
}

/**
 * Active backend records run here. An active browser record is required at PR time only when the PR touches its
 * screen: a changed file matches one of its `sourceGlobs`, or its own bound spec changed. A selected browser record
 * cannot be executed here (it needs a browser and a backend, SCRUM-762), so it FAILS. Browser records without
 * `sourceGlobs` cannot be mapped to a screen and fail validation. The rest belong to the nightly
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
    else {
      if (changedFiles === null) selection.changedFilesUnavailable = true;
      selection[classifyBrowserRecord(record, changedFiles)].push(record);
    }
  }
  return selection;
}

/**
 * Files changed since the merge base with HEAD. Explicit bases must be full commit SHAs reachable from refs or HEAD.
 * An omitted base uses the fixed origin/main ref. Throws when Git cannot say.
 * @param {string} root
 * @param {string} [base]
 */
export function changedFilesSince(root, base) {
  if (base !== undefined && (typeof base !== "string" || base.length !== 40 || !/^[0-9a-f]{40}$/i.test(base))) {
    throw new Error("Invalid base: expected a full 40-character commit SHA");
  }
  const git = resolveTrustedGitExecutable();
  let sha;
  try {
    // Keep CLI data out of process arguments, even after validation. Select the value emitted by Git itself.
    const commits = execFileSync(git, base === undefined
      ? ["rev-parse", "--verify", "--end-of-options", "origin/main^{commit}"]
      : ["rev-list", "--all", "HEAD"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    sha = commits.trim().split(/\r?\n/).find(commit => base === undefined || commit === base.toLowerCase());
  } catch {
    throw new Error("Invalid base: must resolve to an existing Git commit");
  }
  if (sha === undefined) throw new Error("Invalid base: must resolve to an existing Git commit");
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("Invalid base: Git did not resolve a full 40-character commit SHA");
  const out = execFileSync(git, ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--end-of-options", `${sha}...HEAD`, "--"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
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
  return selection;
}

// The role matrix runs only in pilot-role-audit.yml, which needs one fixture per role and ships its results as
// encrypted evidence. Records bound to it have no report in the full-tier job, so they fail under their own code
// (a recorded reason, never a skip) until that evidence is joined (SCRUM-761 follow-up).
const ROLE_AUDIT_SPEC = "playwright/tests/audit-role-access.spec.ts";

function indexPlaywrightTests(reports, root) {
  const executions = new Map();
  const add = (file, title, test) => {
    const key = `${normalise(path.relative(root, file))}\0${title}`;
    const matches = executions.get(key);
    if (matches) matches.push(test);
    else executions.set(key, [test]);
  };
  const walk = (suite, report) => {
    if (!suite || (suite.specs !== undefined && !Array.isArray(suite.specs)) ||
        (suite.suites !== undefined && !Array.isArray(suite.suites))) throw new Error("Invalid suite");
    for (const spec of suite.specs ?? []) {
      if (!spec || !Array.isArray(spec.tests)) throw new Error("Invalid spec");
      for (const test of spec.tests ?? []) {
        const base = report.config?.rootDir;
        if (typeof base === "string" && base) add(path.resolve(base, spec.file ?? suite.file ?? ""), spec.title, { ...test, evidenceConfig: report.config });
      }
    }
    for (const child of suite.suites ?? []) walk(child, report);
  };
  for (const report of reports) for (const suite of report?.suites ?? []) walk(suite, report);
  return executions;
}

// Config identity is part of execution identity: project names are not unique across configs.
const configPath = config => typeof config?.configFile === "string" && path.isAbsolute(config.configFile)
  ? normalise(path.resolve(config.configFile)) : null;
const projectKey = test => `${configPath(test.evidenceConfig)}\0${test.projectId}`;

function configSignature(config) {
  if (!configPath(config) || !path.isAbsolute(config.rootDir ?? "") || config.version !== "1.61.1" ||
      !Array.isArray(config.projects) || config.projects.length === 0) return null;
  const projects = config.projects.map(project => {
    if (typeof project?.id !== "string" || !project.id || typeof project.name !== "string" ||
        !path.isAbsolute(project.testDir ?? "") || !Array.isArray(project.testMatch) || !Array.isArray(project.testIgnore) ||
        [...project.testMatch, ...project.testIgnore].some(pattern => typeof pattern !== "string")) throw new Error("Invalid project");
    return { id: project.id, name: project.name, testDir: normalise(path.resolve(project.testDir)),
      testMatch: project.testMatch, testIgnore: project.testIgnore };
  });
  if (new Set(projects.map(project => project.id)).size !== projects.length) return null;
  return JSON.stringify({ file: configPath(config), root: normalise(path.resolve(config.rootDir)), projects });
}

function unfilteredDiscovery(config) {
  if (!Array.isArray(config.argv) || config.argv[2] !== "test") return false;
  try {
    const { values } = parseArgs({ args: config.argv.slice(3), strict: true, allowPositionals: false, options: {
      config: { type: "string", short: "c" }, list: { type: "boolean" }, reporter: { type: "string" }, workers: { type: "string" },
    } });
    return values.list === true && values.reporter === "json";
  } catch {
    return false;
  }
}

// Use the installed, version-pinned engine for Playwright glob/RegExp semantics. This private adapter
// is checked inside the evidence boundary; a missing API/version refuses evidence instead of guessing.
function projectCollectsFile(project, file) {
  const relative = path.relative(project.testDir, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const require = createRequire(import.meta.url);
  const playwrightRequire = createRequire(require.resolve("playwright/package.json"));
  const { createFileMatcher } = playwrightRequire("./lib/util.js");
  const patterns = values => values.map(value => {
    const regex = /^\/(.*)\/([dgimsuvy]*)$/.exec(value);
    return regex ? new RegExp(regex[1], regex[2]) : value;
  });
  return createFileMatcher(patterns(project.testMatch))(file) && !createFileMatcher(patterns(project.testIgnore))(file);
}

// Discovery is separate input, never inferred from executions. Malformed files fail globally;
// ambiguity and incomplete collection fail only records bound to the affected file/title.
function playwrightInventory(inventories, root) {
  if (inventories.length === 0) return { code: "PLAYWRIGHT_INVENTORY_MISSING" };
  try {
    const configs = new Map();
    for (const inventory of inventories) {
      if (!Array.isArray(inventory?.suites) || !configSignature(inventory.config) ||
          !Array.isArray(inventory.errors) || inventory.errors.length > 0 ||
          !inventory.stats || ["expected", "unexpected", "flaky"].some(key => inventory.stats[key] !== 0) ||
          !Number.isInteger(inventory.stats.skipped) || inventory.stats.skipped < 0) {
        return { code: "PLAYWRIGHT_INVENTORY_INVALID" };
      }
      const key = configPath(inventory.config);
      if (configs.has(key)) return { code: "PLAYWRIGHT_INVENTORY_INVALID" };
      configs.set(key, inventory.config);
      const collected = indexPlaywrightTests([inventory], root);
      if (collected.size === 0) return { code: "PLAYWRIGHT_INVENTORY_EMPTY" };
      for (const tests of collected.values()) {
        if (tests.some(test => typeof test.projectId !== "string" || !test.projectId ||
            !Array.isArray(test.results) || test.results.length !== 0 || test.status !== "skipped")) {
          return { code: "PLAYWRIGHT_INVENTORY_INVALID" };
        }
      }
      if (!unfilteredDiscovery(inventory.config)) return { code: "PLAYWRIGHT_INVENTORY_FILTERED" };
    }
    return { tests: indexPlaywrightTests(inventories, root), configs };
  } catch {
    return { code: "PLAYWRIGHT_INVENTORY_INVALID" };
  }
}

function expectedProjects(inventory, file, name, root) {
  const collected = inventory.tests.get(`${normalise(file)}\0${name}`) ?? [];
  const keys = collected.map(projectKey);
  if (new Set(keys).size !== keys.length) return { code: "PLAYWRIGHT_INVENTORY_INVALID" };
  if (keys.length === 0) return { code: "TEST_NOT_COLLECTED" };
  try {
    // Include configs that should collect this file even if their entire file suite was omitted.
    for (const config of inventory.configs.values()) {
      const declared = config.projects.filter(project => projectCollectsFile(project, path.resolve(root, file)));
      const actual = collected.filter(test => configPath(test.evidenceConfig) === configPath(config));
      if (declared.length !== actual.length || declared.some(project => !actual.some(test => test.projectId === project.id))) {
        return { code: "PLAYWRIGHT_INVENTORY_PROJECTS_INCOMPLETE" };
      }
    }
    return { keys: new Set(keys) };
  } catch {
    return { code: "PLAYWRIGHT_INVENTORY_INVALID" };
  }
}

/**
 * Each project collecting the bound test in a separate Playwright --list JSON inventory must supply
 * one passing execution. Duplicate projects, skips, retries and expected failures fail as before.
 * Spec paths are relative to config.rootDir (https://playwright.dev/docs/test-reporters#json-reporter).
 * @param {object[]} records active browser-level records
 * @param {object[]} reports parsed execution reports
 * @param {string} root repository root
 * @param {object[]} inventories parsed --list reports, produced independently of execution
 * @returns {{ id: string, code: string }[]}
 */
export function evaluatePlaywright(records, reports, root, inventories = []) {
  let executions;
  try { executions = indexPlaywrightTests(reports, root); } catch { executions = null; }
  const inventory = playwrightInventory(inventories, root);
  return records.map(record => {
    const file = record.impl?.file;
    const name = record.impl?.testName;
    if (typeof file !== "string" || typeof name !== "string" || !file || !name) return { id: record.id, code: "BINDING_MISSING" };
    if (!existsSync(path.join(root, file))) return { id: record.id, code: "BINDING_FILE_MISSING" };
    if (!executions) return { id: record.id, code: "PLAYWRIGHT_REPORT_INVALID" };
    const found = executions.get(`${normalise(file)}\0${name}`) ?? [];
    if (found.length === 0) {
      return { id: record.id, code: normalise(file) === ROLE_AUDIT_SPEC ? "ROLE_AUDIT_EVIDENCE_NOT_JOINED" : "BROWSER_REPLAY_NOT_EXECUTED" };
    }
    if (found.some(test => test.status === "skipped")) return { id: record.id, code: "TEST_SKIPPED" };
    if (found.some(test => test.status === "flaky")) return { id: record.id, code: "TEST_FLAKY" };
    if (found.some(test => test.status !== "expected" || test.expectedStatus !== "passed")) {
      return { id: record.id, code: "TEST_FAILED" };
    }
    if (found.some(test => typeof test.projectId !== "string" || test.projectId.length === 0 ||
        !Array.isArray(test.results) || test.results.length !== 1 || test.results[0]?.status !== "passed" || test.results[0]?.retry !== 0)) {
      return { id: record.id, code: "TEST_EXECUTION_UNVERIFIED" };
    }
    if (new Set(found.map(projectKey)).size !== found.length) {
      return { id: record.id, code: "TEST_EXECUTION_DUPLICATE" };
    }
    if (reports.some(report => !Array.isArray(report?.errors) || report.errors.length > 0)) return { id: record.id, code: "PLAYWRIGHT_REPORT_INVALID" };
    if (reports.some(report => inventories.includes(report))) return { id: record.id, code: "PLAYWRIGHT_EVIDENCE_REUSED" };
    if (inventory.code) return { id: record.id, code: inventory.code };
    if (found.some(test => {
      try {
        const config = inventory.configs.get(configPath(test.evidenceConfig));
        return !config || configSignature(test.evidenceConfig) !== configSignature(config);
      } catch { return true; }
    })) return { id: record.id, code: "PLAYWRIGHT_CONFIG_MISMATCH" };
    const expected = expectedProjects(inventory, file, name, root);
    if (expected.code) return { id: record.id, code: expected.code };
    if (found.some(test => !expected.keys.has(projectKey(test)))) return { id: record.id, code: "TEST_PROJECT_NOT_COLLECTED" };
    if ([...expected.keys].some(project => !found.some(test => projectKey(test) === project))) {
      return { id: record.id, code: "TEST_PROJECT_NOT_EXECUTED" };
    }
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

/**
 * Counts only. Failing ids are listed because the records are already public in the repository.
 * @param {any} selection
 * @param {{ id: string, code: string }[]} verdicts
 * @param {string[]} extraIssues
 * @param {{ id: string, code: string }[] | null} [browserVerdicts] full tier only; the PR tier derives them from the selection
 * @param {string} [tier]
 */
export function summarise(selection, verdicts, extraIssues, browserVerdicts = null, tier = "pr") {
  const counts = {};
  // A browser record this PR requires cannot be executed here, so it is a failed verdict, not a skip.
  // In the full tier the browser records carry verdicts read from the Playwright reports.
  const all = [...verdicts, ...(browserVerdicts ?? selection.browserSelected.map(record => ({ id: record.id, code: "BROWSER_REPLAY_NOT_EXECUTED" })))];
  for (const verdict of all) counts[verdict.code] = (counts[verdict.code] ?? 0) + 1;
  const failures = all.filter(verdict => verdict.code !== "PASS");
  const issues = [...extraIssues];
  if (selection.browserUnmapped.length) issues.push(`BROWSER_SCREEN_MAPPING_MISSING:${selection.browserUnmapped.length}`);
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
 *   tier?: "pr" | "full", playwrightReports?: object[], playwrightInventories?: object[], reportProblems?: string[] }} options
 */
export function runPrScenarios({ root, config, execute = runVitest, changedFiles = null, tier = "pr", playwrightReports = [], playwrightInventories = [], reportProblems = [] }) {
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
  const browserVerdicts = tier === "full" || playwrightReports.length > 0
    ? evaluatePlaywright(selection.browserSelected, playwrightReports, root, playwrightInventories)
    : null;
  return summarise(selection, evaluate(selection.run, report, root), issues, browserVerdicts, tier);
}

/** Reads Playwright JSON reports. An unreadable or non-report file is a problem (FAIL), never dropped. */
export function readPlaywrightReports(paths, kind = "REPORT") {
  const reports = [];
  const problems = [];
  for (const file of paths) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed?.suites)) problems.push(`PLAYWRIGHT_${kind}_INVALID`);
      else if (kind === "INVENTORY") {
        const inventory = playwrightInventory([parsed], path.dirname(file));
        if (inventory.code) problems.push(inventory.code);
        else reports.push(parsed);
      } else reports.push(parsed);
    } catch {
      problems.push(`PLAYWRIGHT_${kind}_UNREADABLE`);
    }
  }
  return { reports, problems };
}

function requireInsideRoot(root, file) {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("CLI_PATH_OUTSIDE_ROOT");
  }
  return file;
}

/** Resolve read-only CLI inputs under the host root, including existing symlink targets. */
function resolveRepoInput(root, value) {
  if (!value.trim() || value.includes("\0")) throw new Error("CLI_PATH_INVALID");
  const file = requireInsideRoot(root, path.resolve(root, value));
  return existsSync(file) ? requireInsideRoot(root, realpathSync(file)) : file;
}

function prepareInvocation(argv, host) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
    options: { root: { type: "string" }, config: { type: "string" }, base: { type: "string" },
      tier: { type: "string", default: "pr" }, "playwright-report": { type: "string", multiple: true },
      "playwright-inventory": { type: "string", multiple: true } } });
  if (values.tier !== "pr" && values.tier !== "full") throw new Error("CLI_TIER_INVALID");
  const root = realpathSync(host.root);
  // --root only confirms the host-selected root. CLI text never supplies a filesystem path here.
  if (values.root !== undefined && values.root !== root && values.root !== path.resolve(host.root)) {
    throw new Error("ROOT_CONTEXT_MISMATCH");
  }
  return { root, base: values.base, tier: values.tier,
    config: values.config === undefined ? undefined : resolveRepoInput(root, values.config),
    reportPaths: (values["playwright-report"] ?? []).map(file => resolveRepoInput(root, file)),
    inventoryPaths: (values["playwright-inventory"] ?? []).map(file => resolveRepoInput(root, file)) };
}

const DEFAULT_HOST = Object.freeze({ root: path.join(path.dirname(fileURLToPath(import.meta.url)), "../..") });

/** The embedding host may supply a fixture root; the standalone CLI uses this module's checkout. */
export function main(argv = process.argv.slice(2), host = DEFAULT_HOST) {
  let invocation;
  try {
    invocation = prepareInvocation(argv, host);
  } catch {
    process.stderr.write("Invalid CLI arguments: --root must match the host-selected root; --config, --playwright-report and --playwright-inventory must stay inside that root; --tier must be pr or full.\n");
    return 2;
  }
  const { root, config, base, tier, reportPaths, inventoryPaths } = invocation;
  let changedFiles = null;
  if (tier === "pr") {
    try {
      changedFiles = changedFilesSince(root, base);
    } catch {
      // Left null: the PR diff is unknown, so every active browser record counts as selected and the run fails.
    }
  }
  const { reports, problems } = readPlaywrightReports(reportPaths);
  const inventory = readPlaywrightReports(inventoryPaths, "INVENTORY");
  const summary = runPrScenarios({ root, config, changedFiles, tier, playwrightReports: reports,
    playwrightInventories: inventory.reports, reportProblems: [...problems, ...inventory.problems,
      ...(reportPaths.some(file => inventoryPaths.includes(file)) ? ["PLAYWRIGHT_EVIDENCE_REUSED"] : [])] });
  const text = JSON.stringify(summary, null, 2);
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Regression library runner (${summary.tier} tier): ${summary.verdict}\n\n\`\`\`json\n${text}\n\`\`\`\n`);
  }
  return summary.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
