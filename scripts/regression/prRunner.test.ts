// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { changedFilesSince, evaluate, evaluatePlaywright, loadRecords, main, readPlaywrightReports, runPrScenarios, selectForPr, selectFull, summarise } from "./prRunner.mjs";
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
      ...(record.level === "browser" ? { sourceGlobs: ["components/fixture/**"] } : {}),
      ...(record.file === undefined ? {} : { impl: { file: record.file, testName: record.testName } }),
    };
    writeFileSync(path.join(root, "regression", "scenarios", "money", `${record.id}.scenario.json`), JSON.stringify(body));
  }
  return root;
}

const config = (root: string) => path.join(root, "vitest.config.mjs");

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
      const result = invokeMain(root, [option, input]);
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
      const result = invokeMain(root, [option, "linked/vitest.config.mjs"]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
    } finally {
      unlinkSync(link);
    }
  });

  it("resolves relative reports under the host root and keeps missing reports as failures", () => {
    const root = makeProject({ "replay.fixture.js": "" }, [{ id: "replay", level: "browser", file: "replay.fixture.js", testName: "the replay" }]);
    writeFileSync(path.join(root, "report.json"), JSON.stringify({ config: { rootDir: root }, suites: [{
      specs: [{ title: "the replay", file: "replay.fixture.js", tests: [{ status: "expected" }] }],
    }] }));
    const good = invokeMain(root, ["--tier", "full", "--playwright-report", "report.json"]);
    expect(good.status).toBe(0);
    expect(JSON.parse(good.stdout)).toMatchObject({ verdict: "PASS", selected: 1, passed: 1, issues: [] });
    const missing = invokeMain(root, ["--tier", "full", "--playwright-report", "missing.json"]);
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
    it.each([
      ["g8-owned-cash-delivery-screen", ["vehicles/page.tsx"]],
      ["g8-owned-financed-delivery-screen", ["applications/[id]/deal/page.tsx", "vehicles/page.tsx", "customers/page.tsx", "settings/finance/page.tsx", "accounting/page.tsx"]],
      ["g8-deals-list-to-detail", ["applications/[id]/deal/page.tsx", "settings/finance/page.tsx"]],
      ["g8-sourced-direct-financed-delivery-screen", ["applications/[id]/deal/page.tsx", "customers/page.tsx", "settings/finance/page.tsx"]],
      ["g8-sourced-financed-delivery-screen", ["applications/[id]/deal/page.tsx", "customers/page.tsx", "settings/finance/page.tsx"]],
    ])("delivery replay %s is selected for every route its fixtures visit", (id, routes) => {
      const { records: library } = loadRecords(path.resolve(__dirname, "../.."));
      const record = library.find(record => record.id === id);
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
    expect(selection).toMatchObject({ browserNotRequired: [], browserUnmapped: [{ id: "unmapped" }], retired: 1 });
    expect(summarise(selection, [{ id: "b", code: "PASS" }], [], [{ id: "mapped", code: "PASS" }, { id: "unmapped", code: "PASS" }], "full").issues).toContain("BROWSER_SCREEN_MAPPING_MISSING:1");
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


  it("a nested project testDir cannot credit a same-title file that did not run", () => {
    const dir = withFiles("tests/a.spec.ts", "tests/tests/a.spec.ts");
    const nested = {
      config: { rootDir: dir, projects: [{ id: "chromium", name: "chromium", testDir: path.join(dir, "tests") }] },
      suites: [{ specs: [{ file: "tests/a.spec.ts", title: "the replay", tests: [{ projectId: "chromium", projectName: "chromium", status: "expected" }] }] }],
    };
    expect(evaluatePlaywright([
      browserRecord("executed", "tests/a.spec.ts"), browserRecord("never-ran", "tests/tests/a.spec.ts"),
    ], [nested], dir)).toEqual([
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
