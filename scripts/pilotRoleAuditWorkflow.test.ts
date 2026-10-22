import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_ROLE_TEMPLATES } from "../convex/utils/permissions";

const source = readFileSync(path.resolve(".github/workflows/pilot-role-audit.yml"), "utf8");
const stepSchema = z.object({ name: z.string().optional(), run: z.string().optional(),
  if: z.string().optional(), env: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional() });
const jobSchema = z.object({ if: z.string(), steps: z.array(stepSchema) });
const workflow = z.object({
  on: z.record(z.string(), z.unknown()), permissions: z.object({ contents: z.string() }).strict(),
  jobs: z.object({ roles: jobSchema.extend({ strategy: z.object({
    matrix: z.object({ role: z.array(z.string()) }), "max-parallel": z.number(), "fail-fast": z.boolean(),
  }) }) }),
}).parse(parse(source));
function stepNamed(steps: z.infer<typeof stepSchema>[], name: string) {
  const step = steps.find((item) => item.name === name);
  if (!step) throw new Error(`Missing required workflow step: ${name}`);
  return step;
}

describe("SCRUM-616 role audit trust and coverage contract", () => {
  test("executes only trusted main code and runs every product role with one worker", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const job = workflow.jobs.roles;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.strategy.matrix.role.toSorted()).toEqual(DEFAULT_ROLE_TEMPLATES.map((role) => role.name).sort());
    expect(job.strategy["max-parallel"]).toBe(1);
    expect(job.strategy["fail-fast"]).toBe(false);
    const browserStep = stepNamed(job.steps, "Run the attested role, locale and viewport matrix");
    expect(browserStep.run).toContain("-c playwright.role-audit.config.ts");
    expect(browserStep.env?.HUNT_AUDIT_ROLE).toBe("${{ matrix.role }}");
    expect(readFileSync(path.resolve("playwright.role-audit.config.ts"), "utf8")).toContain("workers: 1");
  });

  test("creates and tears down only run-owned previews and uses only the preview deploy key", () => {
    const steps = workflow.jobs.roles.steps;
    const deploy = stepNamed(steps, "Recreate Convex E2E backend");
    expect(deploy.run).toContain('--preview-create "$CONVEX_PREVIEW_NAME"');
    expect(deploy.run).toContain("--preview-run e2eBootstrap:markPreviewDeployment");
    for (const step of steps) {
      if (step.env?.CONVEX_DEPLOY_KEY) {
        expect(step.env.CONVEX_DEPLOY_KEY).toBe("${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}");
      }
    }
    const cleanup = stepNamed(steps, "Delete the disposable preview");
    expect(cleanup.if).toBe("always() && env.CONVEX_PREVIEW_CREATED_AT != ''");
    expect(cleanup.run).toBe("node scripts/previewDeploymentLifecycle.mjs delete");
    expect(source).not.toContain("pull_request");
  });

  test("the real-backend scenario library opts into the existing fail-closed cross-screen oracle", () => {
    const scenarios = z.object({ jobs: z.object({ scenarios: jobSchema }) }).parse(
      parse(readFileSync(path.resolve(".github/workflows/deal-scenarios-e2e.yml"), "utf8")),
    );
    const run = stepNamed(scenarios.jobs.scenarios.steps, "Run the scenario matrix and screen audit");
    expect(run.env?.CROSS_SCREEN_ORACLE).toBe("1");
    expect(run.run).toContain("-c playwright.scenarios.config.ts");
  });
});
