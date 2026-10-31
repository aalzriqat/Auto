import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(__dirname, "..");
const MIN_SCAN_BUDGET_MINUTES = 40;
const TEST_WORKFLOW = path.join(ROOT, ".github", "workflows", "test.yml");
const SONAR_MAIN_WORKFLOW = path.join(ROOT, ".github", "workflows", "sonar-main.yml");

function source(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function namedWorkflowStep(workflow: string, name: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) throw new Error(`Workflow step not found: ${name}`);

  const nextStepOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^\s*-\s+(?:name|uses):/.test(line));
  const end = nextStepOffset === -1 ? lines.length : start + 1 + nextStepOffset;
  return lines.slice(start, end).join("\n");
}

describe("Sonar coverage resource contract", () => {
  test("NEGATIVE CONTROL: a later step cannot supply the coverage step heap ceiling", () => {
    const misleadingWorkflow = `
      - name: Generate coverage for Sonar
        run: pnpm test:coverage:sonar
      - name: Later step
        env:
          NODE_OPTIONS: --max-old-space-size=5632
    `;

    expect(namedWorkflowStep(misleadingWorkflow, "Generate coverage for Sonar")).not.toMatch(
      /NODE_OPTIONS:\s*--max-old-space-size=5632/,
    );
  });

  test("main Sonar coverage uses the same bounded heap ceiling as PR coverage", () => {
    const prCoverage = source(TEST_WORKFLOW);
    const mainCoverage = source(SONAR_MAIN_WORKFLOW);

    expect(namedWorkflowStep(prCoverage, "Run unit + integration tests with coverage")).toMatch(
      /NODE_OPTIONS:\s*--max-old-space-size=5632/,
    );
    expect(namedWorkflowStep(mainCoverage, "Generate coverage for Sonar")).toMatch(
      /NODE_OPTIONS:\s*--max-old-space-size=5632/,
    );
  });

  test("SCRUM-359 / SCRUM-763: the aggregator's final V8 merge keeps the same heap ceiling", () => {
    expect(namedWorkflowStep(source(TEST_WORKFLOW), "Merge coverage from every slice")).toMatch(
      /NODE_OPTIONS:\s*--max-old-space-size=5632/,
    );
    expect(namedWorkflowStep(source(SONAR_MAIN_WORKFLOW), "Merge coverage from every slice")).toMatch(
      /NODE_OPTIONS:\s*--max-old-space-size=5632/,
    );
  });

  test("SCRUM-384 / SCRUM-763: main Sonar job budget is about twice a normal ~20-min run", () => {
    const workflow = parseYaml(source(SONAR_MAIN_WORKFLOW)) as {
      jobs: { scan: { "timeout-minutes"?: number } };
    };
    expect(workflow.jobs.scan["timeout-minutes"]).toBeGreaterThanOrEqual(MIN_SCAN_BUDGET_MINUTES);
  });

  test("SCRUM-763: Sonar Main parallelizes coverage into 4 slices and fails closed in the scan aggregator", () => {
    type Step = {
      name?: string;
      id?: string;
      if?: string;
      run?: string;
      uses?: string;
      env?: Record<string, string>;
      with?: Record<string, unknown>;
    };
    type Job = {
      name?: string;
      needs?: string | string[];
      if?: string;
      "timeout-minutes"?: number;
      strategy?: { "fail-fast"?: boolean; matrix?: { slice?: number[] } };
      steps: Step[];
    };

    const workflow = parseYaml(source(SONAR_MAIN_WORKFLOW)) as {
      jobs: Record<string, Job>;
    };

    const slices = workflow.jobs["coverage-slice"];
    const scan = workflow.jobs.scan;

    expect(slices).toBeDefined();
    expect(slices.if).toBe("github.ref == 'refs/heads/main'");
    expect(slices["timeout-minutes"]).toBeGreaterThanOrEqual(30);
    expect(slices.strategy?.["fail-fast"]).toBe(false);
    expect(slices.strategy?.matrix?.slice).toEqual([1, 2, 3, 4]);

    const sliceRun = slices.steps.find((s) => s.name === "Generate coverage for Sonar");
    expect(sliceRun).toBeDefined();
    expect(sliceRun?.env?.AUTOFLOW_COVERAGE_PHASE).toBe("run");
    expect(sliceRun?.env?.AUTOFLOW_COVERAGE_SLICE).toBe("${{ matrix.slice }}/4");
    expect(sliceRun?.env?.VITEST_COVERAGE_CONCURRENCY).toBe("2");
    expect(sliceRun?.env?.NODE_OPTIONS).toBe("--max-old-space-size=5632");
    expect(sliceRun?.run).toContain("AUTOFLOW_COVERAGE_BLOB_DIR=coverage-blobs/sonar node scripts/runVitestCoverageShards.mjs sonar");

    const sliceUpload = slices.steps.find((s) => s.name === "Upload coverage blobs");
    expect(sliceUpload?.with?.name).toBe("coverage-blobs-${{ matrix.slice }}");
    expect(sliceUpload?.with?.path).toBe("coverage-blobs/");
    expect(sliceUpload?.with?.["if-no-files-found"]).toBe("error");

    expect(scan).toBeDefined();
    expect(scan.needs).toBe("coverage-slice");
    expect(scan.if).toBe("always() && github.ref == 'refs/heads/main'");
    expect(scan["timeout-minutes"]).toBeGreaterThanOrEqual(MIN_SCAN_BUDGET_MINUTES);

    const first = scan.steps[0];
    expect(first.id).toBe("slices");
    expect(first.env?.SLICES_RESULT).toBe("${{ needs.coverage-slice.result }}");
    expect(first.run).toMatch(/if \[ "\$SLICES_RESULT" != "success" \]; then[\s\S]*exit 1/);

    const checkout = scan.steps.find((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);

    const download = scan.steps.find((s) => s.name === "Download coverage blobs");
    expect(download?.with?.pattern).toBe("coverage-blobs-*");
    expect(download?.with?.path).toBe("coverage-blobs");
    expect(download?.with?.["merge-multiple"]).toBe(true);

    const merge = scan.steps.find((s) => s.name === "Merge coverage from every slice");
    expect(merge?.env?.AUTOFLOW_COVERAGE_PHASE).toBe("merge");
    expect(merge?.env?.NODE_OPTIONS).toBe("--max-old-space-size=5632");
    expect(merge?.run).toContain("AUTOFLOW_COVERAGE_BLOB_DIR=coverage-blobs/sonar node scripts/runVitestCoverageShards.mjs sonar");

    const scanStep = scan.steps.find((s) => s.name === "SonarCloud scan");
    expect(scanStep?.uses).toBe("SonarSource/sonarqube-scan-action@22918119ff8e1ca75a623e15c8296b6ea4fbe28f");
  });
});
