import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import baseConfig from "../playwright.config";
import openingProofConfig from "../playwright.opening-proof.config";
import scenariosConfig from "../playwright.scenarios.config";

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
const raw: unknown = parse(source);

/*
 * Every schema below is a .strict() allowlist: a key it does not name fails the
 * parse. A plain z.object strips unknown keys, so `continue-on-error`, `shell`
 * or `defaults` would pass unseen (Seat 1 and Seat 2 on #760).
 *
 * Keys that can turn a red tripwire green, and what refuses each one:
 *
 * | Level    | Key                       | Effect                                  | Refused by                                    |
 * |----------|---------------------------|-----------------------------------------|-----------------------------------------------|
 * | workflow | defaults.run.shell        | a shell that swallows the exit code     | strict workflow schema; explicit no-defaults  |
 * | workflow | env (e.g. BASH_ENV)       | a sourced file that traps EXIT to 0     | strict workflow schema (no env key)           |
 * | job      | continue-on-error         | a failed job reports success            | strict job schema; explicit assertion         |
 * | job      | defaults.run.shell        | as the workflow key                     | strict job schema; explicit no-defaults       |
 * | job      | env, strategy, container  | BASH_ENV, a matrix with continue-on-error, a different shell | strict job schema         |
 * | step     | continue-on-error         | a failed step does not fail the job     | strict step schema; explicit assertion        |
 * | step     | shell                     | `bash -c '...; exit 0'` hides exit 7    | strict step schema; explicit mark..verify     |
 * | step     | if                        | verify never runs, or mark is skipped   | verify.if exactly always(); step literal      |
 * | step     | env (BASH_ENV, NODE_OPTIONS) | a preloaded process.exit(0) or EXIT trap | whole-step literal for every step          |
 * | step     | run, uses, with, name     | a different command or action           | whole-step literal for every step             |
 * | step     | a new step anywhere       | writes an empty fingerprint to          | whole-step literal (count and order);         |
 * |          |                           | $GITHUB_ENV, or a shim to $GITHUB_PATH  | verify always() refuses a missing baseline    |
 * | workflow, job | env                  | as the step env                         | no env at either level                        |
 *
 * Not covered by this file: what the pinned commands themselves write. Only
 * localConvexBackend.mjs start and mark write GITHUB_ENV here; they write the
 * backend variables and the fingerprint (localConvexBackend.test.ts).
 */
const stepSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    if: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    env: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
  })
  .strict();
type Step = z.infer<typeof stepSchema>;
const jobSchema = z
  .object({
    if: z.string(),
    "runs-on": z.string(),
    "timeout-minutes": z.number(),
    steps: z.array(stepSchema),
  })
  .strict();
const workflowSchema = z
  .object({
    name: z.string(),
    on: z.record(z.string(), z.unknown()),
    permissions: z.record(z.string(), z.string()),
    concurrency: z.object({ group: z.string(), "cancel-in-progress": z.boolean() }).strict(),
    jobs: z.record(z.string(), jobSchema),
  })
  .strict();
type Workflow = z.infer<typeof workflowSchema>;
const strictParse = workflowSchema.safeParse(raw);
// When the allowlist refuses the file, the allowlist test below fails with the
// offending keys, and the other tests still read the raw document so each one
// reports its own result instead of the whole file failing to load.
const workflow: Workflow = strictParse.success ? strictParse.data : (raw as Workflow);
const steps = workflow.jobs.playwright?.steps ?? [];

