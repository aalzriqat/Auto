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
    expect(aggregator.needs).toBe("unit-and-integration-slice");
    expect(aggregator.if).toBe("always()");
  });

  test("the aggregator's first step refuses anything but an all-success slice result", () => {
    const first = aggregator.steps[0];
    expect(first.id).toBe("slices");
    expect(first.if).toBeUndefined();
    expect(first.env?.SLICES_RESULT).toBe("${{ needs.unit-and-integration-slice.result }}");
    expect(first.run).toMatch(/if \[ "\$SLICES_RESULT" != "success" \]; then[\s\S]*exit 1/);
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
