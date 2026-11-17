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
import { readBrowserReplayManifest } from "./trustedBrowserManifest.mjs";
import { hostedReplayCandidate } from "./trustedBrowserSource.mjs";
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
 * requires matching Playwright execution evidence to pass. Browser records without
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
    const key = `${normalise(path.relative(root, realpathSync(file)))}\0${title}`;
    const matches = executions.get(key);
    if (matches) matches.push(test);
    else executions.set(key, [test]);
  };
  const walk = (suite, report, titles = []) => {
    if (!suite || (suite.specs !== undefined && !Array.isArray(suite.specs)) ||
        (suite.suites !== undefined && !Array.isArray(suite.suites))) throw new Error("Invalid suite");
    const titlePath = [...titles, suite.title ?? ""];
    for (const spec of suite.specs ?? []) {
      if (!spec || !Array.isArray(spec.tests)) throw new Error("Invalid spec");
      for (const test of spec.tests ?? []) {
        const base = report.config?.rootDir;
        if (typeof base === "string" && base) add(path.resolve(base, spec.file ?? suite.file ?? ""), spec.title, { ...test, evidenceConfig: report.config, titlePath: [...titlePath, spec.title] });
      }
    }
    for (const child of suite.suites ?? []) walk(child, report, titlePath);
  };
  for (const report of reports) for (const suite of report?.suites ?? []) walk(suite, report);
  return executions;
}

// Config identity is part of execution identity: project names are not unique across configs.
const configPath = config => typeof config?.configFile === "string" && path.isAbsolute(config.configFile)
  ? normalise(path.resolve(config.configFile)) : null;
const projectKey = test => `${configPath(test.evidenceConfig)}\0${test.projectId}`;

// Config paths are selected by repository policy, never passed through from report text.
const PLAYWRIGHT_CONFIGS = Object.freeze({
  tests: { file: "playwright.config.ts", env: {} },
  visual: { file: "playwright.visual.config.ts", env: {} },
  "opening-visual": { file: "playwright.opening.visual.config.ts", env: {} },
  scenarios: { file: "playwright.scenarios.config.ts", env: { CROSS_SCREEN_ORACLE: "1" } },
  "opening-proof": { file: "playwright.opening-proof.config.ts", env: {} },
});

// Tier obligations are repository policy; omitting a report cannot remove an execution requirement.
export const PLAYWRIGHT_REQUIRED_REPORTS = Object.freeze({
  pr: Object.freeze(["visual", "opening-visual"]),
  full: Object.freeze(["tests", "visual", "opening-visual", "scenarios", "opening-proof"]),
});

function configSignature(config) {
  if (!configPath(config) || !path.isAbsolute(config.rootDir ?? "") ||
      !Array.isArray(config.projects) || config.projects.length === 0) return null;
  const projects = config.projects.map(project => {
    if (typeof project?.id !== "string" || !project.id || typeof project.name !== "string") throw new Error("Invalid project");
    return { id: project.id, name: project.name, testDir: project.testDir,
      testMatch: project.testMatch, testIgnore: project.testIgnore };
  });
  if (new Set(projects.map(project => project.id)).size !== projects.length) return null;
  return JSON.stringify({ file: configPath(config), root: normalise(path.resolve(config.rootDir)), projects });
}

