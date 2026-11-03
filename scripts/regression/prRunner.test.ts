// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { evaluate, runPrScenarios, selectForPr, summarise } from "./prRunner.mjs";

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

  it("selection: browser records are counted as not run here, cloud records fail, candidates and retired are not run", () => {
    const selection = selectForPr([
      { id: "b", status: "active", level: "backend" }, { id: "br", status: "active", level: "browser" },
      { id: "c", status: "active", level: "cloud" }, { id: "cand", status: "candidate", level: "backend" },
      { id: "r", status: "retired", level: "backend" },
    ] as never);
    expect(selection.run.map((record: { id: string }) => record.id)).toEqual(["b"]);
    expect(selection.browserDeferred).toHaveLength(1);
    expect(selection).toMatchObject({ candidate: 1, retired: 1 });
    const summary = summarise(selection, [{ id: "b", code: "PASS" }], []);
    expect(summary.verdict).toBe("FAIL");
    expect(summary.issues).toEqual(["CLOUD_RECORDS_HAVE_NO_RUNNER:1"]);
    expect(summary.notRunHere).toEqual({ browserDeferred: 1, candidate: 1, retired: 1 });
  });

  it("evaluate matches by the exact file, not by a similarly named one", () => {
    const root = makeProject({ "a.fixture.js": "", "ab.fixture.js": "" }, []);
    const report = { testResults: [{ name: path.join(root, "ab.fixture.js"), status: "passed", assertionResults: [{ title: "t", status: "passed" }] }] };
    const verdicts = evaluate([{ id: "x", impl: { file: "a.fixture.js", testName: "t" } }], report, root);
    expect(verdicts).toEqual([{ id: "x", code: "FILE_NOT_EXECUTED" }]);
  });
});
