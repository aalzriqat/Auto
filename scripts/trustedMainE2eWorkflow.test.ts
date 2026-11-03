import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

/**
 * SCRUM-892, owner ruling c24441: trusted-main-e2e.yml gives its one job a
 * per-job local self-hosted Convex backend (scripts/localConvexBackend.mjs)
 * instead of a Convex cloud preview, so no cloud credential, deployment quota
 * or cleanup identity exists in it.
 *
 * On main this job produces the REQUIRED `github-actions/playwright` check that
 * the release guard reads (one result per SHA). So the job id, the workflow
 * name, the triggers, the main-only `if`, the concurrency group and the
 * permissions are pinned here to their exact values.
 */
const source = readFileSync(path.resolve(".github/workflows/trusted-main-e2e.yml"), "utf8");
const stepSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
});
type Step = z.infer<typeof stepSchema>;
const workflowSchema = z.object({
  name: z.string(),
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
  concurrency: z.object({ group: z.string(), "cancel-in-progress": z.boolean() }).strict(),
  jobs: z.record(
    z.string(),
    z.object({
      if: z.string(),
      "runs-on": z.string(),
      "timeout-minutes": z.number(),
      steps: z.array(stepSchema),
    }),
  ),
});
const workflow = workflowSchema.parse(parse(source));
const steps = workflow.jobs.playwright?.steps ?? [];

function stepNamed(name: string): Step {
  const step = steps.find((item) => item.name === name);
  if (!step) throw new Error(`Missing required workflow step: ${name}`);
  return step;
}
const indexOfRun = (run: string) => steps.findIndex((item) => item.run?.trim() === run);

const LOCAL_BACKEND = "node scripts/localConvexBackend.mjs";
const SUITE = "pnpm exec playwright test";
const ASSERT_APPROVE = "node scripts/assertApproveDoorRan.mjs playwright-json/results.json";
const FORBIDDEN = /CONVEX_PREVIEW_DEPLOY_KEY|CONVEX_DEPLOY_KEY|--preview-create|previewDeploymentLifecycle|convexPreviewAuthority/;

/** What the SCRUM-892 scan refuses, applied to any workflow text. */
function forbiddenReferences(text: string): string[] {
  return [...text.matchAll(new RegExp(FORBIDDEN.source, "g"))].map((match) => match[0]);
}

describe("SCRUM-892 trusted main E2E: required-check identity is unchanged", () => {
  test("workflow name, triggers, permissions, concurrency, job id and main-only guard keep their exact values", () => {
    expect(workflow.name).toBe("Trusted Main E2E (Playwright)");
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.on.workflow_dispatch ?? null).toBeNull();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "trusted-main-playwright-${{ github.ref }}",
      "cancel-in-progress": true,
    });
    // The job id `playwright` is the release guard's check name, and it is the only job.
    expect(Object.keys(workflow.jobs)).toEqual(["playwright"]);
    expect(workflow.jobs.playwright?.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.playwright?.["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.jobs.playwright?.["timeout-minutes"]).toBe(35);
  });

  test("no job or step sets continue-on-error, so a red verify fails the required check", () => {
    // Read the raw YAML: the zod step schema strips keys it does not declare.
    const raw = z
      .object({ jobs: z.record(z.string(), z.object({ steps: z.array(z.record(z.string(), z.unknown())) }).passthrough()) })
      .parse(parse(source));
    for (const job of Object.values(raw.jobs)) {
      expect(job).not.toHaveProperty("continue-on-error");
      for (const step of job.steps) expect(step).not.toHaveProperty("continue-on-error");
    }
  });
});

