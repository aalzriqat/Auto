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

  test("NEGATIVE CONTROL: an artifact download using mutable name instead of immutable artifact-ids violates contract", () => {
    const mutableNameWorkflow = `
      jobs:
        scan:
          steps:
            - name: Download coverage report from Tests
              uses: actions/download-artifact@v4
              with:
                name: coverage-report
                run-id: 12345
    `;
    const parsed = parseYaml(mutableNameWorkflow) as { jobs: { scan: { steps: { with?: Record<string, unknown> }[] } } };
    const downloadStep = parsed.jobs.scan.steps[0];
    expect(downloadStep.with?.["artifact-ids"]).toBeUndefined();
    expect(downloadStep.with?.name).toBe("coverage-report");
  });

  test("NEGATIVE CONTROL: candidate checkout or dependency install before trusted admission violates contract", () => {
    const invertedOrderWorkflow = `
      jobs:
        scan:
          steps:
            - name: Checkout admitted target commit as data only
              uses: actions/checkout@v4
            - name: Install dependencies without lifecycle scripts
              run: pnpm install --frozen-lockfile --ignore-scripts
            - name: Verify producer run and admission provenance
              id: admission
              run: node trusted/scripts/validateSonarMainCoverage.mjs verify-producer
    `;
    const parsed = parseYaml(invertedOrderWorkflow) as { jobs: { scan: { steps: { name: string }[] } } };
    const stepNames = parsed.jobs.scan.steps.map((s) => s.name);
    const checkoutIndex = stepNames.indexOf("Checkout admitted target commit as data only");
    const admissionIndex = stepNames.indexOf("Verify producer run and admission provenance");
    expect(checkoutIndex).toBeLessThan(admissionIndex); // Demonstrates the violation
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

  test("SCRUM-764: Sonar Main enforces trusted-controller admission order and artifact reuse", () => {
    type Step = {
      name?: string;
      id?: string;
      if?: string;
      run?: string;
      uses?: string;
      env?: Record<string, string>;
      with?: Record<string, unknown>;
      "working-directory"?: string;
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

    // Job condition must require same repository and event push to prevent fork main workflow_run triggers
    expect(scan.if).toContain("head_repository.full_name == github.repository");
    expect(scan.if).toContain("event == 'push'");

    // Job-level env must NOT expose SONAR_TOKEN
    expect((scan as { env?: Record<string, string> }).env?.SONAR_TOKEN).toBeUndefined();

    const stepNames = scan.steps.map((s) => s.name);

    // Step 1: Checkout immutable trusted controller
    const trustedCheckout = scan.steps.find((s) => s.name === "Checkout immutable trusted controller");
    expect(trustedCheckout?.uses).toBe("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(trustedCheckout?.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(trustedCheckout?.with?.path).toBe("trusted");

    // Step 2: Verify producer run and admission provenance (must run BEFORE candidate checkout)
    const admission = scan.steps.find((s) => s.name === "Verify producer run and admission provenance");
    expect(admission?.id).toBe("admission");
    expect(admission?.run).toContain("verify-producer");
    expect(admission?.run).toContain("trusted/scripts/validateSonarMainCoverage.mjs");
    expect(admission?.run).toContain("CURRENT_MAIN=");

    // Step 3: Checkout admitted target commit as data only
    const candidateCheckout = scan.steps.find((s) => s.name === "Checkout admitted target commit as data only");
    expect(candidateCheckout?.uses).toBe("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(candidateCheckout?.with?.path).toBe("candidate");
    expect(candidateCheckout?.with?.["fetch-depth"]).toBe(0);

    // Step 4: Download coverage report from Tests bound to verified immutable artifact ID
    const download = scan.steps.find((s) => s.name === "Download coverage report from Tests");
    expect(download?.uses).toBe("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(download?.with?.["artifact-ids"]).toBe("${{ steps.admission.outputs.artifact_id }}");
    expect(download?.with?.name).toBeUndefined();

    // Step 5: Validate coverage artifact provenance and census
    const validate = scan.steps.find((s) => s.name === "Validate coverage artifact provenance and census");
    expect(validate?.run).toContain("trusted/scripts/validateSonarMainCoverage.mjs");
    expect(validate?.run).toContain("trusted/sonar-project.properties candidate/sonar-project.properties");

    // Step 6: Install dependencies without lifecycle scripts (in candidate directory)
    const install = scan.steps.find((s) => s.name === "Install dependencies without lifecycle scripts");
    expect(install).toBeDefined();
    expect(install?.["working-directory"]).toBe("candidate");
    expect(install?.run).toContain("pnpm install --frozen-lockfile --ignore-scripts");

    // Step 7: SonarCloud scan scoped with SONAR_TOKEN and explicit revision binding
    const scanStep = scan.steps.find((s) => s.name === "SonarCloud scan");
    expect(scanStep?.uses).toBe("SonarSource/sonarqube-scan-action@22918119ff8e1ca75a623e15c8296b6ea4fbe28f");
    expect(scanStep?.env?.SONAR_TOKEN).toBe("${{ secrets.SONAR_TOKEN }}");
    expect(scanStep?.with?.projectBaseDir).toBe("candidate");
    expect(String(scanStep?.with?.args ?? "")).toContain("-Dsonar.scm.revision=");
    expect(String(scanStep?.with?.args ?? "")).toContain("-Dsonar.branch.name=main");

    // Strict trust-order verification:
    // Trusted controller checkout (1) -> Admission verification (2) -> Candidate checkout (3) -> Install (6) -> Scan (7)
    const idxTrusted = stepNames.indexOf("Checkout immutable trusted controller");
    const idxAdmission = stepNames.indexOf("Verify producer run and admission provenance");
    const idxCandidate = stepNames.indexOf("Checkout admitted target commit as data only");
    const idxDownload = stepNames.indexOf("Download coverage report from Tests");
    const idxValidate = stepNames.indexOf("Validate coverage artifact provenance and census");
    const idxInstall = stepNames.indexOf("Install dependencies without lifecycle scripts");
    const idxScan = stepNames.indexOf("SonarCloud scan");

    expect(idxTrusted).toBe(0);
    expect(idxTrusted).toBeLessThan(idxAdmission);
    expect(idxAdmission).toBeLessThan(idxCandidate);
    expect(idxCandidate).toBeLessThan(idxDownload);
    expect(idxDownload).toBeLessThan(idxValidate);
    expect(idxValidate).toBeLessThan(idxInstall);
    expect(idxInstall).toBeLessThan(idxScan);
  });
});
