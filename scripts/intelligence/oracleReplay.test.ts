// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { blindSource, classifyExplorerPair, classifyPair, summarizeReplay, readVitestReport, prepareReplay, readBrowserReport } from "./oracleReplay.mjs";
import { writeReplayReport } from "./runOracleReplay.mjs";
import corpus from "./oracleReplayCorpus.json";

const clean = { state: "complete", findings: [], tests: 2, durationMs: 3 };
const broken = { ...clean, findings: ["assertion:1"] };

describe("historical oracle replay evidence", () => {
  it.each([
    ["main", "success", "a".repeat(40), 0],
    ["feature", "success", "a".repeat(40), 1],
    ["main", "failure", "a".repeat(40), 1],
    ["main", "success", "b".repeat(40), 1],
  ])("dispatch authorization refuses invalid provenance: %s %s %s", (branch, conclusion, requestSha, exit) => {
    const workflow = z.object({ jobs: z.object({ authorize: z.object({ steps: z.array(z.object({ run: z.string() })) }) }) })
      .parse(parseYaml(readFileSync(".github/workflows/trusted-oracle-catch-rate.yml", "utf8")));
    const script = /^node <<'NODE'\n([\s\S]*)\nNODE$/.exec(workflow.jobs.authorize.steps[0].run);
    expect(script, "the trusted authorizer must be executable Node, not a skipped job").not.toBeNull();
    const result = spawnSync(process.execPath, ["-e", script![1]], { timeout: 5_000, encoding: "utf8", env: {
      NODE_ENV: "test",
      REQUEST_EVENT: "workflow_dispatch", REQUEST_BRANCH: String(branch), REQUEST_RESULT: String(conclusion),
      REQUEST_REPOSITORY: "owner/repo", EXPECTED_REPOSITORY: "owner/repo", REQUEST_SHA: String(requestSha), CONTROLLER_SHA: "a".repeat(40),
    } });
    expect(result.status).toBe(exit);
  });
  it("does not accept a complete-looking verdict without measured per-case evidence", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "oracle-report-"));
    try {
      const forged = corpus.cases.map(entry => ({ ...entry, baseline: "caught", explorer: "caught" }));
      const report = writeReplayReport(forged, directory, { browser: true });
      expect(report.gate).toBe("FAIL");
      expect(report.unavailable).toHaveLength(corpus.cases.length);
      expect(report.combinedRecall).toBe(0);
      expect(report.precision).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("withholds a gate verdict while additional alerts still need precision adjudication", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "oracle-adjudication-"));
    try {
      const entries = corpus.cases.map(entry => ({ ...entry,
        reproduction: { status: "reproduced", fixed: clean, bug: broken },
        observations: { baseline: { fixed: clean, bug: clean }, explorer: {
          fixed: clean, bug: { ...broken, findings: [entry.expectedFingerprints[0], "form:raw-error"] },
        } },
      }));
      const report = writeReplayReport(entries, directory, { browser: true });
      expect(report.explorerRecall).toBe(1);
      expect(report.precision).toBeNull();
      expect(report.gate).toBe("FAIL");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("blinds descriptions without changing executable strings or empty calls", () => {
    const text = blindSource('it("revealing finding", () => { save(); expect("literal input").toBe("literal input"); }); // answer', "probe.test.ts");
    expect(text).not.toContain("revealing finding");
    expect(text).not.toContain("answer");
    expect(text).toContain('"literal input"');
    expect(text).toContain("save()");
  });

  it("requires executed browser tests and observation files, and keeps model opinions out of findings", () => {
    const report = { stats: { expected: 5, unexpected: 2, flaky: 0, skipped: 0 } };
    const observations = {
      cross: [{ verdict: { result: "DISAGREE", fact: "count" } }],
      explorer: { steps: 2, visited: ["/dashboard"], findings: [{ check: "jev-opinion" }, { check: "raw-value" }] },
      forms: { summary: { attempts: 1, inconclusive: 0 }, records: [{ verdict: { kind: "finding", check: "raw-error" } }] },
      swarm: { harnessErrorCount: 0, results: [{ missionId: "mission-1", outcome: "CONFIRMED_BREACH", evidence: { oracle: { passed: false } } }] },
      manifest: { workers: [{ missions: [{ id: "mission-1", invariantIds: ["AUTH-1"] }] }] },
      invocations: [{ missionId: "mission-1", name: "memberships:setRole" }],
    };
    expect(readBrowserReport(report, observations, 1)).toMatchObject({ state: "complete", tests: 7, findings: ["cross-screen:count", "explorer:raw-value", "form:raw-error", "swarm:AUTH-1:memberships:setRole"] });
    expect(classifyExplorerPair({ ...clean, tests: 7 }, readBrowserReport(report, observations, 1), ["swarm:AUTH-1:dealCommissions:addLine"])).toBe("missed");
    expect(readBrowserReport(report, { ...observations, cross: [] }, 1).state).toBe("unavailable");
    expect(readBrowserReport({ stats: { ...report.stats, skipped: 1 } }, observations, 1).state).toBe("unavailable");
    expect(readBrowserReport(report, observations, null).state).toBe("unavailable");
  });
  it("requires a clean fixed control and a reproduced mutant before crediting a catch", () => {
    expect(classifyPair(clean, broken)).toBe("caught");
    expect(classifyPair(clean, clean)).toBe("missed");
    expect(classifyPair(broken, broken)).toBe("unavailable");
    expect(classifyPair(clean, { state: "malformed" })).toBe("unavailable");
    expect(classifyPair(clean, { ...broken, tests: 1 })).toBe("unavailable");
    expect(classifyExplorerPair(clean, broken, ["a different known bug"])).toBe("missed");
    expect(classifyExplorerPair(clean, broken, ["assertion:1"])).toBe("caught");
    expect(classifyExplorerPair(clean, { ...broken, findings: ["swarm:LIFE-1:quotes:create:FINANCED"] }, ["swarm:LIFE-1:quotes:create"])).toBe("caught");
    expect(classifyExplorerPair(clean, { ...broken, findings: ["swarm:AUTH-1:sales:create:CASH"] }, ["swarm:AUTH-1:sales:create:FINANCED"])).toBe("missed");
  });

  it.each([undefined, {}, { numTotalTests: 0 }, { numTotalTests: 1, testResults: [] }])(
    "does not turn absent, empty or inconsistent reports into detections: %j", (report) => {
      expect(readVitestReport(report, 1).state).not.toBe("complete");
    },
  );

  it("distinguishes assertion failures from skipped work, timeouts and import failures", () => {
    const report = (status: string, messages: string[]) => ({
      numTotalTests: 1, numPassedTests: status === "passed" ? 1 : 0,
      numFailedTests: status === "failed" ? 1 : 0, numPendingTests: status === "pending" ? 1 : 0,
      testResults: [{ status, assertionResults: [{ fullName: "neutral", status, failureMessages: messages }] }],
    });
    expect(readVitestReport(report("failed", ["AssertionError: expected 2 to equal 1"]), 1).findings).toHaveLength(1);
    expect(readVitestReport(report("failed", ['Error: promise resolved "null" instead of rejecting\n at Assertion.__VITEST_REJECTS__']), 1).findings).toHaveLength(1);
    expect(readVitestReport(report("failed", ["Error: Cannot find module"]), 1).state).toBe("unavailable");
    expect(readVitestReport(report("pending", []), 0).state).toBe("unavailable");
    expect(readVitestReport(report("passed", []), null).state).toBe("unavailable");
  });

  it("keeps unavailable cases in recall and refuses a partial or zero-case run", () => {
    const entries = [
      { id: "a", severity: "HIGH", baseline: "caught", explorer: "missed" },
      { id: "b", severity: "CRITICAL", baseline: "missed", explorer: "caught" },
      { id: "c", severity: "HIGH", baseline: "unavailable", explorer: "unavailable" },
    ];
    const report = summarizeReplay(entries);
    expect(report.combinedRecall).toBe(2 / 3);
    expect(report.explorerRecall).toBe(1 / 3);
    expect(report.incrementalCatches).toEqual(["b"]);
    expect(report.misses).toEqual(["a"]);
    expect(report.unavailable).toEqual(["c"]);
    expect(report.gate).toBe("FAIL");
    expect(summarizeReplay([]).gate).toBe("FAIL");
    expect(summarizeReplay([{ ...entries[0], explorer: "caught" }]).gate).toBe("PASS");
  });

  it("reverses a real Git patch in a separate copy and excludes post-finding tests and labels", () => {
    const repository = mkdtempSync(path.join(tmpdir(), "oracle-repository-"));
    const scratch = mkdtempSync(path.join(tmpdir(), "oracle-scratch-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true }).trim();
    try {
      git("init", "-q");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Replay test");
      writeFileSync(path.join(repository, "subject.ts"), "// answer revealing comment\nexport const total = 2;\n");
      writeFileSync(path.join(repository, "baseline.test.ts"), "export const input = 41;\n");
      git("add", "subject.ts", "baseline.test.ts");
      git("commit", "-qm", "initial");
      const parent = git("rev-parse", "HEAD");
      writeFileSync(path.join(repository, "subject.ts"), "export const total = 1;\n");
      writeFileSync(path.join(repository, "answer.test.ts"), "answer only known later");
      git("add", "subject.ts", "answer.test.ts");
      git("commit", "-qm", "secret answer in message");
      const fix = git("rev-parse", "HEAD");
      const prepared = prepareReplay({ repository, scratch, entry: {
        id: "opaque", fix, parent, paths: ["subject.ts"], baselineTests: ["baseline.test.ts"],
      } });
      expect(readFileSync(path.join(prepared.bug, "subject.ts"), "utf8")).toContain("total = 2");
      expect(readFileSync(path.join(prepared.fixed, "subject.ts"), "utf8")).toContain("total = 1");
      expect(readFileSync(path.join(repository, "subject.ts"), "utf8")).toBe("export const total = 1;\n");
      expect(() => readFileSync(path.join(prepared.bug, "answer.test.ts"))).toThrow();
      expect(() => readFileSync(path.join(prepared.bug, ".git"))).toThrow();
      expect(readFileSync(path.join(prepared.bug, "subject.ts"), "utf8")).not.toContain("answer revealing");
      expect(() => prepareReplay({ repository, scratch, entry: {
        id: "unsafe", fix, parent, paths: ["../outside"], baselineTests: [],
      } })).toThrow();
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
