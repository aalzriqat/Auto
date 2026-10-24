import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { runInNewContext } from "node:vm";
import { verifyOpeningBrowserProof } from "./verifyOpeningBrowserProof.mjs";

const step = z.object({ name: z.string().optional(), run: z.string().optional(), if: z.string().optional() }).passthrough();
const workflow = z.object({ jobs: z.record(z.string(), z.object({
  needs: z.union([z.string(), z.array(z.string())]).optional(), if: z.string().optional(), steps: z.array(step),
}).passthrough()) }).passthrough();
const load = (file: string) => workflow.parse(parse(readFileSync(`.github/workflows/${file}`, "utf8")));
const names = ["owner opening form posts exact native allocations once", "finance opening form drafts for a different reviewer and posts once"];
const binding = { baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40), controllerSha: "d".repeat(40), runId: "gh-123-1" };
function report() {
  const errors: unknown[] = [];
  // Native --list JSON frame: gFYhBh reports a config-root-relative basename, not a repo-relative file.
  return { errors, config: { rootDir: path.resolve("playwright/opening-proof"),
    configFile: path.resolve("playwright.opening-proof.config.ts"), metadata: { openingProof: binding } },
    stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [{ specs: names.map(title => ({ title, file: "opening-onboarding.spec.ts", ok: true,
      tests: [{ projectName: "chromium", expectedStatus: "passed", status: "expected", results: [{ status: "passed", retry: 0, errors: [] }] }] })) }] };
}

