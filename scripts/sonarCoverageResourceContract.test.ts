import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "..");
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
});