/** The raw YAML, unfiltered, for explicit key checks. */
const rawDoc = z
  .object({
    jobs: z.record(z.string(), z.object({ steps: z.array(z.record(z.string(), z.unknown())) }).passthrough()),
  })
  .passthrough()
  .parse(raw);

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

  test("no env at the workflow or the job level (BASH_ENV, NODE_OPTIONS or a fingerprint would reach every step)", () => {
    expect(rawDoc).not.toHaveProperty("env");
    expect(rawDoc.jobs.playwright).not.toHaveProperty("env");
  });

  test("every step of the playwright job equals this literal: keys, values, count and order", () => {
    // Whole objects, read from the raw YAML. A shell, an env entry (BASH_ENV,
    // NODE_OPTIONS), an `if`, a $GITHUB_ENV or $GITHUB_PATH write, or an extra
    // step anywhere in the job changes this list. Every edit to the job is a
    // reviewed edit to this literal.
    const secret = (name: string) => `\${{ secrets.${name} }}`;
    const fromEnv = (name: string) => `\${{ env.${name} }}`;
    const backendEnv = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: secret("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"), NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000" };
    const selfHosted = { CONVEX_SELF_HOSTED_URL: fromEnv("CONVEX_SELF_HOSTED_URL"), CONVEX_SELF_HOSTED_ADMIN_KEY: fromEnv("CONVEX_SELF_HOSTED_ADMIN_KEY") };
    expect(rawDoc.jobs.playwright?.steps).toEqual([
      { uses: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5", with: { "persist-credentials": false } },
      { uses: "pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa", with: { version: "11.13.0" } },
      { name: "Use Node.js", uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", with: { "node-version": "22.21.1", cache: "pnpm" } },
      { name: "Install dependencies", run: "pnpm install --frozen-lockfile --ignore-scripts" },
      { name: "Install Playwright browsers", run: "pnpm exec playwright install --with-deps chromium webkit" },
      {
        name: "Deal cockpit visual gate",
        run: [
          "set -euo pipefail",
          "pnpm run test:visual:deal-cockpit",
          "# The frame census is shared with playwright.yml (SCRUM-489).",
          "node scripts/assertDealCockpitVisualFrames.mjs test-results/deal-cockpit-visual",
          "node scripts/assertRoleAccessVisualFrames.mjs test-results/deal-cockpit-visual",
          "",
        ].join("\n"),
        env: { CI: true },
      },
      { name: "Start the local Convex backend", run: `${LOCAL_BACKEND} start` },
      { name: "Set and verify the local backend environment allowlist", run: `${LOCAL_BACKEND} env`, env: backendEnv },
      { name: "Deploy main to the local Convex backend", run: "pnpm exec convex deploy --typecheck enable --yes", env: selfHosted },
      { name: "Mint the disposable-preview marker and record the tripwire baseline", run: `${LOCAL_BACKEND} mark`, env: backendEnv },
      {
        name: "Seed the QA dealership on the local backend",
        run: "node scripts/e2ePreviewBootstrap.mjs",
        env: {
          ...selfHosted,
          NEXT_PUBLIC_CONVEX_URL: fromEnv("NEXT_PUBLIC_CONVEX_URL"),
          CLERK_SECRET_KEY: secret("CLERK_SECRET_KEY"),
          E2E_LOGIN_USER: secret("E2E_LOGIN_USER"),
          E2E_APPROVER_USER: secret("E2E_APPROVER_USER"),
          E2E_SEED_LEGACY_MANUAL_JOURNAL: "1",
        },
      },
      {
        name: "Run full Playwright suite",
        id: "playwright",
        run: SUITE,
        env: {
          AUTOFLOW_LOCAL_CONVEX_CI: "1",
          E2E_SEED_LEGACY_MANUAL_JOURNAL: "1",
          NEXT_PUBLIC_CONVEX_URL: fromEnv("NEXT_PUBLIC_CONVEX_URL"),
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: secret("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          CLERK_SECRET_KEY: secret("CLERK_SECRET_KEY"),
          NEXT_PUBLIC_APP_URL: secret("NEXT_PUBLIC_APP_URL"),
          E2E_LOGIN_USER: secret("E2E_LOGIN_USER"),
          E2E_LOGIN_PASSWORD: secret("E2E_LOGIN_PASSWORD"),
          E2E_LOGIN_VERIFICATION_CODE: secret("E2E_LOGIN_VERIFICATION_CODE"),
          E2E_APPROVER_USER: secret("E2E_APPROVER_USER"),
          E2E_APPROVER_PASSWORD: secret("E2E_APPROVER_PASSWORD"),
          CI: true,
        },
      },
      { name: "Assert the approve-door proof ran", if: "always() && steps.playwright.conclusion != 'skipped'", run: ASSERT_APPROVE },
      { name: "Verify the local backend was not changed during the run", if: "always()", run: `${LOCAL_BACKEND} verify`, env: backendEnv },
      { name: "Stop the local Convex backend", if: "always()", run: `${LOCAL_BACKEND} stop` },
      {
        name: "Upload Playwright report",
        uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
        if: "always()",
        with: {
          name: "trusted-main-playwright-report",
          path: "playwright-report/\nplaywright-json/\ntest-results/deal-cockpit-visual/artifacts/\n",
          "retention-days": 14,
        },
      },
    ]);
  });

  test("the workflow, the job and every step use only allowlisted keys", () => {
    const unknownKeys = strictParse.success ? [] : strictParse.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    expect(unknownKeys).toEqual([]);
  });

  test("no defaults and no continue-on-error, at the workflow, the job or any step", () => {
    expect(rawDoc).not.toHaveProperty("defaults");
    for (const job of Object.values(rawDoc.jobs)) {
      expect(job).not.toHaveProperty("continue-on-error");
      expect(job).not.toHaveProperty("defaults");
      for (const step of job.steps) expect(step).not.toHaveProperty("continue-on-error");
    }
  });

  test("no step from mark through verify overrides the shell", () => {
    const rawSteps = rawDoc.jobs.playwright?.steps ?? [];
    const at = (run: string) => rawSteps.findIndex((step) => typeof step.run === "string" && step.run.trim() === run);
    const mark = at(`${LOCAL_BACKEND} mark`);
    const verify = at(`${LOCAL_BACKEND} verify`);
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(mark);
    for (const step of rawSteps.slice(mark, verify + 1)) expect(step).not.toHaveProperty("shell");
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

  test("verify and stop run exactly always(); a missing or emptied baseline makes verify refuse, never skip", () => {
    // verifyBackend refuses without a 64-hex baseline (localConvexBackend.test.ts).
    const verify = steps[indexOfRun(`${LOCAL_BACKEND} verify`)];
    expect(verify?.if).toBe("always()");
    expect(verify?.env).toEqual({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "${{ secrets.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    });
    // Exactly always(), as convexCredentialBoundary.test.ts requires of every backend-owning job.
    expect(steps[indexOfRun(`${LOCAL_BACKEND} stop`)]?.if).toBe("always()");
  });

  test("mark and every step after it up to the suite are unconditional, so the baseline is always recorded", () => {
    const mark = indexOfRun(`${LOCAL_BACKEND} mark`);
    const suite = indexOfRun(SUITE);
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(suite).toBeGreaterThan(mark);
    for (const step of steps.slice(mark, suite + 1)) expect(step.if).toBeUndefined();
  });

  test("the app server never inherits the self-hosted admin key", () => {
    // Playwright 1.61 starts the server with { ...process.env, ...webServer.env }.
    for (const config of [baseConfig, scenariosConfig, openingProofConfig]) {
      const server = config.webServer;
      expect(server && !Array.isArray(server) ? server.env?.CONVEX_SELF_HOSTED_ADMIN_KEY : undefined).toBe("");
    }
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