describe("SCRUM-892 trusted main E2E: a per-job local backend and no cloud credential", () => {
  test("the local-backend, seed, suite and assertion commands run in exactly this order", () => {
    const commands = steps
      .map((item) => item.run?.trim())
      .filter((run): run is string =>
        Boolean(run) &&
        (run!.includes("localConvexBackend.mjs") ||
          run!.includes("convex deploy") ||
          run!.includes("e2ePreviewBootstrap.mjs") ||
          run!.includes("playwright test") ||
          run!.includes("assertApproveDoorRan.mjs")),
      );
    expect(commands).toEqual([
      `${LOCAL_BACKEND} start`,
      `${LOCAL_BACKEND} env`,
      "pnpm exec convex deploy --typecheck enable --yes",
      `${LOCAL_BACKEND} mark`,
      "node scripts/e2ePreviewBootstrap.mjs",
      SUITE,
      ASSERT_APPROVE,
      `${LOCAL_BACKEND} verify`,
      `${LOCAL_BACKEND} stop`,
    ]);
  });

  test("no cloud Preview, preview credential or preview lifecycle remains anywhere in the file", () => {
    expect(forbiddenReferences(source)).toEqual([]);
    expect(source).not.toMatch(/secrets\.CONVEX_/);
    expect(source).not.toMatch(/CONVEX_PREVIEW_(NAME|URL|CREATED_AT)\b/);
    expect(JSON.stringify(workflow)).not.toMatch(FORBIDDEN);
    for (const step of steps) {
      expect(JSON.stringify(step.env ?? {}), String(step.name)).not.toMatch(FORBIDDEN);
      expect(step.run ?? "", String(step.name)).not.toMatch(FORBIDDEN);
    }
    // The scan is not vacuous: it names each forbidden spelling.
    expect(forbiddenReferences("env: { K: ${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }} }")).toEqual(["CONVEX_PREVIEW_DEPLOY_KEY"]);
    expect(forbiddenReferences("CONVEX_DEPLOY_KEY --preview-create previewDeploymentLifecycle convexPreviewAuthority")).toHaveLength(4);
    for (const removed of [
      "Name the disposable main preview",
      "Recreate Convex E2E backend",
      "Pin the disposable preview for cleanup",
      "Give the disposable preview the public-form backend variables",
      "Delete the disposable preview",
    ]) {
      expect(steps.some((item) => item.name === removed), removed).toBe(false);
    }
  });

  test("the backend variables come from the local env step, with the loopback app URL", () => {
    const env = stepNamed("Set and verify the local backend environment allowlist");
    expect(env.run).toBe(`${LOCAL_BACKEND} env`);
    expect(env.env).toEqual({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "${{ secrets.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    });
  });

  test("deploy, mark and the seed address the backend only by CONVEX_SELF_HOSTED_*, with no deploy key or preview name", () => {
    const selfHosted = {
      CONVEX_SELF_HOSTED_URL: "${{ env.CONVEX_SELF_HOSTED_URL }}",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "${{ env.CONVEX_SELF_HOSTED_ADMIN_KEY }}",
    };
    const deploy = steps[indexOfRun("pnpm exec convex deploy --typecheck enable --yes")];
    expect(deploy?.env).toEqual(selfHosted);
    const mark = steps[indexOfRun(`${LOCAL_BACKEND} mark`)];
    expect(mark?.env).toMatchObject({ NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000" });
    const seed = steps[indexOfRun("node scripts/e2ePreviewBootstrap.mjs")];
    expect(seed?.env).toMatchObject(selfHosted);
    expect(Object.keys(seed?.env ?? {})).not.toContain("CONVEX_DEPLOY_KEY");
    expect(Object.keys(seed?.env ?? {})).not.toContain("CONVEX_PREVIEW_NAME");
  });

  test("the suite step carries the local-backend CSP switch and no deploy key", () => {
    const suite = steps[indexOfRun(SUITE)];
    expect(suite?.id).toBe("playwright");
    expect(suite?.env?.AUTOFLOW_LOCAL_CONVEX_CI).toBe("1");
    expect(suite?.env?.NEXT_PUBLIC_CONVEX_URL).toBe("${{ env.NEXT_PUBLIC_CONVEX_URL }}");
    expect(suite?.env?.CI).toBe(true);
  });

  test("verify runs always() once a fingerprint was recorded; stop runs always() and exactly so", () => {
    const verify = steps[indexOfRun(`${LOCAL_BACKEND} verify`)];
    expect(verify?.if).toBe("always() && env.AUTOFLOW_LOCAL_CONVEX_CODE_FINGERPRINT != ''");
    expect(verify?.env).toEqual({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "${{ secrets.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    });
    // Exactly always(), as convexCredentialBoundary.test.ts requires of every backend-owning job.
    expect(steps[indexOfRun(`${LOCAL_BACKEND} stop`)]?.if).toBe("always()");
  });

  test("the seed flag is on BOTH the seed step and the suite step", () => {
    expect(steps[indexOfRun("node scripts/e2ePreviewBootstrap.mjs")]?.env?.E2E_SEED_LEGACY_MANUAL_JOURNAL).toBe("1");
    expect(steps[indexOfRun(SUITE)]?.env?.E2E_SEED_LEGACY_MANUAL_JOURNAL).toBe("1");
  });

  test("mark runs before the seed; verify runs after the suite and the approve-door assertion, before the upload", () => {
    const at = (run: string) => indexOfRun(run);
    const upload = steps.findIndex((item) => item.name === "Upload Playwright report");
    expect(at(`${LOCAL_BACKEND} start`)).toBeLessThan(at(`${LOCAL_BACKEND} env`));
    expect(at(`${LOCAL_BACKEND} env`)).toBeLessThan(at("pnpm exec convex deploy --typecheck enable --yes"));
    expect(at("pnpm exec convex deploy --typecheck enable --yes")).toBeLessThan(at(`${LOCAL_BACKEND} mark`));
    expect(at(`${LOCAL_BACKEND} mark`)).toBeLessThan(at("node scripts/e2ePreviewBootstrap.mjs"));
    expect(at("node scripts/e2ePreviewBootstrap.mjs")).toBeLessThan(at(SUITE));
    expect(at(SUITE)).toBeLessThan(at(ASSERT_APPROVE));
    expect(at(ASSERT_APPROVE)).toBeLessThan(at(`${LOCAL_BACKEND} verify`));
    expect(at(`${LOCAL_BACKEND} verify`)).toBeLessThan(upload);
    expect(at(`${LOCAL_BACKEND} verify`)).toBeLessThan(at(`${LOCAL_BACKEND} stop`));
    // The static visual gate needs no backend and still comes first.
    const gate = steps.findIndex((item) => item.name === "Deal cockpit visual gate");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(at(`${LOCAL_BACKEND} start`));
  });

  test("the approve-door assertion and the report upload keep their exact contract", () => {
    const assertion = stepNamed("Assert the approve-door proof ran");
    expect(assertion.if).toBe("always() && steps.playwright.conclusion != 'skipped'");
    expect(assertion.run).toBe(ASSERT_APPROVE);
    const upload = stepNamed("Upload Playwright report");
    expect(upload.if).toBe("always()");
    expect(upload.with?.name).toBe("trusted-main-playwright-report");
  });
});
