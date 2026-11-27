/**
 * SCRUM-359: the required `unit-and-integration` check is an aggregator over
 * parallel coverage slices. These assertions pin the parts that make it fail
 * closed; losing any one of them lets a partial census report green.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
};
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { slice?: number[] } };
  steps: Step[];
};

const workflow = parseYaml(
  fs.readFileSync(path.resolve(__dirname, "..", ".github", "workflows", "test.yml"), "utf8"),
) as { jobs: Record<string, Job> };
const slices = workflow.jobs["unit-and-integration-slice"];
const aggregator = workflow.jobs["unit-and-integration"];

function step(job: Job, name: string): Step {
  const found = job.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Workflow step not found: ${name}`);
  return found;
}

describe("parallel coverage workflow (SCRUM-359)", () => {
  test("the required check name is the aggregator, and it runs after every slice even on failure", () => {
    expect(aggregator).toBeDefined();
    expect(aggregator.name).toBeUndefined();
    expect(aggregator.needs).toEqual(["unit-plan", "unit-and-integration-slice"]);
    expect(aggregator.if).toBe("always()");
  });

  test("the aggregator's first step refuses anything but an all-success slice result", () => {
    const first = aggregator.steps[0];
    expect(first.id).toBe("slices");
    expect(first.if).toBeUndefined();
    expect(first.env?.SLICES_RESULT).toBe("${{ needs.unit-and-integration-slice.result }}");
    expect(first.env?.PLAN_RESULT).toBe("${{ needs.unit-plan.result }}");
    expect(first.run).toMatch(/if \[ "\$SLICES_RESULT" != "success" \]; then[\s\S]*exit 1/);
    expect(first.run).toMatch(/if \[ "\$PLAN_RESULT" != "success" \]; then[\s\S]*exit 1/);
  });

  test("the aggregator's first step also refuses an invalid plan mode, exactly like the slice's", () => {
    expect(aggregator.steps[0].env?.PLAN_RESULT).toBe("${{ needs.unit-plan.result }}");
    expect(aggregator.steps[0].run).toMatch(/case "\$PLAN_MODE" in\s+full\|docs-only\) ;;\s+\*\) echo[^\n]*exit 1 ;;/);
    expect(slices.steps[0].run).toMatch(/case "\$PLAN_MODE" in\s+full\|docs-only\) ;;\s+\*\) echo[^\n]*exit 1 ;;/);
  });

  test("the matrix, the slice spec and the slice count agree", () => {
    const matrix = slices.strategy?.matrix?.slice ?? [];
    expect(matrix).toEqual(Array.from({ length: matrix.length }, (_, i) => i + 1));
    expect(matrix.length).toBeGreaterThanOrEqual(2);
    const run = step(slices, "Run unit + integration tests with coverage");
    expect(run.env?.AUTOFLOW_COVERAGE_PHASE).toBe("run");
    expect(run.env?.AUTOFLOW_COVERAGE_SLICE).toBe(`\${{ matrix.slice }}/${matrix.length}`);
    expect(slices.name).toBe(`unit-and-integration slice \${{ matrix.slice }}/${matrix.length}`);
    // The plain (non-coverage) authority run from `pnpm test:coverage` happens once.
    expect(run.run).toContain('if [ "${{ matrix.slice }}" = "1" ]; then pnpm test:unified-deal-authority; fi');
    expect(run.run).toContain("set -euo pipefail");
  });

  test("slices overlap at most two batch processes, and the merge stays a single process", () => {
    const run = step(slices, "Run unit + integration tests with coverage");
    expect(run.env?.VITEST_COVERAGE_CONCURRENCY).toBe("2");
    const merge = step(aggregator, "Merge coverage from every slice");
    expect(merge.env?.VITEST_COVERAGE_CONCURRENCY).toBeUndefined();
  });

  test("slices and aggregator use separate unit and Sonar blob directories and the same modes", () => {
    const run = step(slices, "Run unit + integration tests with coverage").run ?? "";
    const merge = step(aggregator, "Merge coverage from every slice");
    for (const script of [run, merge.run ?? ""]) {
      expect(script).toContain(
        "AUTOFLOW_COVERAGE_BLOB_DIR=coverage-blobs/unit node scripts/runVitestCoverageShards.mjs unit",
      );
      expect(script).toContain(
        "AUTOFLOW_COVERAGE_BLOB_DIR=coverage-blobs/sonar node scripts/runVitestCoverageShards.mjs sonar",
      );
    }
    expect(merge.env?.AUTOFLOW_COVERAGE_PHASE).toBe("merge");
    // Sonar merges last, so `coverage/` holds the Sonar LCOV exactly as before.
    expect((merge.run ?? "").indexOf("unit")).toBeLessThan((merge.run ?? "").indexOf("sonar"));
  });

  test("every slice's blobs are uploaded and all of them are downloaded", () => {
    const upload = step(slices, "Upload coverage blobs");
    expect(upload.with?.name).toBe("coverage-blobs-${{ matrix.slice }}");
    expect(upload.with?.path).toBe("coverage-blobs/");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    const download = step(aggregator, "Download coverage blobs");
    expect(download.with?.pattern).toBe("coverage-blobs-*");
    expect(download.with?.path).toBe("coverage-blobs");
    expect(download.with?.["merge-multiple"]).toBe(true);
  });

  test("the Sonar hand-off artifact keeps its name and is only produced after all slices passed", () => {
    const upload = step(aggregator, "Upload coverage report");
    expect(upload.with?.name).toBe("coverage-report");
    expect(upload.with?.path).toBe("coverage/");
    expect(upload.if).toContain("steps.slices.outcome == 'success'");
    const record = step(aggregator, "Record the tested merge for trusted Sonar");
    expect(record.if).toContain("steps.slices.outcome == 'success'");
    expect(record.run).toContain("coverage/tested-merge-sha.txt");
  });
});

describe("shorter PR checks (SCRUM-1025)", () => {
  const plan = workflow.jobs["unit-plan"];
  const docsOnlyGuard = "env.PLAN_MODE != 'docs-only'";

  test("the slice count is 12 and every required slice name still reports", () => {
    expect(slices.strategy?.matrix?.slice).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(slices.name).toBe("unit-and-integration slice ${{ matrix.slice }}/12");
    expect(slices["fail-fast" as never]).toBeUndefined();
    expect(slices.strategy?.["fail-fast"]).toBe(false);
  });

  test("a slice runs even when the plan failed and its first step fails it", () => {
    expect(slices.needs).toBe("unit-plan");
    expect(slices.if).toBe("always()");
    const first = slices.steps[0];
    expect(first.name).toBe("Require a successful plan");
    expect(first.if).toBeUndefined();
    expect(first.env?.PLAN_RESULT).toBe("${{ needs.unit-plan.result }}");
    expect(first.run).toMatch(/if \[ "\$PLAN_RESULT" != "success" \]; then[\s\S]*exit 1/);
    expect(first.run).toMatch(/full\|docs-only\) ;;[\s\S]*exit 1/);
  });

  test("only STEPS are skipped for docs-only: no job-level skip, no path filter", () => {
    const triggers = (parseYaml(fs.readFileSync(path.resolve(__dirname, "..", ".github", "workflows", "test.yml"), "utf8")) as { on: Record<string, Record<string, unknown> | null> }).on;
    for (const event of ["push", "pull_request"]) {
      expect(Object.keys(triggers[event] ?? {}), event).not.toEqual(expect.arrayContaining(["paths"]));
      expect(Object.keys(triggers[event] ?? {}), event).not.toEqual(expect.arrayContaining(["paths-ignore"]));
    }
    for (const job of [slices, aggregator]) {
      expect(job.if).toBe("always()");
      expect(job.env?.PLAN_MODE).toBe("${{ needs.unit-plan.outputs.mode }}");
    }
    const run = step(slices, "Run unit + integration tests with coverage");
    expect(run.if).toBe(docsOnlyGuard);
    expect(step(slices, "Upload coverage blobs").if).toBe(docsOnlyGuard);
    expect(step(aggregator, "Merge coverage from every slice").if).toBe(docsOnlyGuard);
    expect(step(aggregator, "Mobile coverage for Sonar").if).toBe(docsOnlyGuard);
    expect(step(aggregator, "Shared coverage for Sonar").if).toBe(docsOnlyGuard);
  });

  test("there is no impacted mode, no selection input and no schedule or manual trigger in Tests", () => {
    const raw = fs.readFileSync(path.resolve(__dirname, "..", ".github", "workflows", "test.yml"), "utf8");
    expect(raw).not.toMatch(/impacted|AUTOFLOW_COVERAGE_SELECTION|unit-selection|workflow_call|notify-nightly/);
    const triggers = (parseYaml(raw) as { on: Record<string, unknown> }).on;
    expect(Object.keys(triggers).sort()).toEqual(["pull_request", "push"]);
  });

  test("the plan runs the selector on every event, with Node only and no install", () => {
    expect(plan.permissions).toEqual({ contents: "read", actions: "read" });
    const select = step(plan, "Select the unit tests to run");
    expect(select.run).toContain('--event "$GITHUB_EVENT_NAME"');
    expect(select.if).toBeUndefined();
    expect(plan.steps.some((candidate) => /pnpm/.test(`${candidate.run ?? ""}${candidate.uses ?? ""}`))).toBe(false);
  });
  test("docs-only re-uses the base commit's coverage and re-stamps it for this merge", () => {
    const reuse = step(aggregator, "Re-use the base commit's coverage report (docs-only)");
    expect(reuse.if).toBe("env.PLAN_MODE == 'docs-only'");
    expect(reuse.with?.name).toBe("coverage-report");
    expect(reuse.with?.["run-id"]).toBe("${{ needs.unit-plan.outputs.base_run_id }}");
    expect(aggregator.permissions?.actions).toBe("read");
    const stamp = step(aggregator, "Re-stamp the re-used coverage for this merge (docs-only)");
    expect(stamp.run).toContain("scripts/ci/restampReusedCoverage.mjs");
    expect(step(aggregator, "Record the tested merge for trusted Sonar").if).toContain(docsOnlyGuard);
    expect(step(aggregator, "Upload coverage report").if).toContain("steps.slices.outcome == 'success'");
  });

  test("docs-only: the re-stamp runs on the pinned Node, and only a successful re-stamp is uploaded", () => {
    const node = step(aggregator, "Use Node.js (docs-only, no package cache)");
    expect(node.if).toBe("env.PLAN_MODE == 'docs-only'");
    expect(node.with?.["node-version"]).toBe("22.21.1");
    expect(node.with?.cache).toBeUndefined();
    const stamp = step(aggregator, "Re-stamp the re-used coverage for this merge (docs-only)");
    expect(stamp.id).toBe("restamp");
    const upload = step(aggregator, "Upload coverage report");
    expect(upload.if).toBe("always() && steps.slices.outcome == 'success' && (env.PLAN_MODE != 'docs-only' || steps.restamp.outcome == 'success')");
  });

  test("the banner never says Full suite for a failed plan or an unknown mode", () => {
    const banner = step(aggregator, "State which tests this run covered");
    expect(banner.env?.PLAN_RESULT).toBe("${{ needs.unit-plan.result }}");
    const run = banner.run ?? "";
    expect(run).toMatch(/if \[ "\$PLAN_RESULT" != "success" \]; then[\s\S]*concluded[\s\S]*exit 0[\s\S]*fi/);
    expect(run).toMatch(/full\)\s+echo "Full suite\."/);
    expect(run).toMatch(/\*\)\s+echo "The plan produced no valid mode/);
  });

  test("the Sonar merge writes only the reports something reads", () => {
    const reporters = step(aggregator, "Merge coverage from every slice").env?.AUTOFLOW_COVERAGE_MERGE_REPORTERS ?? "";
    expect(reporters.split(",")).toEqual(["lcov", "json-summary", "text-summary"]);
  });

  test("the provenance and the step summary say which tests this run covered", () => {
    const manifest = step(aggregator, "Record the tested merge for trusted Sonar");
    expect(manifest.run ?? "").toContain("mode: process.env.PLAN_MODE");
    expect(manifest.run ?? "").toContain("reusedFromSha: null");
    const banner = step(aggregator, "State which tests this run covered");
    expect(banner.if).toBe("always()");
    expect(banner.run ?? "").toContain("GITHUB_STEP_SUMMARY");
    expect(banner.run ?? "").toContain("no unit test ran");
  });

  test("every required check name other than the slices is unchanged and still a job of this workflow", () => {
    for (const job of ["unit-and-integration", "type-check", "convex-backend", "lint", "secret-scan", "dealer-worker", "production-build", "mobile-and-shared", "dependency-audit"]) {
      expect(workflow.jobs[job], job).toBeDefined();
      expect(workflow.jobs[job].name, job).toBeUndefined();
    }
  });
});
