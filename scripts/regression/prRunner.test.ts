// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changedFilesSince, evaluate, evaluatePlaywright, readPlaywrightReports, runPrScenarios, selectForPr, selectFull, summarise } from "./prRunner.mjs";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";

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
      ...(record.file === undefined ? {} : { impl: { file: record.file, testName: record.testName } }),
    };
    writeFileSync(path.join(root, "regression", "scenarios", "money", `${record.id}.scenario.json`), JSON.stringify(body));
  }
  return root;
}

const config = (root: string) => path.join(root, "vitest.config.mjs");

describe("PR diff base", () => {
  let root: string;
  let baseSha: string;
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
    git(["tag", "blob-base", git(["hash-object", "-w", "changed.txt"])]);
    git(["checkout", "-b", "base-side", baseSha]);
    writeFileSync(path.join(root, "base-only.txt"), "base branch change\n");
    git(["add", "--", "base-only.txt"]);
    git(["-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "base side"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(["checkout", "main"]);
  });

  it.each(["--output=probe", "-c core.pager=sh", "../../etc", "origin/main\n", "origin/main\u0000", "HEAD~1"])("refuses a hostile base before git: %j", base => {
    expect(() => changedFilesSince(root, base)).toThrow("Invalid base: expected a full 40-character commit SHA or a safe Git ref name");
  });

  it("accepts the workflow's full SHA and the CLI's default remote ref, preserving merge-base selection", () => {
    expect(changedFilesSince(root, baseSha)).toEqual(["changed.txt"]);
    expect(changedFilesSince(root, "origin/main")).toEqual(["changed.txt"]);
  });

  it.each(["missing-base", "blob-base"])("refuses a base that does not resolve to a commit: %s", base => {
    expect(() => changedFilesSince(root, base)).toThrow("Invalid base: must resolve to an existing Git commit");
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
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "prRunner.mjs");
    const child = spawnSync(process.execPath, [cli, "--root", root, "--config", config(root)], { encoding: "utf8" });
    expect(child.status).toBe(1);
    const summary = JSON.parse(child.stdout.slice(child.stdout.indexOf("{")));
    expect(summary).toMatchObject({ verdict: "FAIL", selected: 2, passed: 1, failed: 1 });
    expect(summary.failedIds).toEqual(["unloadable FILE_FAILED_TO_RUN"]);
    expect(summary.issues).toEqual(["VITEST_EXIT_1"]);
    expect(child.stdout).not.toContain("7342");
  });

  it("a green project exits zero from the CLI", () => {
    const root = makeProject({ "ok.fixture.js": 'test("fine", () => {});\n' }, [{ id: "healthy", file: "ok.fixture.js", testName: "fine" }]);
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "prRunner.mjs");
    expect(spawnSync(process.execPath, [cli, "--root", root, "--config", config(root)], { encoding: "utf8" }).status).toBe(0);
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
    const records = [
      { id: "mapped-touched", status: "active", level: "browser", sourceGlobs: ["components/cockpit/**"], impl: { file: "playwright/a.spec.ts" } },
      { id: "mapped-untouched", status: "active", level: "browser", sourceGlobs: ["components/other/**"], impl: { file: "playwright/b.spec.ts" } },
      { id: "unmapped", status: "active", level: "browser", impl: { file: "playwright/c.spec.ts" } },
      { id: "spec-edited", status: "active", level: "browser", impl: { file: "playwright/d.spec.ts" } },
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
      expect(summary.issues).toEqual(["SELECTED_BROWSER_RECORDS_NEED_A_BROWSER_AND_BACKEND_SCRUM762:1"]);
      expect(summary.browser).toEqual({ selected: 1, notRequiredAtPrTime: 1, unmappedToAScreen: 2 });
    });

    it("a PR that touches no screen passes, with the browser records counted as not required or unmapped", () => {
      const summary = summarise(selectForPr(records, ["README.md"]), [{ id: "b", code: "PASS" }], []);
      expect(summary).toMatchObject({ verdict: "PASS", failed: 0, browser: { selected: 0, notRequiredAtPrTime: 2, unmappedToAScreen: 2 } });
    });

    it("an unknown PR diff fails: every browser record counts as selected", () => {
      const summary = summarise(selectForPr(records, null), [{ id: "b", code: "PASS" }], []);
      expect(summary.verdict).toBe("FAIL");
      expect(summary.issues).toContain("PR_DIFF_UNAVAILABLE");
      expect(summary.browser.selected).toBe(4);
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
    ({ id, status: "active", level: "browser", impl: { file, testName } });
  const report = (specs: Array<{ title: string; file?: string; status: string; project?: string }>) => ({
    config: { rootDir: path.join(root, "playwright", "tests"), projects: [{ id: "chromium", name: "chromium", testDir: path.join(root, "playwright", "tests") }] },
    suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [], suites: [{ title: "group", file: "a.spec.ts", specs: specs.map(spec => ({
      title: spec.title, file: spec.file ?? "a.spec.ts", tests: [{ projectName: spec.project ?? "chromium", projectId: spec.project ?? "chromium", status: spec.status }],
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
  const reportFor = (dir: string, specs: Parameters<typeof report>[0]) => {
    const base = report(specs);
    base.config.rootDir = path.join(dir, "playwright", "tests");
    base.config.projects[0].testDir = path.join(dir, "playwright", "tests");
    return base;
  };

  it("selects every active browser record, mapped or not, and every active backend record", () => {
    const selection = selectFull([
      browserRecord("mapped"), { ...browserRecord("unmapped"), sourceGlobs: [] },
      { id: "b", status: "active", level: "backend" }, { id: "r", status: "retired", level: "browser" },
    ] as never);
    expect(selection.browserSelected.map((record: { id: string }) => record.id)).toEqual(["mapped", "unmapped"]);
    expect(selection.run.map((record: { id: string }) => record.id)).toEqual(["b"]);
    expect(selection).toMatchObject({ browserNotRequired: [], browserUnmapped: [], retired: 1 });
  });

  it("green control: a browser record whose bound title ran as expected passes", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    expect(evaluatePlaywright([browserRecord("ok")] as never, [reportFor(dir, [{ title: "the replay", status: "expected" }])], dir)).toEqual([{ id: "ok", code: "PASS" }]);
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
    expect(evaluatePlaywright([record] as never, [reportFor(dir, [{ title: "the replay", status: "expected", file: "audit-role-access.spec.ts" }])], dir)[0].code).toBe("PASS");
  });

  it("one failing execution among several projects fails the record", () => {
    const dir = withFiles("playwright/tests/a.spec.ts");
    const both = reportFor(dir, [{ title: "the replay", status: "expected" }, { title: "the replay", status: "unexpected", project: "chromium" }]);
    expect(evaluatePlaywright([browserRecord("r")] as never, [both], dir)[0].code).toBe("TEST_FAILED");
  });

  it("a spec with the same name in another directory does not satisfy the record", () => {
    const dir = withFiles("playwright/tests/a.spec.ts", "playwright/scenarios/a.spec.ts");
    const other = reportFor(dir, [{ title: "the replay", status: "expected" }]);
    other.config.rootDir = path.join(dir, "playwright", "scenarios");
    other.config.projects[0].testDir = path.join(dir, "playwright", "scenarios");
    expect(evaluatePlaywright([browserRecord("r")] as never, [other], dir)[0].code).toBe("BROWSER_REPLAY_NOT_EXECUTED");
  });

  it("the full tier fails on an unexecuted browser record, a parked candidate and an unreadable report", () => {
    const records = [browserRecord("replay"), { id: "cand", status: "candidate", level: "backend" }];
    const selection = selectFull(records as never);
    const summary = summarise(selection, [{ id: "b", code: "PASS" }], ["PLAYWRIGHT_REPORT_UNREADABLE"], [{ id: "replay", code: "BROWSER_REPLAY_NOT_EXECUTED" }], "full");
    expect(summary).toMatchObject({ tier: "full", verdict: "FAIL", failureCodes: { BROWSER_REPLAY_NOT_EXECUTED: 1 } });
    expect(summary.issues).toEqual(["PLAYWRIGHT_REPORT_UNREADABLE", "CANDIDATE_RECORDS_ARE_NOT_EXECUTED:1"]);
    expect(summary.browser.selected).toBe(1);
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
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "prRunner.mjs");
    mkdirSync(path.join(dir, "regression", "scenarios"), { recursive: true });
    writeFileSync(path.join(dir, "regression", "scenarios", "x.scenario.json"), JSON.stringify(browserRecord("replay")));
    const full = spawnSync(process.execPath, [cli, "--root", dir, "--tier", "full"], { encoding: "utf8" });
    expect(full.status).toBe(1);
    expect(JSON.parse(full.stdout.slice(full.stdout.indexOf("{")))).toMatchObject({ tier: "full", verdict: "FAIL", failedIds: ["replay BINDING_FILE_MISSING"] });
    expect(spawnSync(process.execPath, [cli, "--root", dir, "--tier", "nightly"], { encoding: "utf8" }).status).toBe(2);
  });
});