function listPlaywright(root, configFile, env) {
  try {
    requireInsideRoot(root, realpathSync(configFile));
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    // Prevent inherited reporter output settings from diverting JSON to an execution report.
    const listingEnv = { ...process.env, ...env };
    for (const key of Object.keys(listingEnv)) if (key.startsWith("PLAYWRIGHT_JSON_")) delete listingEnv[key];
    const listed = spawnSync(process.execPath, [cli, "test", "--config", configFile, "--list", "--reporter=json", "--workers=1"], {
      cwd: root, env: listingEnv, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (listed.error || listed.status !== 0) return { code: "PLAYWRIGHT_DISCOVERY_FAILED" };
    return { report: JSON.parse(listed.stdout) };
  } catch {
    // Config/test modules can log tenant data: expose the refusal code, never subprocess output.
    return { code: "PLAYWRIGHT_DISCOVERY_FAILED" };
  }
}

function validateDiscovery(inventory, configFile, root) {
  if (!Array.isArray(inventory?.suites) || !configSignature(inventory.config) ||
      configPath(inventory.config) !== normalise(configFile) ||
      !Array.isArray(inventory.errors) || inventory.errors.length > 0) return "PLAYWRIGHT_INVENTORY_INVALID";
  const collected = indexPlaywrightTests([inventory], root);
  if (collected.size === 0) return "PLAYWRIGHT_INVENTORY_EMPTY";
  for (const tests of collected.values()) {
    if (tests.some(test => typeof test.projectId !== "string" || !test.projectId ||
        !Array.isArray(test.results) || test.results.length !== 0 || test.status !== "skipped")) return "PLAYWRIGHT_INVENTORY_INVALID";
  }
  return null;
}

function discoverPlaywright(sources, root, tier) {
  const inventories = [];
  const configs = new Map();
  try {
    for (const { configName, report } of sources) {
      const allowed = tier === undefined || PLAYWRIGHT_REQUIRED_REPORTS[tier].includes(configName);
      const configured = allowed && Object.hasOwn(PLAYWRIGHT_CONFIGS, configName) ? PLAYWRIGHT_CONFIGS[configName] : null;
      if (!configured) return { code: "PLAYWRIGHT_CONFIG_MISMATCH" };
      const configFile = path.resolve(root, configured.file);
      if (normalise(configFile) !== configPath(report?.config)) return { code: "PLAYWRIGHT_CONFIG_MISMATCH" };
      if (configs.has(normalise(configFile))) continue;
      const listing = listPlaywright(root, configFile, configured.env);
      if (listing.code) return listing;
      const code = validateDiscovery(listing.report, configFile, root);
      if (code) return { code };
      configs.set(configPath(report.config), listing.report.config);
      inventories.push(listing.report);
    }
    return { tests: indexPlaywrightTests(inventories, root), configs };
  } catch {
    return { code: "PLAYWRIGHT_INVENTORY_INVALID" };
  }
}

// Playwright serializes suite titles and project ids in both listing and execution JSON.
const executionKey = test => `${projectKey(test)}\0${JSON.stringify(test.titlePath)}`;

function expectedProjects(inventory, file, name, root) {
  const key = `${normalise(path.relative(root, realpathSync(path.resolve(root, file))))}\0${name}`;
  const collected = inventory.tests.get(key) ?? [];
  const projects = collected.map(projectKey);
  if (new Set(projects).size !== projects.length) return { code: "PLAYWRIGHT_INVENTORY_INVALID" };
  if (projects.length === 0) return { code: "TEST_NOT_COLLECTED" };
  return { keys: new Set(collected.map(executionKey)) };
}

function executionRefusal(found) {
  if (found.some(test => test.status === "skipped")) return "TEST_SKIPPED";
  if (found.some(test => test.status === "flaky")) return "TEST_FLAKY";
  if (found.some(test => test.status !== "expected" || test.expectedStatus !== "passed")) return "TEST_FAILED";
  if (found.some(test => typeof test.projectId !== "string" || test.projectId.length === 0 ||
      !Array.isArray(test.results) || test.results.length !== 1 || test.results[0]?.status !== "passed" || test.results[0]?.retry !== 0)) return "TEST_EXECUTION_UNVERIFIED";
  if (new Set(found.map(projectKey)).size !== found.length) return "TEST_EXECUTION_DUPLICATE";
  return null;
}

function unsafeExecution(config) {
  return !Array.isArray(config?.argv) || config.argv.some(arg => typeof arg !== "string" ||
    /^(?:-u|--update-snapshots|--ignore-snapshots|--pass-with-no-tests)(?:=|$)/.test(arg)) ||
    ["all", "changed"].includes(config.updateSnapshots);
}

function collectionRefusal(found, inventory, binding) {
  if (inventory.code) return inventory.code;
  try {
    if (found.some(test => configSignature(test.evidenceConfig) !== configSignature(inventory.configs.get(configPath(test.evidenceConfig))))) return "PLAYWRIGHT_CONFIG_MISMATCH";
  } catch { return "PLAYWRIGHT_CONFIG_MISMATCH"; }
  const expected = expectedProjects(inventory, binding.file, binding.name, binding.root);
  if (expected.code) return expected.code;
  if (found.some(test => !expected.keys.has(executionKey(test)))) return "TEST_PROJECT_NOT_COLLECTED";
  if ([...expected.keys].some(key => !found.some(test => executionKey(test) === key))) return "TEST_PROJECT_NOT_EXECUTED";
  return "PASS";
}

/** Judge-owned discovery; execution JSON is consistency-checked, not authenticated. */
export function evaluatePlaywright(records, sources, root) {
  return evaluateBrowserRecords(records, sources.map(source => source.report), root, discoverPlaywright(sources, root));
}

// The trusted authenticated job has already run independent discovery with the
// exact project selection and environment used for execution. Its report pair
// comes from that job, never from the scenario runner's caller or a PR artifact.
export function evaluateTrustedBrowserReplay(record, report, discovery, root) {
  return evaluateTrustedBrowserReplays([record], { report, discovery, root, configName: "tests" })[0];
}

export function evaluateTrustedBrowserReplays(records, { report, discovery, root, configName }) {
  if (configName !== "tests" && configName !== "scenarios") {
    return records.map(({ id }) => ({ id, code: "PLAYWRIGHT_CONFIG_MISMATCH" }));
  }
  const configFile = path.resolve(root, PLAYWRIGHT_CONFIGS[configName].file);
  if (report && configPath(report.config) !== normalise(configFile)) {
    return records.map(({ id }) => ({ id, code: "PLAYWRIGHT_CONFIG_MISMATCH" }));
  }
  let inventory;
  try {
    const code = validateDiscovery(discovery, configFile, root);
    inventory = code ? { code } : {
      tests: indexPlaywrightTests([discovery], root),
      configs: new Map([[normalise(configFile), discovery.config]]),
    };
  } catch {
    inventory = { code: "PLAYWRIGHT_INVENTORY_INVALID" };
  }
  return evaluateBrowserRecords(records, [report], root, inventory);
}

function evaluateBrowserRecords(records, reports, root, inventory) {
  let executions;
  try { executions = indexPlaywrightTests(reports, root); } catch { executions = null; }
  const reportInvalid = reports.some(report => !Array.isArray(report?.errors) || report.errors.length > 0);
  return records.map(record => {
    const file = record.impl?.file;
    const name = record.impl?.testName;
    if (typeof file !== "string" || typeof name !== "string" || !file || !name) return { id: record.id, code: "BINDING_MISSING" };
    if (!existsSync(path.join(root, file))) return { id: record.id, code: "BINDING_FILE_MISSING" };
    if (!executions) return { id: record.id, code: "PLAYWRIGHT_REPORT_INVALID" };
    const key = `${normalise(path.relative(root, realpathSync(path.join(root, file))))}\0${name}`;
    const found = executions.get(key) ?? [];
    if (found.length === 0) return { id: record.id, code: normalise(file) === ROLE_AUDIT_SPEC ? "ROLE_AUDIT_EVIDENCE_NOT_JOINED" : "BROWSER_REPLAY_NOT_EXECUTED" };
    const refusal = executionRefusal(found);
    if (refusal) return { id: record.id, code: refusal };
    if (reportInvalid) return { id: record.id, code: "PLAYWRIGHT_REPORT_INVALID" };
    if (reports.some(report => unsafeExecution(report.config))) return { id: record.id, code: "PLAYWRIGHT_EXECUTION_UNSAFE" };
    return { id: record.id, code: collectionRefusal(found, inventory, { file, name, root }) };
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
 * @param {{ id: string, code: string }[] | null} [browserVerdicts] joined evidence for either tier; null uses the missing-evidence fallback
 * @param {string} [tier]
 */
export function summarise(selection, verdicts, extraIssues, browserVerdicts = null, tier = "pr") {
  const counts = {};
  // Without joined reports, selected browser records fail rather than skip.
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

function applyRequiredReports(verdicts, sources, tier) {
  const supplied = new Set(sources.map(source => source.configName));
  if (PLAYWRIGHT_REQUIRED_REPORTS[tier].every(label => supplied.has(label))) return verdicts;
  // Preserve every existing refusal, including collection failures, before refusing an otherwise passing join.
  return verdicts.map(verdict => verdict.code === "PASS"
    ? { ...verdict, code: "PLAYWRIGHT_REQUIRED_REPORT_MISSING" } : verdict);
}

function joinMissingTrustedReplays(verdicts, selected, resolveBrowserReplays) {
  const missing = new Map(verdicts.flatMap(({ id, code }) => {
    if (code === "BROWSER_REPLAY_NOT_EXECUTED") return [[id, "browser-replay"]];
    if (code === "ROLE_AUDIT_EVIDENCE_NOT_JOINED") return [[id, "role-audit"]];
    return [];
  }));
  if (!missing.size) return verdicts;
  const proven = resolveBrowserReplays(selected.filter(({ id }) => missing.has(id)));
  const passed = new Set(proven.filter(({ id, code, evidence }) => code === "PASS" &&
    missing.get(id) === (evidence ?? "browser-replay")).map(({ id }) => id));
  return verdicts.map(verdict => passed.has(verdict.id) &&
    ["BROWSER_REPLAY_NOT_EXECUTED", "ROLE_AUDIT_EVIDENCE_NOT_JOINED"].includes(verdict.code) ? { ...verdict, code: "PASS" } : verdict);
}

/**
 * @param {{ root: string, config?: string, execute?: typeof runVitest, changedFiles?: string[] | null,
 *   tier?: "pr" | "full", playwrightReports?: object[], reportProblems?: string[],
 *   resolveBrowserReplays?: (selected: object[]) => {id: string, code: string, evidence?: string}[] }} options
 */
export function runPrScenarios({ root, config, execute = runVitest, changedFiles = null, tier = "pr", playwrightReports = [], reportProblems = [], resolveBrowserReplays }) {
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
  const discovery = discoverPlaywright(playwrightReports, root, tier);
  if (discovery.code) issues.push(discovery.code);
  const localBrowserVerdicts = tier === "full" || playwrightReports.length > 0
    ? evaluateBrowserRecords(selection.browserSelected, playwrightReports.map(source => source.report), root, discovery)
    : null;
  const mayJoin = tier === "pr" && localBrowserVerdicts && resolveBrowserReplays && !issues.length && !selection.changedFilesUnavailable;
  const joined = mayJoin ? joinMissingTrustedReplays(localBrowserVerdicts, selection.browserSelected, resolveBrowserReplays) : localBrowserVerdicts;
  const browserVerdicts = joined && applyRequiredReports(joined, playwrightReports, tier);
  return summarise(selection, evaluate(selection.run, report, root), issues, browserVerdicts, tier);
}

/** Reads Playwright JSON reports. An unreadable or non-report file is a problem (FAIL), never dropped. */
export function readPlaywrightReports(sources) {
  const reports = [];
  const problems = [];
  for (const { file, configName } of sources) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed?.suites)) problems.push("PLAYWRIGHT_REPORT_INVALID");
      else reports.push({ configName, report: parsed });
    } catch {
      problems.push("PLAYWRIGHT_REPORT_UNREADABLE");
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

function resolveReportInput(root, value) {
  const separator = value.indexOf("=");
  const configName = value.slice(0, separator);
  if (separator < 1 || !Object.hasOwn(PLAYWRIGHT_CONFIGS, configName)) throw new Error("CLI_REPORT_CONFIG_INVALID");
  return { configName, file: resolveRepoInput(root, value.slice(separator + 1)) };
}

function prepareInvocation(argv, host) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
    options: { root: { type: "string" }, config: { type: "string" }, base: { type: "string" },
      tier: { type: "string", default: "pr" }, "playwright-report": { type: "string", multiple: true } } });
  if (values.tier !== "pr" && values.tier !== "full") throw new Error("CLI_TIER_INVALID");
  const root = realpathSync(host.root);
  // --root only confirms the host-selected root. CLI text never supplies a filesystem path here.
  if (values.root !== undefined && values.root !== root && values.root !== path.resolve(host.root)) {
    throw new Error("ROOT_CONTEXT_MISMATCH");
  }
  return { root, base: values.base, tier: values.tier,
    config: values.config === undefined ? undefined : resolveRepoInput(root, values.config),
    reportPaths: (values["playwright-report"] ?? []).map(value => resolveReportInput(root, value)) };
}

const DEFAULT_HOST = Object.freeze({ root: path.join(path.dirname(fileURLToPath(import.meta.url)), "../..") });

function hostedBrowserReplayResolver(root, base, env) {
  if (!env.AUTOFLOW_VERIFIED_BROWSER_REPLAYS) return undefined;
  try {
    const candidate = hostedReplayCandidate(env, base);
    if (!candidate) return undefined;
    const git = resolveTrustedGitExecutable();
    const checkedOut = execFileSync(git, ["rev-parse", "HEAD"], {
      cwd: root, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (checkedOut !== candidate.testedSha) return undefined;
    const manifest = env.AUTOFLOW_VERIFIED_BROWSER_REPLAYS;
    return selected => readBrowserReplayManifest(manifest, candidate, selected);
  } catch {
    return undefined;
  }
}

function cliRefusalCode(error) {
  const codes = new Set(["CLI_REPORT_CONFIG_INVALID", "CLI_PATH_INVALID", "CLI_PATH_OUTSIDE_ROOT", "CLI_TIER_INVALID", "ROOT_CONTEXT_MISMATCH"]);
  return error instanceof Error && codes.has(error.message) ? error.message : "CLI_ARGUMENTS_INVALID";
}

/** The embedding host may supply a fixture root; the standalone CLI uses this module's checkout. */
export function main(argv = process.argv.slice(2), host = DEFAULT_HOST) {
  let invocation;
  try {
    invocation = prepareInvocation(argv, host);
  } catch (error) {
    process.stderr.write(`${cliRefusalCode(error)}: Invalid CLI arguments: --root must match the host-selected root; --config and --playwright-report must stay inside that root; --playwright-report requires a fixed config label (tests, visual, opening-visual, scenarios, opening-proof)=path; --tier must be pr or full.\n`);
    return 2;
  }
  const { root, config, base, tier, reportPaths } = invocation;
  let changedFiles = null;
  if (tier === "pr") {
    try {
      changedFiles = changedFilesSince(root, base);
    } catch {
      // Left null: the PR diff is unknown, so every active browser record counts as selected and the run fails.
    }
  }
  const { reports, problems } = readPlaywrightReports(reportPaths);
  const resolveBrowserReplays = tier === "pr" ? hostedBrowserReplayResolver(root, base, process.env) : undefined;
  const summary = runPrScenarios({ root, config, changedFiles, tier, playwrightReports: reports, reportProblems: problems, resolveBrowserReplays });
  const text = JSON.stringify(summary, null, 2);
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Regression library runner (${summary.tier} tier): ${summary.verdict}\n\n\`\`\`json\n${text}\n\`\`\`\n`);
  }
  return summary.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
