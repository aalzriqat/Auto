// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { changedFilesSince, evaluate, evaluatePlaywright as judgePlaywright, evaluateTrustedBrowserReplay, evaluateTrustedBrowserReplays, loadRecords, main, readPlaywrightReports as readReportSources, runPrScenarios as judgeRun, selectForPr, selectFull, staticExecutionCensus, summarise } from "./prRunner.mjs";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";

// Mock only the subprocess I/O boundary for malformed-report cases. Native tests below do not use this seam.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const realSpawnSync = createRequire(import.meta.url)("node:child_process").spawnSync as typeof spawnSync;

function withDiscovery<T>(inventories: object[], callback: () => T): T {
  for (const inventory of inventories) {
    const file = (inventory as { config?: { configFile?: string } }).config?.configFile;
    if (file && !existsSync(file)) writeFileSync(file, "export default {};\n");
  }
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    if (Array.isArray(args) && args.includes("--list")) {
      const file = args[args.indexOf("--config") + 1];
      const listed = inventories.find(inventory => (inventory as { config?: { configFile?: string } }).config?.configFile === file);
      return { status: listed ? 0 : 1, stdout: JSON.stringify(listed), stderr: "", signal: null, pid: 1, output: [] } as ReturnType<typeof spawnSync>;
    }
    return realSpawnSync(command, args as string[], options as Parameters<typeof spawnSync>[2]);
  });
  try { return callback(); } finally { vi.mocked(spawnSync).mockImplementation(realSpawnSync); }
}

const fixtureConfigNames: Record<string, string> = {
  "playwright.config.ts": "tests", "playwright.visual.config.ts": "visual",
  "playwright.opening.visual.config.ts": "opening-visual", "playwright.scenarios.config.ts": "scenarios",
  "playwright.opening-proof.config.ts": "opening-proof",
};
function fixtureSources(reports: object[]) {
  return reports.map(report => ({
    configName: fixtureConfigNames[path.basename((report as { config: { configFile: string } }).config.configFile)] ?? "tests",
    report,
  }));
}
function labelledCopies<T extends { config: { configFile: string } }>(report: T, labels: string[]): T[] {
  return labels.map(label => {
    const file = Object.keys(fixtureConfigNames).find(file => fixtureConfigNames[file] === label);
    if (!file) throw new Error(`Unknown fixture label ${label}`);
    const copy = structuredClone(report);
    copy.config.configFile = path.join(path.dirname(report.config.configFile), file);
    return copy;
  });
}
function evaluatePlaywright(records: Parameters<typeof judgePlaywright>[0], reports: object[], root: string, inventories?: object[]) {
  return inventories === undefined ? judgePlaywright(records, fixtureSources(reports), root)
    : withDiscovery(inventories, () => judgePlaywright(records, fixtureSources(reports), root));
}
function runPrScenarios(options: Parameters<typeof judgeRun>[0] & { playwrightInventories?: object[] }) {
  const bound = { ...options, playwrightReports: fixtureSources(options.playwrightReports ?? []) };
  return options.playwrightInventories === undefined ? judgeRun(bound)
    : withDiscovery(options.playwrightInventories, () => judgeRun(bound));
}
function readPlaywrightReports(paths: string[]) {
  return readReportSources(paths.map(file => ({ file, configName: "tests" })));
}

// The runner is exercised against a throwaway project and the real Vitest: the verdicts below come from
// executed tests, not from a stubbed report. Fixture tests use Vitest globals so the project needs no node_modules.
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface FixtureRecord {
  id: string;
  file?: string;
  testName?: string;
  status?: string;
  level?: string;
}

function makeProject(files: Record<string, string>, records: FixtureRecord[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "pr-runner-fixture-"));
  roots.push(root);
  writeFileSync(path.join(root, "vitest.config.mjs"), 'export default { test: { globals: true, include: ["**/*.fixture.js"] } };\n');
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, name), body);
  mkdirSync(path.join(root, "regression", "scenarios", "money"), { recursive: true });
  for (const record of records) {
    const body = {
      id: record.id, domain: "money", level: record.level ?? "backend", status: record.status ?? "active",
      ...(record.level === "browser" ? { sourceGlobs: ["components/fixture/**"] } : {}),
      ...(record.file === undefined ? {} : { impl: { file: record.file, testName: record.testName } }),
    };
    writeFileSync(path.join(root, "regression", "scenarios", "money", `${record.id}.scenario.json`), JSON.stringify(body));
  }
  return root;
}

const config = (root: string) => path.join(root, "vitest.config.mjs");

function testExecution(projectId: string, status: string, expectedStatus = "passed", results = ["passed"]) {
  return { projectId, projectName: projectId, status, expectedStatus, results: results.map((status, retry) => ({ status, retry })) };
}

function playwrightConfig(root: string, testDir = root, projects = ["chromium"]) {
  return { version: "1.61.1", configFile: path.join(root, "playwright.config.ts"), rootDir: testDir,
    argv: [process.execPath, "playwright/cli.js", "test", "--list", "--reporter=json"],
    projects: projects.map(id => ({ id, name: id, testDir, testMatch: ["**/*"], testIgnore: [] as string[] })) };
}
const discoveryStats = { expected: 0, unexpected: 0, flaky: 0, skipped: 1 };
const discoveredTest = (projectId: string) => ({ projectId, status: "skipped", results: [] as { status: string; retry: number }[] });

