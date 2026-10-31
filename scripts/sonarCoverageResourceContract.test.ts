import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(__dirname, "..");
const MIN_SCAN_BUDGET_MINUTES = 30;
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
  test("NEGATIVE CONTROL: an unverified coverage artifact cannot bypass validator step", () => {
    const misleadingWorkflow = `
      - name: Download coverage report from Tests
        uses: actions/download-artifact@v4
      - name: SonarCloud scan
        uses: SonarSource/sonarqube-scan-action@v8.2.1
    `;

    expect(misleadingWorkflow).not.toMatch(/validateSonarMainCoverage\.mjs/);
  });

  test("producer Tests workflow generates coverage with bounded heap ceiling", () => {
    const testWf = source(TEST_WORKFLOW);

    expect(namedWorkflowStep(testWf, "Run unit + integration tests with coverage")).toMatch(
      /NODE_OPTIONS:\s*--max-old-space-size=5632/,
    );
    expect(namedWorkflowStep(testWf, "Merge coverage from every slice")).toMatch(
      /NODE_OPTIONS:\s*--max-old-space-size=5632/,
    );
  });

  test("producer Tests workflow records provenance manifest and tested merge SHA for trusted Sonar", () => {
    const testWf = source(TEST_WORKFLOW);
    const step = namedWorkflowStep(testWf, "Record the tested merge for trusted Sonar");

    expect(step).toMatch(/if:\s*always\(\)\s*&&\s*steps\.slices\.outcome\s*==\s*'success'/);
    expect(step).toMatch(/tested-merge-sha\.txt/);
    expect(step).toMatch(/coverage-provenance\.json/);
  });

  test("SCRUM-764: Sonar Main reuses Tests coverage artifact with producer binding and fail-closed validation", () => {
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
      if?: string;
      "timeout-minutes"?: number;
      steps: Step[];
    };
    type Workflow = {
      name?: string;
      on?: {
        workflow_run?: {
          workflows?: string[];
          branches?: string[];
          types?: string[];
        };
        workflow_dispatch?: unknown;
      };
      permissions?: Record<string, string>;
      jobs: Record<string, Job>;
    };

    const workflow = parseYaml(source(SONAR_MAIN_WORKFLOW)) as Workflow;

    // Trigger contract: triggers on workflow_run of Tests on main
    expect(workflow.on?.workflow_run?.workflows).toContain("Tests");
    expect(workflow.on?.workflow_run?.branches).toContain("main");
    expect(workflow.on?.workflow_run?.types).toContain("completed");
    expect(workflow.on?.workflow_dispatch).toBeDefined();

    // Permissions contract: requires contents: read and actions: read (for artifact download)
    expect(workflow.permissions?.contents).toBe("read");
    expect(workflow.permissions?.actions).toBe("read");

    const scan = workflow.jobs.scan;
    expect(scan).toBeDefined();
    expect(scan["timeout-minutes"]).toBeGreaterThanOrEqual(MIN_SCAN_BUDGET_MINUTES);
    // Job-level env must NOT expose SONAR_TOKEN
    expect((scan as { env?: Record<string, string> }).env?.SONAR_TOKEN).toBeUndefined();

    // Step 1: Checkout target commit
    const checkout = scan.steps.find((s) => s.name === "Checkout target commit");
    expect(checkout?.uses).toBe("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);

    // Step 2: Install dependencies to preserve full AST / TSConfig compiler resolution
    const install = scan.steps.find((s) => s.name === "Install dependencies without lifecycle scripts");
    expect(install).toBeDefined();
    expect(install?.run).toContain("pnpm install --frozen-lockfile --ignore-scripts");

    // Step 3: Resolve and verify producer run
    const resolveProducer = scan.steps.find((s) => s.name === "Resolve and verify producer run");
    expect(resolveProducer?.id).toBe("producer");
    expect(resolveProducer?.run).toContain("verifyProducerRun");

    // Step 4: Download coverage report
    const download = scan.steps.find((s) => s.name === "Download coverage report from Tests");
    expect(download?.uses).toBe("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(download?.with?.name).toBe("coverage-report");

    // Step 5: Validate coverage artifact provenance and census
    const validate = scan.steps.find((s) => s.name === "Validate coverage artifact provenance and census");
    expect(validate?.run).toContain("node scripts/validateSonarMainCoverage.mjs coverage . \"$EXPECTED_SHA\"");

    // Step 6: SonarCloud scan scoped with SONAR_TOKEN and explicit revision binding
    const scanStep = scan.steps.find((s) => s.name === "SonarCloud scan");
    expect(scanStep?.uses).toBe("SonarSource/sonarqube-scan-action@22918119ff8e1ca75a623e15c8296b6ea4fbe28f");
    expect(scanStep?.env?.SONAR_TOKEN).toBe("${{ secrets.SONAR_TOKEN }}");
    expect(String(scanStep?.with?.args ?? "")).toContain("-Dsonar.scm.revision=");
    expect(String(scanStep?.with?.args ?? "")).toContain("-Dsonar.branch.name=main");
  });
});
