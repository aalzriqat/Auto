import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  APPROVE_DOOR_DESCRIBE,
  APPROVE_DOOR_FILE,
  APPROVE_DOOR_PROJECT,
  APPROVE_DOOR_TITLE,
  approveDoorErrors,
  runCli,
} from "./assertApproveDoorRan.mjs";

type R = { status: string };
const spec = (title: string, status: string, results: R[], file = "accounting.spec.ts", projectName = "chromium") => ({
  title,
  file,
  tests: [{ status, projectName, results }],
});
// Mirrors the Playwright JSON shape: file suite > describe suite > spec.
const fileSuite = (file: string, describeTitle: string, ...specs: unknown[]) => ({
  title: file,
  file,
  suites: [{ title: describeTitle, file, specs }],
});
const report = (...specs: unknown[]) => ({
  suites: [
    fileSuite("accounting.spec.ts", APPROVE_DOOR_DESCRIBE, ...specs),
    { title: "other.spec.ts", file: "other.spec.ts", specs: [spec("other", "expected", [{ status: "passed" }], "other.spec.ts")] },
  ],
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
  it("a decoy in another file does not turn a real pass into a duplicate", () => {
    const decoy = spec(APPROVE_DOOR_TITLE, "expected", [{ status: "passed" }], "decoy.spec.ts");
    const r = {
      suites: [
        fileSuite("accounting.spec.ts", APPROVE_DOOR_DESCRIBE, pass),
        fileSuite("decoy.spec.ts", APPROVE_DOOR_DESCRIBE, decoy),
      ],
    };
    expect(approveDoorErrors(r)).toEqual([]);
  });
  describe("single-field negatives: each changes exactly ONE thing from the real passing entry", () => {
    const real = () => fileSuite("accounting.spec.ts", APPROVE_DOOR_DESCRIBE, pass);
    it("control: the unmodified entry passes", () => {
      expect(approveDoorErrors({ suites: [real()] })).toEqual([]);
    });
    it("spec.file differs (only the spec's file field)", () => {
      const s = spec(APPROVE_DOOR_TITLE, "expected", [{ status: "passed" }], "decoy.spec.ts");
      const suite = { title: "accounting.spec.ts", file: "accounting.spec.ts", suites: [{ title: APPROVE_DOOR_DESCRIBE, file: "accounting.spec.ts", specs: [s] }] };
      expect(approveDoorErrors({ suites: [suite] })).toEqual([expect.stringContaining("was not registered")]);
    });
    it("root file suite's file differs (only that field)", () => {
      const suite = { title: "accounting.spec.ts", file: "decoy.spec.ts", suites: [{ title: APPROVE_DOOR_DESCRIBE, file: "accounting.spec.ts", specs: [pass] }] };
      expect(approveDoorErrors({ suites: [suite] })).toEqual([expect.stringContaining("was not registered")]);
    });
    it("root file suite's title differs (only that field)", () => {
      const suite = { title: "decoy.spec.ts", file: "accounting.spec.ts", suites: [{ title: APPROVE_DOOR_DESCRIBE, file: "accounting.spec.ts", specs: [pass] }] };
      expect(approveDoorErrors({ suites: [suite] })).toEqual([expect.stringContaining("was not registered")]);
    });
    it("suffix path x/accounting.spec.ts (only the file)", () => {
      const s = spec(APPROVE_DOOR_TITLE, "expected", [{ status: "passed" }], "x/accounting.spec.ts");
      expect(approveDoorErrors(report(s))).toEqual([expect.stringContaining("was not registered")]);
    });
    it("nested describe of the same name (only the ancestry)", () => {
      const nested = {
        title: "accounting.spec.ts",
        file: "accounting.spec.ts",
        suites: [{ title: APPROVE_DOOR_DESCRIBE, file: "accounting.spec.ts", suites: [{ title: APPROVE_DOOR_DESCRIBE, file: "accounting.spec.ts", specs: [pass] }] }],
      };
      expect(approveDoorErrors({ suites: [nested] })).toEqual([expect.stringContaining("was not registered")]);
    });
    it("extra outer describe ancestor (only the ancestry)", () => {
      const outer = {
        title: "accounting.spec.ts",
        file: "accounting.spec.ts",
        suites: [{ title: "extra", file: "accounting.spec.ts", suites: [{ title: APPROVE_DOOR_DESCRIBE, file: "accounting.spec.ts", specs: [pass] }] }],
      };
      expect(approveDoorErrors({ suites: [outer] })).toEqual([expect.stringContaining("was not registered")]);
    });
    it("different describe (only the describe)", () => {
      const r = { suites: [fileSuite("accounting.spec.ts", "different describe", pass)] };
      expect(approveDoorErrors(r)).toEqual([expect.stringContaining("was not registered")]);
    });
    it("different project (only the project)", () => {
      const s = spec(APPROVE_DOOR_TITLE, "expected", [{ status: "passed" }], "accounting.spec.ts", "setup");
      expect(approveDoorErrors(report(s))).toEqual([expect.stringContaining("was not registered")]);
    });
  });
  it("accepts the repo-relative spec path as well as the testDir-relative one", () => {
    const s = spec(APPROVE_DOOR_TITLE, "expected", [{ status: "passed" }], APPROVE_DOOR_FILE);
    expect(approveDoorErrors(report(s))).toEqual([]);
  });
  it("RED: right file but wrong describe does not satisfy the proof", () => {
    const r = { suites: [fileSuite("accounting.spec.ts", "some other describe", pass)] };
    expect(approveDoorErrors(r)).toEqual([expect.stringContaining("was not registered")]);
  });
  it("RED: right file and describe but wrong project does not satisfy the proof", () => {
    const s = spec(APPROVE_DOOR_TITLE, "expected", [{ status: "passed" }], "accounting.spec.ts", "setup");
    expect(approveDoorErrors(report(s))).toEqual([expect.stringContaining("was not registered")]);
  });
  it("binds to the file, describe and project the spec registers", () => {
    expect(APPROVE_DOOR_FILE).toBe("playwright/tests/accounting.spec.ts");
    expect(APPROVE_DOOR_PROJECT).toBe("chromium");
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
  it("CLI: never prints raw report or parse-error text (public logs)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "approve-door-"));
    const lines: string[] = [];
    const capture = { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    try {
      const secret = "TENANT-SECRET-123";
      const garbled = path.join(dir, "garbled.json");
      writeFileSync(garbled, `{"suites": ${secret}`);
      expect(runCli([garbled], capture)).toBe(1);
      const hostile = path.join(dir, "hostile.json");
      const bad = spec(APPROVE_DOOR_TITLE, `${secret}\n::error::injected`, [{ status: `${secret}::warning::x` }]);
      writeFileSync(hostile, JSON.stringify(report(bad)));
      expect(runCli([hostile], capture)).toBe(1);
      const out = lines.join("\n");
      expect(out).not.toContain(secret);
      expect(out).not.toContain("injected");
      expect(out).not.toMatch(/Unexpected|position|token/);
      expect(out).not.toContain(garbled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the constants match the spec's registered test", () => {
    const src = readFileSync(path.join(process.cwd(), APPROVE_DOOR_FILE), "utf8");
    expect(src).toContain(`test("${APPROVE_DOOR_TITLE}"`);
    expect(src).toContain(`test.describe("${APPROVE_DOOR_DESCRIBE}"`);
    const cfg = readFileSync(path.join(process.cwd(), "playwright.config.ts"), "utf8");
    expect(cfg).toContain(`name: "${APPROVE_DOOR_PROJECT}"`);
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