/** The embedding host selects the fixture root; argv cannot select another checkout. */
function invokeMain(root: string, argv: string[]) {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_STEP_SUMMARY;
  try {
    const status = main(argv, { root });
    return { status, stdout: stdout.mock.calls.map(([text]) => String(text)).join(""), stderr: stderr.mock.calls.map(([text]) => String(text)).join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummary;
  }
}

// SCRUM-761 / PR 822 F1: the caller's report subset must not define the tier's obligations.
describe("SCRUM-761e required report policy through the workflow CLI", () => {
  const configs = [
    ["tests", "playwright.config.ts", "scripted|unique tests"],
    ["visual", "playwright.visual.config.ts", "opening one|opening two|unique visual"],
    ["opening-visual", "playwright.opening.visual.config.ts", "opening one|opening two|unique opening-visual"],
    ["scenarios", "playwright.scenarios.config.ts", "scripted|unique scenarios"],
    ["opening-proof", "playwright.opening-proof.config.ts", "unique opening-proof"],
  ];
  const tierLabels = { pr: ["visual", "opening-visual"], full: configs.map(([label]) => label) };
  const nativeSchema = z.object({
    config: z.object({ configFile: z.string(), rootDir: z.string(), argv: z.array(z.string()),
      projects: z.array(z.object({ id: z.string(), name: z.string(), testDir: z.string(),
        testMatch: z.array(z.string()), testIgnore: z.array(z.string()),
      }).passthrough()).min(1),
    }).passthrough(),
    errors: z.array(z.object({ message: z.string().optional() }).passthrough()),
    suites: z.array(z.object({ title: z.string(), specs: z.array(z.object({
      title: z.string(), file: z.string(), tests: z.array(z.object({
        projectId: z.string(), status: z.string(), expectedStatus: z.string(),
        results: z.array(z.object({ status: z.string(), retry: z.number() }).passthrough()),
      }).passthrough()),
    }).passthrough()) }).passthrough()),
  }).passthrough();
  const reports = new Map<string, z.infer<typeof nativeSchema>>();
  const inventories: z.infer<typeof nativeSchema>[] = [];
  const controls = new Map<string, ReturnType<typeof invokeMain>>();
  const nativeOmissions = [["pr", "opening-visual"], ["full", "scenarios"]] as const;
  const missingControls = new Map<string, ReturnType<typeof invokeMain>>();
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  let root: string;
  let base: string;

  beforeAll(() => {
    root = makeProject({}, []);
    const titles = ["opening one", "opening two", "scripted", ...configs.map(([label]) => `unique ${label}`)];
    writeFileSync(path.join(root, "policy.spec.cjs"), `const {test,expect}=require(${JSON.stringify(require.resolve("@playwright/test"))});\n` +
      titles.map(title => `test(${JSON.stringify(title)},()=>expect(1+1).toBe(2));`).join("\n"));
    const git = (args: string[]) => execFileSync(resolveTrustedGitExecutable(), args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    git(["init", "--initial-branch=main"]);
    git(["-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "--allow-empty", "-m", "base"]);
    base = git(["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "screen.txt"), "changed");
    git(["add", "screen.txt"]);
    git(["-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "screen"]);
  });

  function nativeReport(file: string, extra: string[] = []) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("PLAYWRIGHT_JSON_")) delete env[key];
    const child = spawnSync(process.execPath, [cli, "test", "-c", file, "--workers=1", "--reporter=json", ...extra], {
      cwd: root, env, encoding: "utf8", timeout: 15000, maxBuffer: 32 * 1024 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const parsed: unknown = JSON.parse(child.stdout);
    return nativeSchema.parse(parsed);
  }
  // Each native setup stays within the normal hook budget. All projects deliberately share a name across configs.
  for (const [label, file, grep] of configs) {
    beforeAll(() => {
      writeFileSync(path.join(root, file), `module.exports={testMatch:'policy.spec.cjs',grep:/${grep}/,projects:[{name:'chromium'},{name:'webkit'}]};`);
      const report = nativeReport(file);
      reports.set(label, report);
      inventories.push(nativeReport(file, ["--list"]));
      writeFileSync(path.join(root, `${label}.json`), JSON.stringify(report));
    });
  }

  it("counts a trusted explorer execution only from its independently discovered config", () => {
    const records = [{ id: "explorer", impl: { file: "policy.spec.cjs", testName: "scripted" } }];
    const discovery = inventories.find(inventory => path.basename(inventory.config.configFile) === "playwright.scenarios.config.ts");
    const observe = (label: string) => evaluateTrustedBrowserReplays(records, {
      root, configName: "scenarios", report: reports.get(label), discovery,
    });

    expect(observe("scenarios")).toEqual([{ id: "explorer", code: "PASS" }]);
    expect(observe("tests")).toEqual([{ id: "explorer", code: "PLAYWRIGHT_CONFIG_MISMATCH" }]);
  });

  function policyInvocation(tier: "pr" | "full", labels: string[], titles = ["opening one", "opening two"]): ReturnType<typeof invokeMain> {
    writeFileSync(path.join(root, "regression/scenarios/policy.scenario.json"), JSON.stringify({
      id: "policy", status: "active", level: "browser", sourceGlobs: ["screen.txt"],
      impl: { file: "policy.spec.cjs", testName: titles[0] },
    }));
    // Two opening bindings must each survive an overlapping report disappearing.
    const second = path.join(root, "regression/scenarios/second.scenario.json");
    if (titles.length > 1) writeFileSync(second, JSON.stringify({
      id: "second", status: "active", level: "browser", sourceGlobs: ["screen.txt"],
      impl: { file: "policy.spec.cjs", testName: titles[1] },
    }));
    else if (existsSync(second)) unlinkSync(second);
    return invokeMain(root, ["--tier", tier, "--base", base, ...labels.flatMap(label => ["--playwright-report", `${label}=${label}.json`])]);
  }

  for (const tier of ["pr", "full"] as const) {
    beforeAll(() => { controls.set(tier, policyInvocation(tier, tierLabels[tier])); });
  }
  for (const [tier, omitted] of nativeOmissions) {
    beforeAll(() => {
      const titles = tier === "full" ? ["scripted"] : ["opening one", "opening two"];
      missingControls.set(tier, policyInvocation(tier, tierLabels[tier].filter(label => label !== omitted), titles));
    });
  }
  it.each(["pr", "full"] as const)("all native reports give PASS in the %s tier", tier => {
    const result = controls.get(tier)!;
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: "PASS", selected: 2, passed: 2, failed: 0, issues: [] });
  });

  it.each([
    ["tests", "scripted"], ["scenarios", "scripted"], ["opening-proof", "unique opening-proof"],
  ])("PR never lists the backend-backed %s config", (label, title) => {
    const file = Object.keys(fixtureConfigNames).find(file => fixtureConfigNames[file] === label)!;
    const configFile = path.join(root, file);
    const original = readFileSync(configFile);
    const marker = path.join(root, `${label}-listed.txt`);
    writeFileSync(configFile, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'listed');\n${original.toString()}`);
    try {
      const result = policyInvocation("pr", [label], [title]);
      expect(existsSync(marker)).toBe(false);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        passed: 0, failureCodes: { PLAYWRIGHT_CONFIG_MISMATCH: 1 }, issues: ["PLAYWRIGHT_CONFIG_MISMATCH"],
      });
    } finally { writeFileSync(configFile, original); }
  });

  it.each(nativeOmissions)("%s refuses native overlapping evidence with %s omitted", tier => {
    const titles = tier === "full" ? ["scripted"] : ["opening one", "opening two"];
    const result = missingControls.get(tier)!;
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      verdict: "FAIL", passed: 0, failed: titles.length,
      failureCodes: { PLAYWRIGHT_REQUIRED_REPORT_MISSING: titles.length }, issues: [],
    });
  });

  // Native inventories are replayed only at the subprocess boundary for the exhaustive class table.
  const omissionCases = (["pr", "full"] as const).flatMap(tier => {
    const labels = tierLabels[tier];
    const omissions = labels.flatMap((label, index) => [[label], ...labels.slice(index + 1).map(other => [label, other])]);
    return omissions.flatMap(omitted => {
      const titles = ["opening one", "opening two", ...labels.map(label => `unique ${label}`), ...(tier === "full" ? ["scripted"] : [])];
      return titles.map(title => {
        const collectors = title.startsWith("opening ") ? ["visual", "opening-visual"]
          : title === "scripted" ? ["tests", "scenarios"] : [title.slice("unique ".length)];
        const code = collectors.every(label => omitted.includes(label)) ? "BROWSER_REPLAY_NOT_EXECUTED" : "PLAYWRIGHT_REQUIRED_REPORT_MISSING";
        return { tier, omitted, title, code };
      });
    });
  });
  it.each(omissionCases)("$tier omitted $omitted binding $title refuses with $code", ({ tier, omitted, title, code }) => {
    const result = withDiscovery(inventories, () => policyInvocation(tier, tierLabels[tier].filter(label => !omitted.includes(label)), [title]));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: "FAIL", passed: 0, failureCodes: { [code]: 1 } });
  });

  it.each(["pr", "full"] as const)("%s without any reports retains its missing-execution refusal", tier => {
    const result = policyInvocation(tier, [], ["opening one"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: "FAIL", passed: 0, failureCodes: { BROWSER_REPLAY_NOT_EXECUTED: 1 } });
  });

  it.each(["pr", "full"] as const)("%s repeated complete evidence retains its duplicate refusal", tier => {
    const result = withDiscovery(inventories, () => policyInvocation(tier, [...tierLabels[tier], "visual"], ["opening one"]));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: "FAIL", passed: 0, failureCodes: { TEST_EXECUTION_DUPLICATE: 1 } });
  });

  it.each([
    ["skipped", "TEST_SKIPPED"], ["flaky", "TEST_FLAKY"], ["failed", "TEST_FAILED"],
    ["retry", "TEST_EXECUTION_UNVERIFIED"], ["duplicate", "TEST_EXECUTION_DUPLICATE"],
    ["report errors", "PLAYWRIGHT_REPORT_INVALID"], ["unsafe", "PLAYWRIGHT_EXECUTION_UNSAFE"],
    ["config mismatch", "PLAYWRIGHT_CONFIG_MISMATCH"], ["wrong project", "TEST_PROJECT_NOT_COLLECTED"],
    ["missing project", "TEST_PROJECT_NOT_EXECUTED"],
  ])("missing required reports preserve the existing %s refusal %s", (kind, code) => {
    const report = structuredClone(reports.get("visual")!);
    const spec = report.suites[0].specs.find(spec => spec.title === "opening one")!;
    if (kind === "skipped") spec.tests[0].status = "skipped";
    if (kind === "flaky") spec.tests[0].status = "flaky";
    if (kind === "failed") spec.tests[0].status = "unexpected";
    if (kind === "retry") spec.tests[0].results[0].retry = 1;
    if (kind === "duplicate") spec.tests.push(structuredClone(spec.tests[0]));
    if (kind === "report errors") report.errors.push({ message: "private report error" });
    if (kind === "unsafe") report.config.argv.push("--ignore-snapshots");
    if (kind === "config mismatch") report.config.projects[0].testMatch = ["other.spec.cjs"];
    if (kind === "wrong project") spec.tests[0].projectId = "never-collected";
    if (kind === "missing project") spec.tests.pop();
    writeFileSync(path.join(root, "visual.json"), JSON.stringify(report));
    try {
      const result = withDiscovery(inventories, () => policyInvocation("pr", ["visual"], ["opening one"]));
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ passed: 0, failureCodes: { [code]: 1 } });
      expect(result.stdout).not.toContain("private report error");
    } finally { writeFileSync(path.join(root, "visual.json"), JSON.stringify(reports.get("visual"))); }
  });

  it.each(["pr", "full"] as const)("%s cannot fill a missing label with disjoint fragments of another label", tier => {
    const visual = reports.get("visual");
    expect(visual).toBeDefined();
    const fragments = ["chromium", "webkit"].map(projectId => {
      const fragment = structuredClone(visual!);
      for (const suite of fragment.suites) for (const spec of suite.specs ?? []) spec.tests = spec.tests.filter(test => test.projectId === projectId);
      const file = `fragment-${projectId}.json`;
      writeFileSync(path.join(root, file), JSON.stringify(fragment));
      return ["--playwright-report", `visual=${file}`];
    });
    const labels = tierLabels[tier].filter(label => label !== "visual" && label !== "opening-visual");
    // Establish the selected record using the same public host entry, then supply the fragments under one label.
    withDiscovery(inventories, () => policyInvocation(tier, [], ["opening one"]));
    const args = ["--tier", tier, "--base", base, ...labels.flatMap(label => ["--playwright-report", `${label}=${label}.json`]), ...fragments.flat()];
    const missing = withDiscovery(inventories, () => invokeMain(root, args));
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ passed: 0, failureCodes: { PLAYWRIGHT_REQUIRED_REPORT_MISSING: 1 } });
    const complete = withDiscovery(inventories, () => invokeMain(root, [...args, "--playwright-report", "opening-visual=opening-visual.json"]));
    expect(complete.status).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({ passed: 1, issues: [] });
  });
});

it("a different --root cannot redirect the host-selected root", () => {
  const root = makeProject({}, []);
  const redirect = makeProject({ "ok.fixture.js": 'test("fine", () => {});\n' }, [{ id: "redirected", file: "ok.fixture.js", testName: "fine" }]);
  const result = invokeMain(root, ["--root", redirect]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--root must match the host-selected root");
  expect(result.stdout).toBe("");
});

describe("CLI path boundary", () => {
  it("a matching --root confirms the host root and preserves the summary file", () => {
    const root = makeProject({ "ok.fixture.js": 'test("fine", () => {});\n' }, [{ id: "host", file: "ok.fixture.js", testName: "fine" }]);
    const summaryFile = path.join(root, "step-summary.md");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubEnv("GITHUB_STEP_SUMMARY", summaryFile);
    try {
      expect(main(["--root", root, "--config", config(root)], { root })).toBe(0);
      const summary = JSON.parse(stdout.mock.calls.map(([text]) => String(text)).join(""));
      expect(summary).toMatchObject({ verdict: "PASS", selected: 1, passed: 1, failed: 0 });
      expect(readFileSync(summaryFile, "utf8")).toContain(JSON.stringify(summary, null, 2));
    } finally {
      stdout.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each(["--config", "--playwright-report"])("refuses escaping %s paths before execution", option => {
    const root = makeProject({}, []);
    const outside = makeProject({}, []);
    const file = path.join(outside, "vitest.config.mjs");
    for (const input of [file, path.relative(root, file), `${root}-sibling/report.json`, "", "bad\0path"]) {
      const result = invokeMain(root, [option, option === "--playwright-report" ? `tests=${input}` : input]);
      expect(result.status, input).toBe(2);
      expect(result.stderr).toContain("--config and --playwright-report must stay inside that root");
      expect(result.stdout).toBe("");
    }
  });

  it.each(["--config", "--playwright-report"])("refuses %s through a symlink outside the host root", option => {
    const root = makeProject({}, []);
    const outside = makeProject({}, []);
    const link = path.join(root, "linked");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const result = invokeMain(root, [option, option === "--playwright-report" ? "tests=linked/vitest.config.mjs" : "linked/vitest.config.mjs"]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
    } finally {
      unlinkSync(link);
    }
  });

  it("resolves relative reports under the host root and keeps missing reports as failures", () => {
    const root = makeProject({ "replay.fixture.js": "" }, [{ id: "replay", level: "browser", file: "replay.fixture.js", testName: "the replay" }]);
    writeFileSync(path.join(root, "report.json"), JSON.stringify({ errors: [], config: playwrightConfig(root), suites: [{
      specs: [{ title: "the replay", file: "replay.fixture.js", tests: [testExecution("chromium", "expected")] }],
    }] }));
    writeFileSync(path.join(root, "inventory.json"), JSON.stringify({ errors: [], stats: discoveryStats, config: playwrightConfig(root), suites: [{
      specs: [{ title: "the replay", file: "replay.fixture.js", tests: [discoveredTest("chromium")] }],
    }] }));
    const labels = Object.values(fixtureConfigNames);
    const copies = labelledCopies(JSON.parse(readFileSync(path.join(root, "report.json"), "utf8")), labels);
    const inventories = labelledCopies(JSON.parse(readFileSync(path.join(root, "inventory.json"), "utf8")), labels);
    for (const [index, label] of labels.entries()) writeFileSync(path.join(root, `${label}.json`), JSON.stringify(copies[index]));
    const good = withDiscovery(inventories, () => invokeMain(root, ["--tier", "full", ...labels.flatMap(label => ["--playwright-report", `${label}=${label}.json`])]));
    expect(good.status).toBe(0);
    expect(JSON.parse(good.stdout)).toMatchObject({ verdict: "PASS", selected: 1, passed: 1, issues: [] });
    const missing = invokeMain(root, ["--tier", "full", "--playwright-report", "tests=missing.json"]);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ verdict: "FAIL", issues: ["PLAYWRIGHT_REPORT_UNREADABLE"] });
  });

  it("the standalone CLI selects its module checkout independently of cwd", () => {
    const root = makeProject({ "ok.fixture.js": 'test("fine", () => {});\n' }, [{ id: "other", file: "ok.fixture.js", testName: "fine" }]);
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "prRunner.mjs");
    for (const args of [["--root", root], ["--config", config(root)]]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("host-selected root");
    }
  });
});

describe("PR diff base", () => {
  let root: string;
  let baseSha: string;
  let baseSideSha: string;
  let blobSha: string;
  const git = (args: string[]) => execFileSync(resolveTrustedGitExecutable(), args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "pr-runner-git-"));
    roots.push(root);
    git(["init", "--initial-branch=main"]);
    git(["-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "--allow-empty", "-m", "base"]);
    baseSha = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", baseSha]);
    writeFileSync(path.join(root, "changed.txt"), "head change\n");
    git(["add", "--", "changed.txt"]);
    git(["-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "head"]);
    blobSha = git(["hash-object", "-w", "changed.txt"]);
    git(["tag", "blob-base", blobSha]);
    git(["checkout", "-b", "base-side", baseSha]);
    writeFileSync(path.join(root, "base-only.txt"), "base branch change\n");
    git(["add", "--", "base-only.txt"]);
    git(["-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "base side"]);
    baseSideSha = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(["checkout", "main"]);
  });

  it.each(["--output=probe", "-c core.pager=sh", "../../etc", "origin/main\n", "origin/main\u0000", "HEAD~1"])("refuses a hostile base before git: %j", base => {
    expect(() => changedFilesSince(root, base)).toThrow("Invalid base: expected a full 40-character commit SHA");
  });

  it.each(["origin/main", "HEAD", "base-side", "missing-base", "blob-base"])("refuses explicit ref names: %s", base => {
    expect(() => changedFilesSince(root, base)).toThrow("Invalid base: expected a full 40-character commit SHA");
  });

  it.each(["a".repeat(39), "a".repeat(41), "g".repeat(40), `${"a".repeat(40)}\n`])("refuses a malformed SHA: %j", base => {
    expect(() => changedFilesSince(root, base)).toThrow("Invalid base: expected a full 40-character commit SHA");
  });

  it("accepts full SHAs and the omitted default, preserving merge-base selection", () => {
    expect(changedFilesSince(root, baseSha)).toEqual(["changed.txt"]);
    expect(changedFilesSince(root, baseSideSha)).toEqual(["changed.txt"]);
    expect(changedFilesSince(root, baseSha.toUpperCase())).toEqual(["changed.txt"]);
    expect(changedFilesSince(root)).toEqual(["changed.txt"]);
  });

  it("the CLI uses the host repository's diff to select an affected browser replay", () => {
    mkdirSync(path.join(root, "regression", "scenarios"), { recursive: true });
    writeFileSync(path.join(root, "regression", "scenarios", "browser.scenario.json"), JSON.stringify({
      id: "affected", status: "active", level: "browser", sourceGlobs: ["changed.txt"], impl: { file: "replay.spec.ts" },
    }));
    const result = invokeMain(root, ["--base", baseSha]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: "FAIL", selected: 1,
      failedIds: ["affected BROWSER_REPLAY_NOT_EXECUTED"], browser: { selected: 1 },
      issues: ["SELECTED_BROWSER_RECORDS_NEED_A_BROWSER_AND_BACKEND_SCRUM762:1"] });
  });

  it("refuses unknown and non-commit object SHAs", () => {
    for (const base of ["0".repeat(40), blobSha]) {
      expect(() => changedFilesSince(root, base)).toThrow("Invalid base: must resolve to an existing Git commit");
    }
  });
});

describe("PR scenario runner", () => {
  it("green control: a record bound to a passing test passes", () => {
    const root = makeProject(
      { "ok.fixture.js": 'test("the bound check", () => expect(1 + 1).toBe(2));\n' },
      [{ id: "green", file: "ok.fixture.js", testName: "the bound check" }],
    );
    const summary = runPrScenarios({ root, config: config(root) });
    expect(summary).toMatchObject({ verdict: "PASS", selected: 1, passed: 1, failed: 0, issues: [] });
  });

  it("fails every way a scenario can fail to run, never skipping it", () => {
    const root = makeProject(
      {
        "mixed.fixture.js": [
          'test("passes", () => expect(true).toBe(true));',
          'test.skip("is skipped", () => expect(true).toBe(true));',
          'test("fails", () => expect(1).toBe(2));',
          'test("twin", () => expect(true).toBe(true));',
          'describe("again", () => { test("twin", () => expect(true).toBe(true)); });',
          "",
        ].join("\n"),
      },
      [
        { id: "control", file: "mixed.fixture.js", testName: "passes" },
        { id: "renamed-test", file: "mixed.fixture.js", testName: "was renamed away" },
        { id: "skipped", file: "mixed.fixture.js", testName: "is skipped" },
        { id: "failing", file: "mixed.fixture.js", testName: "fails" },
        { id: "ambiguous", file: "mixed.fixture.js", testName: "twin" },
        { id: "deleted-file", file: "gone.fixture.js", testName: "passes" },
        { id: "no-binding" },
      ],
    );
    const summary = runPrScenarios({ root, config: config(root) });
    expect(summary.verdict).toBe("FAIL");
    expect(summary.selected).toBe(7);
    expect(summary.passed).toBe(1);
    expect(summary.failureCodes).toEqual({
      TEST_NOT_FOUND: 1, TEST_SKIPPED: 1, TEST_FAILED: 1, TEST_AMBIGUOUS: 1, BINDING_FILE_MISSING: 1, BINDING_MISSING: 1,
    });
    expect(summary.failedIds).toContain("renamed-test TEST_NOT_FOUND");
    expect(summary.failedIds).toContain("skipped TEST_SKIPPED");
  });

  it("a file that does not load fails its scenarios", () => {
    const root = makeProject(
      { "broken.fixture.js": 'throw new Error("boom");\n' },
      [{ id: "unloadable", file: "broken.fixture.js", testName: "anything" }],
    );
    const summary = runPrScenarios({ root, config: config(root) });
    expect(summary.verdict).toBe("FAIL");
    expect(summary.failureCodes).toEqual({ FILE_FAILED_TO_RUN: 1 });
  });

  it("the CLI exits non-zero and names the file-failed-to-run code when a bound file cannot load", () => {
    const root = makeProject(
      { "broken.fixture.js": 'throw new Error("boom-7342");\n', "ok.fixture.js": 'test("fine", () => {});\n' },
      [
        { id: "unloadable", file: "broken.fixture.js", testName: "anything" },
        { id: "healthy", file: "ok.fixture.js", testName: "fine" },
      ],
    );
    const child = invokeMain(root, ["--config", "vitest.config.mjs"]);
    expect(child.status).toBe(1);
    const summary = JSON.parse(child.stdout.slice(child.stdout.indexOf("{")));
    expect(summary).toMatchObject({ verdict: "FAIL", selected: 2, passed: 1, failed: 1 });
    expect(summary.failedIds).toEqual(["unloadable FILE_FAILED_TO_RUN"]);
    expect(summary.issues).toEqual(["VITEST_EXIT_1"]);
    expect(child.stdout).not.toContain("7342");
  });

  it("a green project exits zero from the CLI", () => {
    const root = makeProject({ "ok.fixture.js": 'test("fine", () => {});\n' }, [{ id: "healthy", file: "ok.fixture.js", testName: "fine" }]);
    expect(invokeMain(root, ["--config", "vitest.config.mjs"]).status).toBe(0);
  });
  it("emits counts and ids only: no test name, file path or error text", () => {
    const root = makeProject(
      { "leak.fixture.js": 'test("secret-title-4711", () => { throw new Error("secret-message-4711"); });\n' },
      [{ id: "leaky", file: "leak.fixture.js", testName: "secret-title-4711" }],
    );
    const text = JSON.stringify(runPrScenarios({ root, config: config(root) }));
    expect(text).not.toContain("4711");
    expect(text).not.toContain("leak.fixture.js");
  });

  it("an empty library fails (zero cases), and a missing report fails", () => {
    expect(summarise(selectForPr([]), [], [])).toMatchObject({ verdict: "FAIL", issues: ["ZERO_SCENARIOS_SELECTED"] });
    const root = makeProject({ "ok.fixture.js": 'test("a", () => {});\n' }, [{ id: "a", file: "ok.fixture.js", testName: "a" }]);
    const summary = runPrScenarios({ root, execute: () => ({ report: null, exitCode: 0 }) });
    expect(summary.verdict).toBe("FAIL");
    expect(summary.issues).toContain("VITEST_REPORT_MISSING");
    expect(summary.failureCodes).toEqual({ FILE_NOT_EXECUTED: 1 });
  });

  it("a green report with a non-zero Vitest exit still fails the run", () => {
    const root = makeProject({ "ok.fixture.js": 'test("a", () => {});\n' }, [{ id: "a", file: "ok.fixture.js", testName: "a" }]);
    const report = { testResults: [{ name: path.join(root, "ok.fixture.js"), status: "passed", assertionResults: [{ title: "a", status: "passed" }] }] };
    const summary = runPrScenarios({ root, execute: () => ({ report, exitCode: 1 }) });
    expect(summary).toMatchObject({ verdict: "FAIL", passed: 1, issues: ["VITEST_EXIT_1"] });
  });

  it("selection: cloud records fail, candidates and retired are not run, backend records run", () => {
    const selection = selectForPr([
      { id: "b", status: "active", level: "backend" }, { id: "c", status: "active", level: "cloud" },
      { id: "cand", status: "candidate", level: "backend" }, { id: "r", status: "retired", level: "backend" },
    ] as never, []);
    expect(selection.run.map((record: { id: string }) => record.id)).toEqual(["b"]);
    expect(selection).toMatchObject({ candidate: 1, retired: 1 });
    const summary = summarise(selection, [{ id: "b", code: "PASS" }], []);
    expect(summary.verdict).toBe("FAIL");
    expect(summary.issues).toEqual(["CLOUD_RECORDS_HAVE_NO_RUNNER:1"]);
    expect(summary.notRunHere).toEqual({ candidate: 1, retired: 1 });
  });

  describe("browser records at PR time", () => {
    let committedLibrary: ReturnType<typeof loadRecords>["records"];
    beforeAll(() => { committedLibrary = loadRecords(path.resolve(__dirname, "../..")).records; });
    it.each([
      ["expected", "PASS"],
      ["skipped", "FAIL"],
    ])("uses the actual selected replay result in PR mode (%s)", (status, verdict) => {
      const file = "role.fixture.js";
      const title = "the bound screen replay";
      const root = makeProject({ [file]: "" }, [
        { id: "role-screen", file, testName: title, level: "browser" },
      ]);
      const report = { errors: [], config: playwrightConfig(root, root, ["role-page-controls"]), suites: [{ specs: [
        { file, title, tests: [testExecution("role-page-controls", status)] },
      ] }] };
      const summary = runPrScenarios({
        root,
        changedFiles: ["components/fixture/Panel.tsx"],
        playwrightReports: labelledCopies(report, ["visual", "opening-visual"]),
        playwrightInventories: labelledCopies({ errors: [], stats: discoveryStats, config: playwrightConfig(root, root, ["role-page-controls"]), suites: [{ specs: [
          { file, title, tests: [discoveredTest("role-page-controls")] },
        ] }] }, ["visual", "opening-visual"]),
      });
      expect(summary.verdict).toBe(verdict);
      expect(summary.failureCodes).toEqual(status === "skipped" ? { TEST_SKIPPED: 1 } : {});
    });

    it.each([
      ["g8-owned-cash-delivery-screen", ["vehicles/page.tsx"]],
      ["g8-owned-financed-delivery-screen", ["applications/[id]/deal/page.tsx", "vehicles/page.tsx", "customers/page.tsx", "settings/finance/page.tsx", "accounting/page.tsx"]],
      ["g8-deals-list-to-detail", ["applications/[id]/deal/page.tsx", "settings/finance/page.tsx"]],
      ["g8-sourced-direct-financed-delivery-screen", ["applications/[id]/deal/page.tsx", "customers/page.tsx", "settings/finance/page.tsx"]],
      ["g8-sourced-financed-delivery-screen", ["applications/[id]/deal/page.tsx", "customers/page.tsx", "settings/finance/page.tsx"]],
    ])("delivery replay %s is selected for every route its fixtures visit", (id, routes) => {
      const record = committedLibrary.find(record => record.id === id);
      expect(record).toBeDefined();
      for (const route of routes) {
        const changed = `app/(dashboard)/[orgId]/${route}`;
        expect(selectForPr([record], [changed]).browserSelected.map((record: { id: string }) => record.id), changed).toEqual([id]);
      }
    });

    it.each([undefined, []])("an active browser record without a screen mapping cannot leave a passing backend green (%s)", sourceGlobs => {
      const selection = selectForPr([
        { id: "backend", status: "active", level: "backend" },
        { id: "unmapped", status: "active", level: "browser", sourceGlobs, impl: { file: "playwright/c.spec.ts" } },
      ], ["components/ChangedScreen.tsx"]);
      const summary = summarise(selection, [{ id: "backend", code: "PASS" }], []);
      expect(summary.verdict).toBe("FAIL");
      expect(summary.issues).toContain("BROWSER_SCREEN_MAPPING_MISSING:1");
    });

    const records = [
      { id: "mapped-touched", status: "active", level: "browser", sourceGlobs: ["components/cockpit/**"], impl: { file: "playwright/a.spec.ts" } },
      { id: "mapped-untouched", status: "active", level: "browser", sourceGlobs: ["components/other/**"], impl: { file: "playwright/b.spec.ts" } },
      { id: "unmapped", status: "active", level: "browser", impl: { file: "playwright/c.spec.ts" } },
      { id: "spec-edited", status: "active", level: "browser", sourceGlobs: ["components/spec-screen/**"], impl: { file: "playwright/d.spec.ts" } },
    ] as never;
    const ids = (list: Array<{ id: string }>) => list.map(record => record.id);

    it("selects by the PR diff: a touched screen or an edited spec; the rest are not required or unmapped", () => {
      const selection = selectForPr(records, ["components/cockpit/Panel.tsx", "playwright/d.spec.ts"]);
      expect(ids(selection.browserSelected)).toEqual(["mapped-touched", "spec-edited"]);
      expect(ids(selection.browserNotRequired)).toEqual(["mapped-untouched"]);
      expect(ids(selection.browserUnmapped)).toEqual(["unmapped"]);
    });

    it("a selected browser record that cannot run FAILS the run and says why", () => {
      const selection = selectForPr(records, ["components/cockpit/Panel.tsx"]);
      const summary = summarise(selection, [{ id: "b", code: "PASS" }], []);
      expect(summary.verdict).toBe("FAIL");
      expect(summary.failureCodes).toEqual({ BROWSER_REPLAY_NOT_EXECUTED: 1 });
      expect(summary.failedIds).toEqual(["mapped-touched BROWSER_REPLAY_NOT_EXECUTED"]);
      expect(summary.issues).toEqual(["BROWSER_SCREEN_MAPPING_MISSING:1", "SELECTED_BROWSER_RECORDS_NEED_A_BROWSER_AND_BACKEND_SCRUM762:1"]);
      expect(summary.browser).toEqual({ selected: 1, notRequiredAtPrTime: 2, unmappedToAScreen: 1 });
    });

    it("a PR that touches no mapped screen still fails on missing mappings", () => {
      const summary = summarise(selectForPr(records, ["README.md"]), [{ id: "b", code: "PASS" }], []);
      expect(summary).toMatchObject({ verdict: "FAIL", failed: 0, browser: { selected: 0, notRequiredAtPrTime: 3, unmappedToAScreen: 1 }, issues: ["BROWSER_SCREEN_MAPPING_MISSING:1"] });
      const mappedOnly = [{ id: "mapped", status: "active", level: "browser", sourceGlobs: ["components/other/**"] }];
      expect(summarise(selectForPr(mappedOnly, ["README.md"]), [{ id: "b", code: "PASS" }], []).verdict).toBe("PASS");
    });

    it("an unknown PR diff fails: mapped browser records are selected and unmapped records fail validation", () => {
      const summary = summarise(selectForPr(records, null), [{ id: "b", code: "PASS" }], []);
      expect(summary.verdict).toBe("FAIL");
      expect(summary.issues).toContain("PR_DIFF_UNAVAILABLE");
      expect(summary.browser).toMatchObject({ selected: 3, unmappedToAScreen: 1 });
    });
  });
  it("evaluate matches by the exact file, not by a similarly named one", () => {
    const root = makeProject({ "a.fixture.js": "", "ab.fixture.js": "" }, []);
    const report = { testResults: [{ name: path.join(root, "ab.fixture.js"), status: "passed", assertionResults: [{ title: "t", status: "passed" }] }] };
    const verdicts = evaluate([{ id: "x", impl: { file: "a.fixture.js", testName: "t" } }], report, root);
    expect(verdicts).toEqual([{ id: "x", code: "FILE_NOT_EXECUTED" }]);
  });
});

// SCRUM-761 R3: the full tier (nightly, release). Every active record is required; browser records are judged from
// Playwright JSON reports shaped as documented at https://playwright.dev/docs/test-reporters#json-reporter.
describe("full tier", () => {
  const root = path.resolve("/repo");
  const browserRecord = (id: string, file = "playwright/tests/a.spec.ts", testName = "the replay") =>
    ({ id, status: "active", level: "browser", sourceGlobs: ["components/fixture/**"], impl: { file, testName } });
  const report = (specs: Array<{ title: string; file?: string; status: string; project?: string }>) => ({
    errors: [],
    config: playwrightConfig(root, path.join(root, "playwright", "tests")),
    suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [], suites: [{ title: "group", file: "a.spec.ts", specs: specs.map(spec => ({
      title: spec.title, file: spec.file ?? "a.spec.ts", tests: [testExecution(spec.project ?? "chromium", spec.status)],
    })) }] }],
  });
  // evaluatePlaywright checks the bound file exists on disk, so these tests point it at a real temp project.
  function withFiles(...names: string[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), "pr-runner-browser-"));
    roots.push(dir);
    for (const name of names) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), "");
    }
    return dir;
  }
  const reportFor = (dir: string, specs: Parameters<typeof report>[0], projects = [...new Set(specs.map(spec => spec.project ?? "chromium"))]) => {
    const base = report(specs);
    base.config = playwrightConfig(dir, path.join(dir, "playwright", "tests"), projects);
    return base;
  };
  const inventoryFor = (dir: string, projects = ["chromium"], file = "a.spec.ts", title = "the replay") => ({
    errors: [], stats: discoveryStats, config: playwrightConfig(dir, path.join(dir, "playwright", "tests"), projects),
    suites: [{ title: "a.spec.ts", specs: [], suites: [{ title: "group", specs: [{ file, title, tests: projects.map(discoveredTest) }] }] }],
  });

  it("SCRUM-761b refuses one passing project when two projects collect the replay", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const inventory = inventoryFor(dir, ["chromium", "webkit"]);
    const partial = reportFor(dir, [{ title: "the replay", status: "expected", project: "chromium" }], ["chromium", "webkit"]);
    expect(evaluatePlaywright([browserRecord("r")] as never, [partial], dir, [inventory]))
      .toEqual([{ id: "r", code: "TEST_PROJECT_NOT_EXECUTED" }]);
  });

  it("SCRUM-761b a passing project that does not collect the replay cannot count", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const wrongProject = reportFor(dir, [{ title: "the replay", status: "expected", project: "firefox" }], ["chromium", "webkit"]);
    expect(evaluatePlaywright([browserRecord("r")] as never, [wrongProject], dir,
      [inventoryFor(dir, ["chromium", "webkit"])])).toEqual([{ id: "r", code: "TEST_PROJECT_NOT_COLLECTED" }]);
  });

  it("SCRUM-761b two collecting projects both passing satisfy the replay", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const both = reportFor(dir, [
      { title: "the replay", status: "expected", project: "chromium" },
      { title: "the replay", status: "expected", project: "webkit" },
    ]);
    expect(evaluatePlaywright([browserRecord("r")] as never, [both], dir,
      [inventoryFor(dir, ["chromium", "webkit"])])).toEqual([{ id: "r", code: "PASS" }]);
  });

  it("SCRUM-761b the same collecting project twice remains a duplicate", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const one = reportFor(dir, [{ title: "the replay", status: "expected" }]);
    expect(evaluatePlaywright([browserRecord("r")] as never, [one, one], dir,
      [inventoryFor(dir)])).toEqual([{ id: "r", code: "TEST_EXECUTION_DUPLICATE" }]);
  });

  it("SCRUM-761b zero collecting projects for the bound test fail", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const inventory = inventoryFor(dir);
    inventory.suites[0].suites[0].specs.push({ file: "a.spec.ts", title: "uncollected replay", tests: [] });
    const one = reportFor(dir, [{ title: "uncollected replay", status: "expected" }]);
    expect(evaluatePlaywright([browserRecord("r", undefined, "uncollected replay")] as never, [one], dir,
      [inventory])).toEqual([{ id: "r", code: "TEST_NOT_COLLECTED" }]);
  });

  it.each([
    ["empty", "PLAYWRIGHT_INVENTORY_EMPTY"],
    ["list error", "PLAYWRIGHT_INVENTORY_INVALID"],
  ])("refuses %s judge discovery", (shape, code) => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const inventory = inventoryFor(dir);
    const broken = shape === "empty" ? { ...inventory, suites: [] }
      : { ...inventory, errors: [{ message: "collection failed" }] };
    expect(evaluatePlaywright([browserRecord("r")], [reportFor(dir, [{ title: "the replay", status: "expected" }])], dir, [broken]))
      .toEqual([{ id: "r", code }]);
  });

  it("the CLI joins judge discovery and fails a partial report", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    mkdirSync(path.join(dir, "regression", "scenarios"), { recursive: true });
    writeFileSync(path.join(dir, "regression", "scenarios", "r.scenario.json"), JSON.stringify(browserRecord("r")));
    writeFileSync(path.join(dir, "inventory.json"), JSON.stringify(inventoryFor(dir, ["chromium", "webkit"])));
    writeFileSync(path.join(dir, "report.json"), JSON.stringify(reportFor(dir, [{ title: "the replay", status: "expected" }], ["chromium", "webkit"])));
    const partial = withDiscovery([inventoryFor(dir, ["chromium", "webkit"])], () => invokeMain(dir, ["--tier", "full", "--playwright-report", "tests=report.json"]));
    expect(partial.status).toBe(1);
    expect(JSON.parse(partial.stdout)).toMatchObject({ verdict: "FAIL", failedIds: ["r TEST_PROJECT_NOT_EXECUTED"] });
    writeFileSync(path.join(dir, "webkit.json"), JSON.stringify(reportFor(dir, [{ title: "the replay", status: "expected", project: "webkit" }], ["chromium", "webkit"])));
    const labels = ["visual", "opening-visual", "scenarios", "opening-proof"];
    const siblings = labelledCopies(reportFor(dir, [{ title: "the replay", status: "expected" }, { title: "the replay", status: "expected", project: "webkit" }]), labels);
    for (const [index, label] of labels.entries()) writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(siblings[index]));
    const inventories = labelledCopies(inventoryFor(dir, ["chromium", "webkit"]), ["tests", ...labels]);
    const complete = withDiscovery(inventories, () => invokeMain(dir, ["--tier", "full", "--playwright-report", "tests=report.json", "--playwright-report", "tests=webkit.json", ...labels.flatMap(label => ["--playwright-report", `${label}=${label}.json`])]));
    expect(complete.status).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({ verdict: "PASS", passed: 1 });
  });

  it("selects every active browser record, mapped or not, and every active backend record", () => {
    const selection = selectFull([
      browserRecord("mapped"), { ...browserRecord("unmapped"), sourceGlobs: [] },
      { id: "b", status: "active", level: "backend" }, { id: "r", status: "retired", level: "browser" },
    ] as never);
    expect(selection.browserSelected.map((record: { id: string }) => record.id)).toEqual(["mapped", "unmapped"]);
    expect(selection.run.map((record: { id: string }) => record.id)).toEqual(["b"]);
    expect(selection).toMatchObject({ browserNotRequired: [], browserUnmapped: [{ id: "unmapped" }], retired: 1 });
    expect(summarise(selection, [{ id: "b", code: "PASS" }], [], [{ id: "mapped", code: "PASS" }, { id: "unmapped", code: "PASS" }], "full").issues).toContain("BROWSER_SCREEN_MAPPING_MISSING:1");
  });

  it("trusted producer replay evidence uses only an executed case from the same independently collected config and project", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const record = browserRecord("owned-cash");
    const report = reportFor(dir, [{ title: "the replay", status: "expected" }]);
    const discovery = inventoryFor(dir);

    expect(evaluateTrustedBrowserReplay(record, report, discovery, dir)).toEqual({ id: "owned-cash", code: "PASS" });
    expect(evaluateTrustedBrowserReplay(record, report, undefined, dir).code).toBe("PLAYWRIGHT_INVENTORY_INVALID");
    const malformed = { ...discovery, config: { ...discovery.config, projects: [{ id: "", name: "chromium" }] } };
    expect(evaluateTrustedBrowserReplay(record, report, malformed, dir).code).toBe("PLAYWRIGHT_INVENTORY_INVALID");
    expect(evaluateTrustedBrowserReplay(record, report, { ...discovery, suites: [] }, dir).code).toBe("PLAYWRIGHT_INVENTORY_EMPTY");
    const secondProject = inventoryFor(dir, ["chromium", "webkit"]);
    const partial = reportFor(dir, [{ title: "the replay", status: "expected" }], ["chromium", "webkit"]);
    expect(evaluateTrustedBrowserReplay(record, partial, secondProject, dir).code).toBe("TEST_PROJECT_NOT_EXECUTED");

    const flaky = reportFor(dir, [{ title: "the replay", status: "flaky" }]);
    expect(evaluateTrustedBrowserReplay(record, flaky, discovery, dir).code).toBe("TEST_FLAKY");
    const listedOnly = reportFor(dir, [], ["chromium"]);
    expect(evaluateTrustedBrowserReplay(record, listedOnly, discovery, dir).code).toBe("BROWSER_REPLAY_NOT_EXECUTED");
  });

  it("rejects a failed test even when Playwright expected it to fail", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const expectedFailure = testExecution("chromium", "expected", "failed", ["failed"]);
    const report = reportFor(dir, [{ title: "the replay", status: "expected" }]);
    Object.assign(report.suites[0].suites[0].specs[0].tests[0], expectedFailure);
    expect(evaluatePlaywright([browserRecord("r")] as never, [report], dir, [inventoryFor(dir)])[0].code).toBe("TEST_FAILED");
  });

  it("rejects a duplicated execution in one project and accepts distinct projects", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const chromium = reportFor(dir, [{ title: "the replay", status: "expected" }], ["chromium", "webkit"]);
    const webkit = reportFor(dir, [{ title: "the replay", status: "expected", project: "webkit" }], ["chromium", "webkit"]);
    const record = [browserRecord("r")] as never;
    expect(evaluatePlaywright(record, [chromium, chromium], dir)[0].code).toBe("TEST_EXECUTION_DUPLICATE");
    expect(evaluatePlaywright(record, [chromium, webkit], dir, [inventoryFor(dir, ["chromium", "webkit"])])[0].code).toBe("PASS");
  });

  it("green control: a browser record whose bound title ran as expected passes", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    expect(evaluatePlaywright([browserRecord("ok")] as never, [reportFor(dir, [{ title: "the replay", status: "expected" }])], dir, [inventoryFor(dir)])).toEqual([{ id: "ok", code: "PASS" }]);
  });

  it("fails every way a browser replay can fail to run, never skipping it", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const verdict = (status: string | null) => evaluatePlaywright([browserRecord("r")] as never,
      status === null ? [] : [reportFor(dir, [{ title: "the replay", status }])], dir)[0].code;
    expect(verdict(null)).toBe("BROWSER_REPLAY_NOT_EXECUTED");
    expect(verdict("skipped")).toBe("TEST_SKIPPED");
    expect(verdict("unexpected")).toBe("TEST_FAILED");
    expect(verdict("flaky")).toBe("TEST_FLAKY");
    // renamed title, another spec file, missing file, no binding
    expect(evaluatePlaywright([browserRecord("r", "playwright/tests/a.spec.ts", "was renamed")] as never, [reportFor(dir, [{ title: "the replay", status: "expected" }])], dir)[0].code).toBe("BROWSER_REPLAY_NOT_EXECUTED");
    expect(evaluatePlaywright([browserRecord("r", "playwright/tests/b.spec.ts")] as never, [reportFor(dir, [{ title: "the replay", status: "expected" }])], dir)[0].code).toBe("BINDING_FILE_MISSING");
    expect(evaluatePlaywright([{ id: "r", status: "active", level: "browser" }] as never, [], dir)[0].code).toBe("BINDING_MISSING");
  });

  it("a record bound to the role matrix fails under its own code, not as a generic miss, and passes if a report ran it", () => {
    const dir = withFiles("playwright/tests/audit-role-access.spec.ts");
    const record = browserRecord("role", "playwright/tests/audit-role-access.spec.ts");
    expect(evaluatePlaywright([record] as never, [], dir)[0].code).toBe("ROLE_AUDIT_EVIDENCE_NOT_JOINED");
    expect(evaluatePlaywright([record] as never, [reportFor(dir, [{ title: "the replay", status: "expected", file: "audit-role-access.spec.ts" }])], dir, [inventoryFor(dir, ["chromium"], "audit-role-access.spec.ts")])[0].code).toBe("PASS");
  });

  it("one failing execution among several projects fails the record", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const both = reportFor(dir, [{ title: "the replay", status: "expected" }, { title: "the replay", status: "unexpected", project: "webkit" }]);
    expect(evaluatePlaywright([browserRecord("r")] as never, [both], dir)[0].code).toBe("TEST_FAILED");
  });

  it("a spec with the same name in another directory does not satisfy the record", () => {
    const dir = withFiles("playwright/tests/a.spec.ts", "playwright/scenarios/a.spec.ts");
    const other = reportFor(dir, [{ title: "the replay", status: "expected" }]);
    other.config.rootDir = path.join(dir, "playwright", "scenarios");
    other.config.projects[0].testDir = path.join(dir, "playwright", "scenarios");
    expect(evaluatePlaywright([browserRecord("r")] as never, [other], dir)[0].code).toBe("BROWSER_REPLAY_NOT_EXECUTED");
  });


  it("a nested project testDir cannot credit a same-title file that did not run", () => {
    const dir = withFiles("tests/a.spec.ts", "tests/tests/a.spec.ts");
    const nested = {
      errors: [], config: { ...playwrightConfig(dir), projects: playwrightConfig(dir, path.join(dir, "tests")).projects },
      suites: [{ specs: [{ file: "tests/a.spec.ts", title: "the replay", tests: [testExecution("chromium", "expected")] }] }],
    };
    expect(evaluatePlaywright([
      browserRecord("executed", "tests/a.spec.ts"), browserRecord("never-ran", "tests/tests/a.spec.ts"),
    ], [nested], dir, [{ errors: [], stats: discoveryStats, config: nested.config, suites: [{ specs: [
      { file: "tests/a.spec.ts", title: "the replay", tests: [discoveredTest("chromium")] },
    ] }] }])).toEqual([
      { id: "executed", code: "PASS" }, { id: "never-ran", code: "BROWSER_REPLAY_NOT_EXECUTED" },
    ]);
  });

  it("the full tier fails on an unexecuted browser record, a parked candidate and an unreadable report", () => {
    const records = [browserRecord("replay"), { id: "cand", status: "candidate", level: "backend" }];
    const selection = selectFull(records as never);
    const summary = summarise(selection, [{ id: "b", code: "PASS" }], ["PLAYWRIGHT_REPORT_UNREADABLE"], [{ id: "replay", code: "BROWSER_REPLAY_NOT_EXECUTED" }], "full");
    expect(summary).toMatchObject({ tier: "full", verdict: "FAIL", failureCodes: { BROWSER_REPLAY_NOT_EXECUTED: 1 } });
    expect(summary.issues).toEqual(["PLAYWRIGHT_REPORT_UNREADABLE", "CANDIDATE_RECORDS_ARE_NOT_EXECUTED:1"]);
    expect(summary.browser.selected).toBe(1);
  });

  it("a verified protected replay fills only missing browser execution and still requires both static reports", () => {
    const dir = withFiles("playwright/tests/a.spec.ts", "playwright/tests/audit-role-access.spec.ts");
    mkdirSync(path.join(dir, "regression", "scenarios"), { recursive: true });
    const records = [
      browserRecord("trusted", "playwright/tests/a.spec.ts", "protected replay"),
      browserRecord("failed"),
      browserRecord("role", "playwright/tests/audit-role-access.spec.ts"),
    ];
    for (const record of records) {
      writeFileSync(path.join(dir, "regression", "scenarios", `${record.id}.scenario.json`), JSON.stringify(record));
    }
    const labels = ["visual", "opening-visual"];
    const [visual] = labelledCopies(reportFor(dir, [{ title: "the replay", status: "unexpected" }]), ["visual"]);
    const [openingVisual] = labelledCopies(reportFor(dir, [], ["chromium"]), ["opening-visual"]);
    const discovery = labelledCopies(inventoryFor(dir), labels);
    const run = (playwrightReports: object[], exactRole = false) => runPrScenarios({
      root: dir, changedFiles: ["components/fixture/screen.ts"], playwrightReports, playwrightInventories: discovery,
      resolveBrowserReplays: () => records.map(({ id }) => ({ id, code: "PASS", ...(exactRole && id === "role" ? { evidence: "role-audit" } : {}) })),
    });

    expect(run([visual, openingVisual])).toMatchObject({ verdict: "FAIL", passed: 1,
      failedIds: ["failed TEST_FAILED", "role ROLE_AUDIT_EVIDENCE_NOT_JOINED"] });
    expect(run([visual, openingVisual], true)).toMatchObject({ verdict: "FAIL", passed: 2, failedIds: ["failed TEST_FAILED"] });
    expect(run([visual])).toMatchObject({ verdict: "FAIL", passed: 0,
      failedIds: ["failed TEST_FAILED", "role ROLE_AUDIT_EVIDENCE_NOT_JOINED", "trusted PLAYWRIGHT_REQUIRED_REPORT_MISSING"] });
  });

  it.each([
    ["report error", "PLAYWRIGHT_REPORT_INVALID"],
    ["unsafe options", "PLAYWRIGHT_EXECUTION_UNSAFE"],
    ["config mismatch", "PLAYWRIGHT_CONFIG_MISMATCH"],
  ] as const)("protected replay cannot hide a required visual report with %s", (kind, code) => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    mkdirSync(path.join(dir, "regression", "scenarios"), { recursive: true });
    const record = browserRecord("protected", "playwright/tests/a.spec.ts", "protected replay");
    writeFileSync(path.join(dir, "regression", "scenarios", "protected.scenario.json"), JSON.stringify(record));
    const [visual] = labelledCopies(reportFor(dir, [], ["chromium"]), ["visual"]);
    const [openingVisual] = labelledCopies(reportFor(dir, [], ["chromium"]), ["opening-visual"]);
    const discovery = labelledCopies(inventoryFor(dir), ["visual", "opening-visual"]);
    const resolveBrowserReplays = vi.fn(() => [{ id: record.id, code: "PASS" }]);
    const run = (visualReport: object) => runPrScenarios({
      root: dir, changedFiles: ["components/fixture/screen.ts"], playwrightReports: [visualReport, openingVisual],
      playwrightInventories: discovery, resolveBrowserReplays,
    });
    expect(run(visual).verdict).toBe("PASS");
    expect(resolveBrowserReplays).toHaveBeenCalledOnce();
    resolveBrowserReplays.mockClear();
    const invalid = kind === "report error"
      ? { ...visual, errors: [{ message: "Visual setup failed" }] }
      : kind === "unsafe options"
        ? { ...visual, config: { ...visual.config, argv: [...visual.config.argv, "--ignore-snapshots"] } }
        : { ...visual, config: { ...visual.config, projects: [] } };
    expect(run(invalid)).toMatchObject({
      verdict: "FAIL",
      issues: [code],
    });
    expect(resolveBrowserReplays).not.toHaveBeenCalled();
  });

  it("an all-green full tier passes and does not report the PR-tier browser issue", () => {
    const selection = selectFull([browserRecord("replay")] as never);
    expect(summarise(selection, [], [], [{ id: "replay", code: "PASS" }], "full")).toMatchObject({ tier: "full", verdict: "PASS", issues: [] });
  });

  it("readPlaywrightReports flags a missing file and a file that is not a report", () => {
    const dir = withFiles();
    writeFileSync(path.join(dir, "not-a-report.json"), "{}");
    writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ suites: [] }));
    const result = readPlaywrightReports([path.join(dir, "missing.json"), path.join(dir, "not-a-report.json"), path.join(dir, "ok.json")]);
    expect(result.problems).toEqual(["PLAYWRIGHT_REPORT_UNREADABLE", "PLAYWRIGHT_REPORT_INVALID"]);
    expect(result.reports).toHaveLength(1);
  });

  it("the CLI full tier exits non-zero without reports and rejects an unknown tier", () => {
    const dir = withFiles();
    mkdirSync(path.join(dir, "regression", "scenarios"), { recursive: true });
    writeFileSync(path.join(dir, "regression", "scenarios", "x.scenario.json"), JSON.stringify(browserRecord("replay")));
    const full = invokeMain(dir, ["--tier", "full"]);
    expect(full.status).toBe(1);
    expect(JSON.parse(full.stdout.slice(full.stdout.indexOf("{")))).toMatchObject({ tier: "full", verdict: "FAIL", failedIds: ["replay BINDING_FILE_MISSING"] });
    expect(invokeMain(dir, ["--tier", "nightly"]).status).toBe(2);
  });
});


describe("SCRUM-761d judge-owned native discovery", () => {
  let root: string;
  let complete: ReturnType<typeof nativeRun>;
  let aliasComplete: ReturnType<typeof nativeRun>;
  let aliasPartial: ReturnType<typeof nativeRun>;
  const siblingLabels = ["opening-visual", "scenarios", "opening-proof"];
  const siblingConfig = "module.exports={testDir:'physical',projects:[{name:'chromium'}]};";
  const cliArgs = ["--tier", "full", "--playwright-report", "tests=complete.json", "--playwright-report", "visual=alias.json",
    ...siblingLabels.flatMap(label => ["--playwright-report", `${label}=${label}.json`])];
  let cliComplete: ReturnType<typeof invokeMain>;
  let cliPartial: ReturnType<typeof invokeMain>;
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  const records = [{ id: "alias", impl: { file: "physical/replay.spec.cjs", testName: "replay" } }];
  function nativeRun(config: string, extra: string[] = []) {
    const output = path.join(root, "native-output.json");
    const result = spawnSync(process.execPath, [cli, "test", "-c", config, "--workers=1", "--reporter=json", ...extra], {
      cwd: root, encoding: "utf8", timeout: 15000, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: output },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(output, "utf8")) as {
      config: { argv: string[]; configFile: string; rootDir: string; updateSnapshots: string };
      errors: object[];
      suites: { title: string; specs: { title: string; file: string; tests: { projectId: string; status: string; expectedStatus: string; results: { status: string; retry: number }[] }[] }[] }[];
    };
  }
  beforeAll(() => {
    root = makeProject({}, []);
    mkdirSync(path.join(root, "physical"));
    symlinkSync(path.join(root, "physical"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const testImport = JSON.stringify(require.resolve("@playwright/test"));
    writeFileSync(path.join(root, "physical/replay.spec.cjs"), `const {test}=require(${testImport}); test('replay',()=>{}); test('other',()=>{});`);
    writeFileSync(path.join(root, "playwright.config.ts"), "module.exports={testDir:'physical',projects:[{name:'chromium'}]};");
    writeFileSync(path.join(root, "playwright.visual.config.ts"), "module.exports={testDir:'alias',projects:[{name:'chromium'}]};");
    complete = nativeRun("playwright.config.ts");
    aliasComplete = nativeRun("playwright.visual.config.ts");
    aliasPartial = nativeRun("playwright.visual.config.ts", ["--grep=other"]);
  // Three worker-spawning native runs are shared by this group; no browser or server is started.
  }, 20000);
  for (const label of siblingLabels) {
    beforeAll(() => {
      const file = Object.keys(fixtureConfigNames).find(file => fixtureConfigNames[file] === label)!;
      writeFileSync(path.join(root, file), siblingConfig);
      writeFileSync(path.join(root, `${label}.json`), JSON.stringify(nativeRun(file)));
    });
  }
  beforeAll(() => {
    mkdirSync(path.join(root, "regression/scenarios"), { recursive: true });
    writeFileSync(path.join(root, "regression/scenarios/alias.scenario.json"), JSON.stringify({ ...records[0], status: "active", level: "browser", sourceGlobs: ["components/**"] }));
    writeFileSync(path.join(root, "complete.json"), JSON.stringify(complete));
    writeFileSync(path.join(root, "alias.json"), JSON.stringify(aliasComplete));
    cliComplete = invokeMain(root, cliArgs);
  });
  beforeAll(() => {
    writeFileSync(path.join(root, "alias.json"), JSON.stringify(aliasPartial));
    try { cliPartial = invokeMain(root, cliArgs); }
    finally { writeFileSync(path.join(root, "alias.json"), JSON.stringify(aliasComplete)); }
  });
  afterAll(() => { if (root) unlinkSync(path.join(root, "alias")); });

  it("F1 complete untouched native reports through a junction pass", () => {
    expect(evaluatePlaywright(records, [complete, aliasComplete], root)).toEqual([{ id: "alias", code: "PASS" }]);
  });
  it("matches static executions to real discovery for the same config", () => {
    expect(staticExecutionCensus(root, { configName: "visual", report: aliasComplete })).toHaveLength(2);
    expect(() => staticExecutionCensus(root, { configName: "visual", report: aliasPartial }))
      .toThrow("PLAYWRIGHT_STATIC_CENSUS_MISMATCH");
  });
  it("F1 a filtered aliased execution cannot borrow the physical config's pass", () => {
    expect(evaluatePlaywright(records, [complete, aliasPartial], root)).toEqual([{ id: "alias", code: "TEST_PROJECT_NOT_EXECUTED" }]);
    const sanitized = structuredClone(aliasPartial);
    sanitized.config.argv = sanitized.config.argv.filter(arg => arg !== "--grep=other");
    expect(evaluatePlaywright(records, [complete, sanitized], root)).toEqual([{ id: "alias", code: "TEST_PROJECT_NOT_EXECUTED" }]);
  // Both original and edited argv are checked against fresh native listings of two configs.
  }, 10000);
  it("F1 sanitized supplied discovery is impossible to submit through the CLI", () => {
    writeFileSync(path.join(root, "run.json"), JSON.stringify(complete));
    writeFileSync(path.join(root, "sanitized.json"), JSON.stringify(complete));
    expect(invokeMain(root, ["--tier", "full", "--playwright-report", "tests=run.json", "--playwright-inventory", "sanitized.json"]).status).toBe(2);
  });
  it("project-level grep uses native collection rather than file eligibility", () => {
    writeFileSync(path.join(root, "playwright.scenarios.config.ts"), "module.exports={testDir:'physical',projects:[{name:'chromium'},{name:'webkit',grep:/other/}]};");
    const run = nativeRun("playwright.scenarios.config.ts");
    expect(evaluatePlaywright(records, [run], root)).toEqual([{ id: "alias", code: "PASS" }]);
  // This test performs both a native execution and a fresh discovery subprocess.
  }, 10000);
  it("a config that cannot list refuses under PLAYWRIGHT_DISCOVERY_FAILED", () => {
    writeFileSync(path.join(root, "playwright.opening-proof.config.ts"), "throw new Error('cannot collect');");
    const run = structuredClone(complete);
    run.config.configFile = path.join(root, "playwright.opening-proof.config.ts");
    expect(evaluatePlaywright(records, [run], root)).toEqual([{ id: "alias", code: "PLAYWRIGHT_DISCOVERY_FAILED" }]);
  });
  it("F2 two passed retry-zero results still refuse exact cardinality", () => {
    const run = structuredClone(complete);
    run.suites[0].specs[0].tests[0].results.push({ status: "passed", retry: 0 });
    expect(evaluatePlaywright(records, [run], root)).toEqual([{ id: "alias", code: "TEST_EXECUTION_UNVERIFIED" }]);
  });
  it.each(["--update-snapshots=all", "--ignore-snapshots", "--pass-with-no-tests"])("L1 native execution %s cannot certify assertions", flag => {
    const run = nativeRun("playwright.config.ts", [flag]);
    expect(evaluatePlaywright(records, [run], root)).toEqual([{ id: "alias", code: "PLAYWRIGHT_EXECUTION_UNSAFE" }]);
  // Native worker startup plus fresh discovery must fit on slower CI runners too.
  }, 10000);

  it("inherited JSON output settings cannot overwrite execution evidence", () => {
    const output = path.join(root, "must-not-change.json");
    writeFileSync(output, "sentinel");
    vi.stubEnv("PLAYWRIGHT_JSON_OUTPUT_NAME", output);
    vi.stubEnv("PLAYWRIGHT_JSON_OUTPUT_FILE", output);
    vi.stubEnv("PLAYWRIGHT_JSON_OUTPUT_DIR", root);
    try {
      expect(evaluatePlaywright(records, [complete], root)).toEqual([{ id: "alias", code: "PASS" }]);
      expect(readFileSync(output, "utf8")).toBe("sentinel");
    } finally { vi.unstubAllEnvs(); }
  });

  it("the repository's scenarios environment is used during discovery", () => {
    writeFileSync(path.join(root, "playwright.scenarios.config.ts"), "module.exports={testDir:'physical',projects:[{name:'chromium'},{name:'webkit',grep:process.env.CROSS_SCREEN_ORACLE==='1'?/.*/:/other/}]};");
    vi.stubEnv("CROSS_SCREEN_ORACLE", "1");
    let run: ReturnType<typeof nativeRun>;
    try { run = nativeRun("playwright.scenarios.config.ts"); } finally { vi.unstubAllEnvs(); }
    run.suites[0].specs[0].tests.pop();
    expect(evaluatePlaywright(records, [run], root)).toEqual([{ id: "alias", code: "TEST_PROJECT_NOT_EXECUTED" }]);
  // Native execution followed by listing is one integration scenario.
  }, 10000);

  it("native full title paths cannot borrow a same-leaf pass from another group", () => {
    const run = structuredClone(complete);
    run.suites[0].title = "different suite";
    expect(evaluatePlaywright(records, [run], root)).toEqual([{ id: "alias", code: "TEST_PROJECT_NOT_COLLECTED" }]);
  });

  it("the CLI itself passes native evidence without any supplied inventory", () => {
    const result = cliComplete;
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: "PASS", passed: 1, issues: [] });
    const partial = cliPartial;
    expect(partial.status).toBe(1);
    expect(JSON.parse(partial.stdout).failedIds).toEqual(["alias TEST_PROJECT_NOT_EXECUTED"]);
  // Each native CLI fixture discovers all five required configs in its own setup hook.
  });
});

describe("SCRUM-761d subprocess and execution evidence boundaries", () => {
  function evidence() {
    const root = makeProject({ "replay.spec.ts": "" }, []);
    const config = playwrightConfig(root);
    const inventory = { config, errors: [] as object[], suites: [{ title: "file", specs: [{ file: "replay.spec.ts", title: "replay", tests: [discoveredTest("chromium")] }] }] };
    const report = { config: structuredClone(config), errors: [] as object[], suites: [{ title: "file", specs: [{ file: "replay.spec.ts", title: "replay", tests: [testExecution("chromium", "expected")] }] }] };
    const records = [{ id: "r", impl: { file: "replay.spec.ts", testName: "replay" } }];
    return { root, inventory, report, records };
  }

  it.each(["missing", "duplicate", "skipped"])("refuses %s executions in the single-config static census", kind => {
    const { root, inventory, report } = evidence();
    inventory.config.configFile = report.config.configFile = path.join(root, "playwright.visual.config.ts");
    const tests = report.suites[0].specs[0].tests;
    if (kind === "missing") tests.pop();
    if (kind === "duplicate") tests.push(structuredClone(tests[0]));
    if (kind === "skipped") tests[0].status = "skipped";
    const census = () => withDiscovery([inventory], () => staticExecutionCensus(root, { configName: "visual", report }));
    expect(census).toThrow("PLAYWRIGHT_STATIC_CENSUS_MISMATCH");
  });

  it("refuses duplicate Vitest results for one selected binding", () => {
    const { root, records } = evidence();
    const file = { name: path.join(root, "replay.spec.ts"), assertionResults: [{ title: "replay", status: "passed" }] };
    expect(evaluate(records, { testResults: [file, structuredClone(file)] }, root))
      .toEqual([{ id: "r", code: "FILE_EXECUTION_AMBIGUOUS" }]);
  });

  it.each(["errors", "missing errors", "suite child string", "spec string", "missing tests"])("malformed execution %s retains PLAYWRIGHT_REPORT_INVALID", kind => {
    const { root, inventory, report, records } = evidence();
    if (kind === "errors") report.errors.push({ message: "private error" });
    if (kind === "missing errors") Reflect.deleteProperty(report, "errors");
    if (kind === "suite child string") Reflect.set(report.suites[0], "suites", "ignored");
    if (kind === "spec string") Reflect.set(report.suites[0], "specs", "ignored");
    if (kind === "missing tests") Reflect.set(report.suites[0].specs, "1", { title: "unrelated" });
    expect(evaluatePlaywright(records, [report], root, [inventory])).toEqual([{ id: "r", code: "PLAYWRIGHT_REPORT_INVALID" }]);
  });

  it.each(["project id", "empty id", "results", "zero results", "two passes", "result status", "retry"])("unverified %s retains TEST_EXECUTION_UNVERIFIED", kind => {
    const { root, inventory, report, records } = evidence();
    const test = report.suites[0].specs[0].tests[0];
    if (kind === "project id") Reflect.deleteProperty(test, "projectId");
    if (kind === "empty id") test.projectId = "";
    if (kind === "results") Reflect.set(test, "results", { 0: { status: "passed", retry: 0 }, length: 1 });
    if (kind === "zero results") test.results = [];
    if (kind === "two passes") test.results.push({ status: "passed", retry: 0 });
    if (kind === "result status") test.results[0].status = "failed";
    if (kind === "retry") test.results[0].retry = 1;
    expect(evaluatePlaywright(records, [report], root, [inventory])).toEqual([{ id: "r", code: "TEST_EXECUTION_UNVERIFIED" }]);
  });

  it.each(["errors", "missing errors", "arraylike errors", "suites", "results", "results shape", "status", "missing project id", "projects", "duplicate project ids", "bad project", "relative root"])("malformed judge discovery %s refuses", kind => {
    const { root, inventory, report, records } = evidence();
    if (kind === "errors") inventory.errors.push({ message: "collection failed" });
    if (kind === "missing errors") Reflect.deleteProperty(inventory, "errors");
    if (kind === "arraylike errors") Reflect.set(inventory, "errors", { length: 0 });
    if (kind === "suites") Reflect.set(inventory, "suites", {});
    if (kind === "results") inventory.suites[0].specs[0].tests[0].results.push({ status: "passed", retry: 0 });
    if (kind === "results shape") Reflect.set(inventory.suites[0].specs[0].tests[0], "results", { length: 0 });
    if (kind === "status") inventory.suites[0].specs[0].tests[0].status = "expected";
    if (kind === "missing project id") Reflect.deleteProperty(inventory.suites[0].specs[0].tests[0], "projectId");
    if (kind === "projects") inventory.config.projects = [];
    if (kind === "duplicate project ids") inventory.config.projects.push(structuredClone(inventory.config.projects[0]));
    if (kind === "bad project") Reflect.set(inventory.config.projects[0], "name", null);
    if (kind === "relative root") {
      inventory.config.rootDir = "relative";
      inventory.suites[0].specs[0].file = path.join(root, "replay.spec.ts");
    }
    expect(evaluatePlaywright(records, [report], root, [inventory])).toEqual([{ id: "r", code: "PLAYWRIGHT_INVENTORY_INVALID" }]);
  });

  it.each(["version upgrade", "mismatched root", "mismatched declarations", "malformed declaration"])("config %s is compared without a version pin", kind => {
    const { root, inventory, report, records } = evidence();
    if (kind === "version upgrade") inventory.config.version = report.config.version = "next-supported-version";
    if (kind === "mismatched root") inventory.config.rootDir = path.join(root, "other");
    if (kind === "mismatched root") inventory.suites[0].specs[0].file = "../replay.spec.ts";
    if (kind === "mismatched declarations") report.config.projects[0].testMatch = ["other.spec.ts"];
    if (kind === "malformed declaration") Reflect.set(report.config, "projects", [null]);
    expect(evaluatePlaywright(records, [report], root, [inventory])).toEqual([{ id: "r", code: kind === "version upgrade" ? "PASS" : "PLAYWRIGHT_CONFIG_MISMATCH" }]);
  });

  it("an unsupported config path refuses before it can execute", () => {
    const { root, inventory, report, records } = evidence();
    report.config.configFile = path.join(root, "untrusted.config.ts");
    expect(evaluatePlaywright(records, [report], root, [inventory])).toEqual([{ id: "r", code: "PLAYWRIGHT_CONFIG_MISMATCH" }]);
  });

  it.each(["__proto__", "unknown", "visual"])("report bytes cannot choose the config bound to source label %s", configName => {
    const { root, inventory, report, records } = evidence();
    expect(withDiscovery([inventory], () => judgePlaywright(records, [{ configName, report }], root)))
      .toEqual([{ id: "r", code: "PLAYWRIGHT_CONFIG_MISMATCH" }]);
  });

  it.each(["report.json", "visualx", "unknown=report.json", "__proto__=report.json"])("CLI refuses an unbound report argument %s", argument => {
    const { root } = evidence();
    const result = invokeMain(root, ["--tier", "full", "--playwright-report", argument]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("CLI_REPORT_CONFIG_INVALID: Invalid CLI arguments: --root must match the host-selected root; --config and --playwright-report must stay inside that root; --playwright-report requires a fixed config label (tests, visual, opening-visual, scenarios, opening-proof)=path; --tier must be pr or full.\n");
    expect(result.stderr).not.toContain(argument);
  });

  it("unexpected CLI exceptions keep their technical text private", () => {
    const { root } = evidence();
    const result = invokeMain(path.join(root, "private-host-error-822e"), []);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("CLI_ARGUMENTS_INVALID: Invalid CLI arguments: --root must match the host-selected root; --config and --playwright-report must stay inside that root; --playwright-report requires a fixed config label (tests, visual, opening-visual, scenarios, opening-proof)=path; --tier must be pr or full.\n");
    expect(result.stderr).not.toMatch(/private-host-error-822e|ENOENT|realpath|Error:/);
  });

  it.each(["missing argv", "nonstring argv", "update config", "short update"])("unsafe execution %s refuses", kind => {
    const { root, inventory, report, records } = evidence();
    if (kind === "missing argv") Reflect.deleteProperty(report.config, "argv");
    if (kind === "nonstring argv") Reflect.set(report.config, "argv", [null]);
    if (kind === "update config") Reflect.set(report.config, "updateSnapshots", "all");
    if (kind === "short update") report.config.argv.push("-u");
    expect(evaluatePlaywright(records, [report], root, [inventory])).toEqual([{ id: "r", code: "PLAYWRIGHT_EXECUTION_UNSAFE" }]);
  });

  it.each(["nonzero", "null exit", "spawn error", "non-json", "wrong config"])("discovery subprocess %s refuses without public technical output", kind => {
    const { root, inventory, report, records } = evidence();
    writeFileSync(path.join(root, "playwright.config.ts"), "export default {};");
    if (kind === "wrong config") inventory.config.configFile = path.join(root, "other.config.ts");
    vi.mocked(spawnSync).mockReturnValue({
      status: kind === "nonzero" ? 1 : kind === "null exit" ? null : 0,
      error: kind === "spawn error" ? new Error("private provider error") : undefined,
      stdout: kind === "non-json" ? "List of tests: private technical output" : JSON.stringify(inventory),
      stderr: "private provider error", signal: null, pid: 1, output: [],
    } as ReturnType<typeof spawnSync>);
    try {
      expect(evaluatePlaywright(records, [report], root)).toEqual([{ id: "r", code: kind === "wrong config" ? "PLAYWRIGHT_INVENTORY_INVALID" : "PLAYWRIGHT_DISCOVERY_FAILED" }]);
    } finally { vi.mocked(spawnSync).mockImplementation(realSpawnSync); }
  });

  it("an ambiguous collected leaf refuses only that record", () => {
    const { root, inventory, report, records } = evidence();
    const unrelated = { ...structuredClone(inventory.suites[0].specs[0]), title: "ambiguous" };
    inventory.suites[0].specs.push(unrelated, structuredClone(unrelated));
    expect(evaluatePlaywright(records, [report], root, [inventory])).toEqual([{ id: "r", code: "PASS" }]);
    report.suites[0].specs[0].title = "ambiguous";
    records[0].impl.testName = "ambiguous";
    expect(evaluatePlaywright(records, [report], root, [inventory])).toEqual([{ id: "r", code: "PLAYWRIGHT_INVENTORY_INVALID" }]);
  });

  it("a discovery failure fails the run even when no browser records are selected", () => {
    const { root, inventory, report } = evidence();
    writeFileSync(path.join(root, "backend.fixture.js"), 'test("fine", () => {});');
    writeFileSync(path.join(root, "regression/scenarios/money/backend.scenario.json"), JSON.stringify({
      id: "backend", status: "active", level: "backend", impl: { file: "backend.fixture.js", testName: "fine" },
    }));
    inventory.errors.push({ message: "cannot list" });
    const summary = withDiscovery(labelledCopies(inventory, ["visual"]), () => runPrScenarios({ root, config: config(root), changedFiles: [], playwrightReports: labelledCopies(report, ["visual"]) }));
    expect(summary.passed).toBe(1);
    expect(summary.issues).toEqual(["PLAYWRIGHT_INVENTORY_INVALID"]);
    expect(summary.verdict).toBe("FAIL");
  });
});
