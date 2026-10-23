import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_ROLE_TEMPLATES } from "../convex/utils/permissions";
import { auditDestination } from "../playwright/fixtures/screenAuditRoutes";
import roleConfig from "../playwright.role-audit.config";
import visualConfig from "../playwright.visual.config";

test.each([
  ["OWNER", "dashboard"], ["MANAGER", "dashboard"], ["SALES", "sales"],
  ["RECEPTION", "leads"], ["ACCOUNTANT", "accounting"], ["SENIOR_ACCOUNTANT", "accounting"],
] as const)("dashboard audit models the actual %s landing destination", (role, destination) => {
  expect(auditDestination("dashboard", role)).toBe(destination);
  expect(auditDestination("applications", role)).toBe("deals");
  expect(auditDestination("customers", role)).toBe("customers");
});

const source = readFileSync(path.resolve(".github/workflows/pilot-role-audit.yml"), "utf8");
const stepSchema = z.object({ name: z.string().optional(), run: z.string().optional(),
  with: z.object({ path: z.string().optional() }).passthrough().optional(),
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
  test("anonymous drawer controls run in the PR static browser gate", () => {
    const project = visualConfig.projects?.find(item => item.name === "audit-controls");
    expect(project?.testDir).toBe("./playwright/tests");
    expect(project?.testMatch).toEqual([
      "audit-navigation-dismissal.spec.ts", "bill-of-sale-capture.spec.ts",
    ]);
    expect(project?.dependencies ?? []).toEqual([]);
    expect(project?.use?.storageState).toEqual({ cookies: [], origins: [] });
    expect(project?.use?.trace).toBe("off");
    expect(project?.use?.video).toBe("off");
    expect(project?.use?.screenshot).toBe("off");
  });
  test("publishes only explicit post-login evidence and never records auth traces or video", () => {
    const upload = stepNamed(workflow.jobs.roles.steps, "Upload encrypted role audit evidence");
    expect(upload.with?.path?.trim().split(/\r?\n/).map((line) => line.trim())).toEqual([
      "${{ runner.temp }}/pilot-role-audit-public/role-evidence.tar.gpg",
      "${{ runner.temp }}/pilot-role-audit-public/results.json",
    ]);
    for (const project of roleConfig.projects ?? []) {
      expect(project.use?.trace ?? roleConfig.use?.trace).toBe("off");
      expect(project.use?.video ?? roleConfig.use?.video).toBe("off");
      expect(project.use?.screenshot ?? roleConfig.use?.screenshot).toBe("off");
    }
  });
  test("executes only trusted main code and runs every product role with one worker", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const job = workflow.jobs.roles;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.strategy.matrix.role.toSorted()).toEqual(DEFAULT_ROLE_TEMPLATES.map((role) => role.name).sort());
    expect(job.strategy["max-parallel"]).toBe(1);
    expect(job.strategy["fail-fast"]).toBe(false);
    const browserStep = stepNamed(job.steps, "Run the attested role, locale and viewport matrix");
    expect(browserStep.run).toBe("node scripts/pilotRoleAuditEvidence.mjs");
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