describe("terminal opening evidence admission", () => {
  it("admits both actual passed case records with their exact provenance", () => {
    expect(verifyOpeningBrowserProof(report(), binding)).toMatchObject({ checked: true, passed: 2 });
  });
  it.each(["missing", "duplicate", "skipped", "flaky", "errors", "binding"])("refuses %s result evidence", mutation => {
    const value = report();
    if (mutation === "missing") value.suites[0].specs.pop();
    if (mutation === "duplicate") value.suites[0].specs[1].title = names[0];
    if (mutation === "skipped") value.suites[0].specs[0].tests[0].results[0].status = "skipped";
    if (mutation === "flaky") value.suites[0].specs[0].tests[0].results[0].retry = 1;
    if (mutation === "errors") value.errors.push({ message: "synthetic reporter failure" });
    if (mutation === "binding") value.config.metadata.openingProof = { ...binding, testedSha: "e".repeat(40) };
    expect(() => verifyOpeningBrowserProof(value, binding)).toThrow();
  });
  it.each(["root", "config", "traversal", "absolute"])("refuses a %s file-binding substitution", mutation => {
    const value = report();
    if (mutation === "root") value.config.rootDir = path.resolve("playwright/tests");
    if (mutation === "config") value.config.configFile = path.resolve("playwright.config.ts");
    if (mutation === "traversal") value.suites[0].specs[0].file = "../opening-proof/opening-onboarding.spec.ts";
    if (mutation === "absolute") value.suites[0].specs[0].file = path.resolve("playwright/opening-proof/opening-onboarding.spec.ts");
    expect(() => verifyOpeningBrowserProof(value, binding)).toThrow();
  });
  it("refuses the measured collection-only frame as runtime proof", () => {
    const value = report();
    value.stats.expected = 0; value.stats.skipped = 2;
    for (const spec of value.suites[0].specs) spec.tests[0].results = [];
    expect(() => verifyOpeningBrowserProof(value, binding)).toThrow();
  });
  it.each(["rootDir", "configFile"])("refuses missing report %s without a path fallback", field => {
    const value = report();
    const config = Object.fromEntries(Object.entries(value.config).filter(([key]) => key !== field));
    expect(() => verifyOpeningBrowserProof({ ...value, config }, binding)).toThrow();
  });
  it("selects the isolated file outside both original discovery roots", () => {
    const file = path.resolve("playwright/opening-proof/opening-onboarding.spec.ts");
    for (const config of ["playwright.config.ts", "playwright.scenarios.config.ts"]) {
      const dir = /testDir:\s*["']([^"']+)["']/.exec(readFileSync(config, "utf8"))?.[1];
      if (!dir) throw new Error("Existing discovery root unavailable");
      expect(path.relative(path.resolve(dir), file).startsWith(".."), config).toBe(true);
    }
    const config = readFileSync("playwright.opening-proof.config.ts", "utf8");
    expect(/testDir:\s*["']([^"']+)["']/.exec(config)?.[1]).toBe("./playwright/opening-proof");
    expect(/testMatch:\s*["']([^"']+)["']/.exec(config)?.[1]).toBe(path.basename(file));
  });
  it("waits for the whole worker matrix and gates both verdict branches plus cleanup", () => {
    const jobs = load("browser-attack-swarm.yml").jobs;
    expect(jobs["opening-proof"].needs).toEqual(["prepare", "candidate-build", "trusted-e2e", "attack-worker", "opening-prepare", "opening-build"]);
    expect(jobs["opening-proof"].if).toContain("needs.attack-worker.result == 'skipped'");
    expect(jobs.verdict.needs).toContain("opening-proof");
    expect(jobs.verdict.needs).toContain("opening-cleanup");
    expect(jobs["preview-cleanup"].needs).toContain("opening-proof");
    expect(jobs["preview-cleanup"].if).toContain("always()");
    const publish = jobs.verdict.steps.find(item => item.name === "Publish authoritative trusted swarm verdict");
    expect(publish?.run).toContain('[ "$OPENING_RESULT" = "success" ]');
    expect(publish?.run).toContain('[ "$OPENING_CHECKED" = "true" ]');
    expect(publish?.run).toContain('[ "$OPENING_CLEANUP_RESULT" = "success" ]');
    const steps = jobs["opening-proof"].steps;
    const strict = steps.findIndex(item => item.run?.includes("--assert-only"));
    const execute = steps.findIndex(item => item.run?.includes("-c playwright.opening-proof.config.ts"));
    expect(strict).toBeGreaterThanOrEqual(0); expect(strict).toBeLessThan(execute);
    expect(steps.slice(execute + 1).some(item => item.run?.includes("--assert-only"))).toBe(false);
  });
  it.each([
    { impact: "true", attack: "success", runs: true },
    { impact: "false", attack: "skipped", runs: true },
    { impact: "true", attack: "skipped", runs: false },
    { impact: "false", attack: "success", runs: false },
    { impact: "false", attack: "failure", runs: false },
  ])("admits the actual terminal graph only for impact=$impact / workers=$attack", ({ impact, attack, runs }) => {
    const jobs = load("browser-attack-swarm.yml").jobs;
    const context = {
      always: () => true,
      cancelled: () => false,
      needs: { prepare: { result: "success", outputs: { should_run: impact } },
        "candidate-build": { result: "success" }, "trusted-e2e": { result: "success" }, "attack-worker": { result: attack },
        "opening-prepare": { result: "success", outputs: { creation_attempted: "true" } }, "opening-build": { result: "success" } },
      github: { repository: "synthetic/repository", event: { workflow_run: { event: "pull_request",
        head_repository: { full_name: "synthetic/repository" }, pull_requests: [{ number: 1 }] } } },
    };
    // These actual guards use the shared JS/GitHub boolean/equality subset only.
    const admitted = (name: string): unknown => runInNewContext(
      (jobs[name].if ?? "false").replace(/needs\.([\w-]+)/g, 'needs["$1"]'), context, { timeout: 100 });
    expect(admitted("candidate-build")).toBe(true);
    expect(admitted("trusted-e2e")).toBe(true);
    expect(admitted("opening-prepare")).toBe(runs);
    context.needs["opening-prepare"].result = runs ? "success" : "skipped";
    expect(jobs["opening-build"].if).toContain("!cancelled()");
    expect(admitted("opening-build")).toBe(runs);
    context.needs["opening-build"].result = runs ? "success" : "skipped";
    expect(admitted("opening-proof")).toBe(runs);
    // Cleanup must still attempt retirement after provisioning/build failure, never skip it as success.
    context.needs["opening-prepare"].result = "failure";
    context.needs["opening-build"].result = "failure";
    expect(admitted("opening-build")).toBe(false);
    expect(admitted("opening-proof")).toBe(false);
    expect(admitted("opening-cleanup")).toBe(true);
    context.cancelled = () => true;
    expect(admitted("opening-build")).toBe(false);
    context.needs["opening-prepare"].outputs.creation_attempted = "false";
    expect(admitted("opening-cleanup")).toBe(false);
  });
  it("places the main opening phase after all original hunters and before cleanup", () => {
    const steps = load("deal-scenarios-e2e.yml").jobs.scenarios.steps;
    const matrix = steps.findIndex(item => item.run?.includes("-c playwright.scenarios.config.ts"));
    const opening = steps.findIndex(item => item.run?.includes("-c playwright.opening-proof.config.ts"));
    const cleanup = steps.findIndex(item => item.name === "Delete the disposable preview");
    expect(matrix).toBeGreaterThanOrEqual(0); expect(opening).toBeGreaterThan(matrix); expect(cleanup).toBeGreaterThan(opening);
    expect(steps[opening].if).toBeUndefined();
    expect(steps[opening].run?.indexOf("--assert-only")).toBeLessThan(steps[opening].run?.indexOf("-c playwright.opening-proof.config.ts") ?? -1);
  });
});
