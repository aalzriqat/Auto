import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APPROVE_DOOR_TITLE, approveDoorErrors, runCli } from "./assertApproveDoorRan.mjs";

type R = { status: string };
const spec = (title: string, status: string, results: R[]) => ({
  title,
  tests: [{ status, results }],
});
const report = (...specs: unknown[]) => ({
  suites: [{ suites: [{ specs }] }, { specs: [spec("other", "expected", [{ status: "passed" }])] }],
});
const pass = spec(APPROVE_DOOR_TITLE, "expected", [{ status: "passed" }]);

describe("assertApproveDoorRan (SCRUM-795)", () => {
  it("accepts exactly one passed approve-door test", () => {
    expect(approveDoorErrors(report(pass))).toEqual([]);
  });
  it("accepts a pass on retry (flaky)", () => {
    const s = spec(APPROVE_DOOR_TITLE, "flaky", [{ status: "failed" }, { status: "passed" }]);
    expect(approveDoorErrors(report(s))).toEqual([]);
  });
  it("RED: test not registered (flag dropped)", () => {
    expect(approveDoorErrors(report())).toEqual([expect.stringContaining("was not registered")]);
  });
  it("RED: skipped", () => {
    const s = spec(APPROVE_DOOR_TITLE, "skipped", [{ status: "skipped" }]);
    expect(approveDoorErrors(report(s))).toEqual(["approve-door test was skipped"]);
  });
  it("RED: failed", () => {
    const s = spec(APPROVE_DOOR_TITLE, "unexpected", [{ status: "failed" }, { status: "failed" }]);
    expect(approveDoorErrors(report(s))).toEqual([expect.stringContaining("did not pass")]);
  });
  it("RED: timed out", () => {
    const s = spec(APPROVE_DOOR_TITLE, "unexpected", [{ status: "timedOut" }]);
    expect(approveDoorErrors(report(s))).toEqual([expect.stringContaining("did not pass")]);
  });
  it("RED: duplicate", () => {
    expect(approveDoorErrors(report(pass, pass))).toEqual([expect.stringContaining("2 times")]);
  });
  it("RED: malformed report", () => {
    expect(approveDoorErrors({})).toEqual([expect.stringContaining("malformed")]);
    expect(approveDoorErrors(null)).toEqual([expect.stringContaining("malformed")]);
  });
  it("CLI: exit codes for missing file, red and green reports", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "approve-door-"));
    const quiet = { log: () => undefined, error: () => undefined };
    try {
      const good = path.join(dir, "good.json");
      const bad = path.join(dir, "bad.json");
      writeFileSync(good, JSON.stringify(report(pass)));
      writeFileSync(bad, JSON.stringify(report()));
      expect(runCli([good], quiet)).toBe(0);
      expect(runCli([bad], quiet)).toBe(1);
      expect(runCli([path.join(dir, "nope.json")], quiet)).toBe(1);
      expect(runCli([], quiet)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the title constant matches the spec's registered test title", () => {
    const src = readFileSync(path.join(process.cwd(), "playwright/tests/accounting.spec.ts"), "utf8");
    expect(src).toContain(`test("${APPROVE_DOOR_TITLE}"`);
  });
});

describe("trusted-main-e2e wiring for the approve-door assertion", () => {
  type Step = { name?: string; id?: string; run?: string; if?: string; env?: Record<string, unknown> };
  const text = readFileSync(path.join(process.cwd(), ".github/workflows/trusted-main-e2e.yml"), "utf8");
  const steps = Object.values((parse(text) as { jobs: Record<string, { steps: Step[] }> }).jobs).flatMap(
    (j) => j.steps,
  );
  const idx = (re: RegExp) => steps.findIndex((s) => re.test(s.run?.trim() ?? ""));

  it("runs the assertion after Playwright, with always(), on the JSON report", () => {
    const run = idx(/^pnpm exec playwright test\s*$/);
    const assertIdx = idx(/^node scripts\/assertApproveDoorRan\.mjs playwright-json\/results\.json\s*$/);
    expect(run).toBeGreaterThanOrEqual(0);
    expect(assertIdx).toBeGreaterThan(run);
    expect(steps[assertIdx].if).toMatch(/always\(\)/);
    expect(steps[assertIdx].if).toContain(`steps.${steps[run].id}.conclusion != 'skipped'`);
  });

  it("sets the seed flag on both the bootstrap and the run step", () => {
    const boot = steps[idx(/scripts\/e2ePreviewBootstrap\.mjs\s*$/)];
    const run = steps[idx(/^pnpm exec playwright test\s*$/)];
    expect(boot.env?.E2E_SEED_LEGACY_MANUAL_JOURNAL).toBe("1");
    expect(run.env?.E2E_SEED_LEGACY_MANUAL_JOURNAL).toBe("1");
  });

  it("playwright config emits the JSON report in CI at the path the step reads", () => {
    const cfg = readFileSync(path.join(process.cwd(), "playwright.config.ts"), "utf8");
    expect(cfg).toContain('["json", { outputFile: "playwright-json/results.json" }]');
  });
});
