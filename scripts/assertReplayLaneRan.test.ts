import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPLAY_SPEC_TITLE,
  REPLAY_SUITE_TITLE,
  evaluateReplayReport,
  main,
  renderSummary,
} from "./assertReplayLaneRan.mjs";

type T = { status: string; results: Array<Record<string, unknown>>; projectName?: string };
const t = (status: string, results: Array<Record<string, unknown>>, projectName = "chromium"): T => ({
  status,
  results,
  projectName,
});
function report(replay: T | null, others: T[] = []) {
  return {
    errors: [],
    config: { projects: [{ name: "setup" }, { name: "chromium" }] },
    suites: [
      {
        title: "accounting.spec.ts",
        file: "accounting.spec.ts",
        suites: [
          { title: "accounting workspace", specs: others.map((x, i) => ({ title: `other ${i}`, tests: [x] })) },
          { title: REPLAY_SUITE_TITLE, specs: replay ? [{ title: REPLAY_SPEC_TITLE, ok: replay.status === "expected", tests: [replay] }] : [] },
        ],
      },
    ],
  };
}
const passed = t("expected", [{ status: "passed" }]);

describe("evaluateReplayReport", () => {
  it("accepts a single passing replay and passing neighbours", () => {
    const v = evaluateReplayReport(report(passed, [passed]));
    expect(v.ok).toBe(true);
    expect(v.counts).toMatchObject({ replayTests: 1, replayPassed: 1, expected: 2, unexpected: 0 });
  });

  it("fails a skipped replay, even though Playwright exits 0 for it", () => {
    const v = evaluateReplayReport(report(t("skipped", [{ status: "skipped" }]), [passed]));
    expect(v.ok).toBe(false);
    expect(v.counts.skipped).toBe(1);
  });

  it("fails when any other test in the spec was skipped (no unexpected skip is tolerated)", () => {
    const v = evaluateReplayReport(report(passed, [passed, t("skipped", [{ status: "skipped" }])]));
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/skipped/);
  });

  it("does not count a replay whose spec is not ok, or whose last attempt is not passed", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = report(passed, [passed]) as Record<string, any>;
    r.suites[0].suites[1].specs[0].ok = false;
    expect(evaluateReplayReport(r).ok).toBe(false);
    expect(evaluateReplayReport(report(t("expected", [{ status: "passed" }, { status: "failed" }]))).ok).toBe(false);
  });

  it("fails two copies of the replay test (exactly one)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = report(passed) as Record<string, any>;
    r.suites[0].suites[1].specs.push({ title: REPLAY_SPEC_TITLE, ok: true, tests: [passed] });
    expect(evaluateReplayReport(r).ok).toBe(false);
  });

  it("fails a missing replay test (renamed or filtered out)", () => {
    expect(evaluateReplayReport(report(null, [passed])).ok).toBe(false);
  });

  it("fails a failed, flaky or retried replay", () => {
    expect(evaluateReplayReport(report(t("unexpected", [{ status: "failed" }, { status: "failed" }]))).ok).toBe(false);
    expect(evaluateReplayReport(report(t("flaky", [{ status: "failed" }, { status: "passed" }]))).ok).toBe(false);
    expect(evaluateReplayReport(report(t("expected", [{ status: "failed" }, { status: "passed" }]))).ok).toBe(false);
  });

  it("fails when any other test failed", () => {
    expect(evaluateReplayReport(report(passed, [t("unexpected", [{ status: "failed" }])])).ok).toBe(false);
  });

  it("fails an unreadable report", () => {
    expect(evaluateReplayReport(null).ok).toBe(false);
    expect(evaluateReplayReport({}).ok).toBe(false);
  });

  it("does not credit a same-titled test outside the replay suite", () => {
    const wrongSuite = { ...report(null), suites: [{ title: "other", file: "accounting.spec.ts", specs: [{ title: REPLAY_SPEC_TITLE, tests: [passed] }] }] };
    expect(evaluateReplayReport(wrongSuite).ok).toBe(false);
  });

  describe("report identity (fails closed)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base = () => report(passed, [passed]) as Record<string, any>;

    it("accepts the auth setup file next to the replay spec", () => {
      const r = base();
      r.suites.push({ title: "auth.setup.ts", file: "auth.setup.ts", specs: [{ title: "authenticate", tests: [t("expected", [{ status: "passed" }], "setup")] }] });
      expect(evaluateReplayReport(r).ok).toBe(true);
    });

    it("rejects a replay that ran under another project", () => {
      expect(evaluateReplayReport(report(t("expected", [{ status: "passed" }], "webkit"))).ok).toBe(false);
    });

    it("rejects top-level errors, a missing errors list, and a non-empty one", () => {
      const withErrors = base();
      withErrors.errors = [{ message: "boom" }];
      expect(evaluateReplayReport(withErrors).ok).toBe(false);
      const missing = base();
      delete missing.errors;
      expect(evaluateReplayReport(missing).ok).toBe(false);
    });

    it("rejects a config that does not name the chromium project", () => {
      const r = base();
      r.config = { projects: [{ name: "firefox" }] };
      expect(evaluateReplayReport(r).ok).toBe(false);
      const none = base();
      delete none.config;
      expect(evaluateReplayReport(none).ok).toBe(false);
    });

    it("rejects a report from another spec file, or one that adds a second file", () => {
      const wrongFile = base();
      wrongFile.suites[0].file = "deals.spec.ts";
      expect(evaluateReplayReport(wrongFile).ok).toBe(false);
      const extra = base();
      extra.suites.push({ title: "other.spec.ts", file: "other.spec.ts", specs: [] });
      expect(evaluateReplayReport(extra).ok).toBe(false);
    });
  });
});

describe("main and the summary", () => {
  function run(rep: unknown) {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-lane-"));
    const file = path.join(dir, "report.json");
    const summary = path.join(dir, "summary.md");
    writeFileSync(file, JSON.stringify(rep));
    writeFileSync(summary, "");
    const lines: string[] = [];
    const code = main([file], { GITHUB_STEP_SUMMARY: summary } as unknown as NodeJS.ProcessEnv, (l: string) => lines.push(l));
    return { code, lines, summary: readFileSync(summary, "utf8") };
  }

  it("exits 0 and writes counts for a passing replay", () => {
    const r = run(report(passed));
    expect(r.code).toBe(0);
    expect(r.summary).toContain("replay ran and passed");
    expect(r.summary).toContain("| replay tests passed | 1 |");
  });

  it("writes the same summary to the optional second file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-lane-"));
    const file = path.join(dir, "report.json");
    const out = path.join(dir, "out.md");
    writeFileSync(file, JSON.stringify(report(passed)));
    expect(main([file, out], {} as NodeJS.ProcessEnv, () => {})).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("replay ran and passed");
  });

  it("exits 1 for a skipped replay and for a missing file", () => {
    expect(run(report(t("skipped", [{ status: "skipped" }]))).code).toBe(1);
    expect(main(["/nonexistent/report.json"], {} as NodeJS.ProcessEnv, () => {})).toBe(1);
  });

  it("never echoes error text, URLs or titles from the report", () => {
    const rep = report(
      t("unexpected", [{ status: "failed", error: { message: "https://secret-name-1.convex.cloud org_123" } }]),
    );
    const r = run(rep);
    expect(r.lines.join("\n") + r.summary).not.toMatch(/convex\.cloud|org_123|secret-name/);
    expect(renderSummary(evaluateReplayReport(rep))).not.toContain("secret-name");
  });
});
