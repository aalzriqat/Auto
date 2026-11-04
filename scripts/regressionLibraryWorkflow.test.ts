import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

/**
 * SCRUM-761 R3 / SCRUM-892 (owner ruling c24441): the nightly and release cadences of the
 * regression library run on a per-job LOCAL Convex backend, through the mark/verify
 * tripwire, with no Convex cloud credential or preview.
 *
 * Every schema below is a .strict() allowlist: a key it does not name fails the parse, so
 * `continue-on-error`, `shell`, `defaults`, `strategy` or `container` cannot pass unseen.
 * Every step of the job is deep-equalled to a literal, which also pins step count and order,
 * and verify runs exactly `always()` so a missing baseline refuses instead of skipping
 * (reference: a tripwire test must pin the whole mark..verify span and env, not single keys).
 */
const read = (file: string) => readFileSync(path.resolve(".github/workflows", file), "utf8");
const source = read("regression-library.yml");
const raw: unknown = parse(source);

const envValue = z.union([z.string(), z.boolean(), z.number()]);
const stepSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    if: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    env: z.record(z.string(), envValue).optional(),
  })
  .strict();
const jobSchema = z
  .object({ if: z.string(), "runs-on": z.string(), "timeout-minutes": z.number(), steps: z.array(stepSchema) })
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
const workflow: Workflow = strictParse.success ? strictParse.data : (raw as Workflow);
const rawDoc = z
  .object({ jobs: z.record(z.string(), z.object({ steps: z.array(z.record(z.string(), z.unknown())) }).passthrough()) })
  .passthrough()
  .parse(raw);

const secret = (name: string) => `\${{ secrets.${name} }}`;
const fromEnv = (name: string) => `\${{ env.${name} }}`;
const LOCAL_BACKEND = "node scripts/localConvexBackend.mjs";
const backendEnv = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: secret("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"), NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000" };
const selfHosted = { CONVEX_SELF_HOSTED_URL: fromEnv("CONVEX_SELF_HOSTED_URL"), CONVEX_SELF_HOSTED_ADMIN_KEY: fromEnv("CONVEX_SELF_HOSTED_ADMIN_KEY") };
const FORBIDDEN = /CONVEX_PREVIEW_DEPLOY_KEY|CONVEX_DEPLOY_KEY|--preview-create|previewDeploymentLifecycle|convexPreviewAuthority/;

describe("SCRUM-761 regression library workflow: identity and triggers", () => {
  test("name, triggers, permissions, concurrency and the main-only guard keep their exact values", () => {
    expect(workflow.name).toBe("Regression library (nightly and release)");
    expect(workflow.on).toEqual({
      schedule: [{ cron: "30 2 * * *" }],
      workflow_dispatch: null,
      repository_dispatch: { types: ["autoflow-release-regression-library"] },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "regression-library-${{ github.event_name }}-${{ github.ref }}", "cancel-in-progress": false });
    expect(Object.keys(workflow.jobs)).toEqual(["regression-library"]);
    expect(workflow.jobs["regression-library"]?.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs["regression-library"]?.["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.jobs["regression-library"]?.["timeout-minutes"]).toBe(180);
    // Never a pull_request trigger: this job holds the QA secrets.
    expect(Object.keys(workflow.on)).not.toContain("pull_request");
    expect(Object.keys(workflow.on)).not.toContain("pull_request_target");
  });

  test("no env at the workflow or the job level, no defaults, no continue-on-error anywhere", () => {
    expect(rawDoc).not.toHaveProperty("env");
    expect(rawDoc).not.toHaveProperty("defaults");
    for (const job of Object.values(rawDoc.jobs)) {
      expect(job).not.toHaveProperty("env");
      expect(job).not.toHaveProperty("defaults");
      expect(job).not.toHaveProperty("continue-on-error");
      expect(job).not.toHaveProperty("strategy");
      for (const step of job.steps) {
        expect(step).not.toHaveProperty("continue-on-error");
        expect(step).not.toHaveProperty("shell");
      }
    }
  });

  test("the workflow, the job and every step use only allowlisted keys", () => {
    expect(strictParse.success ? [] : strictParse.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([]);
  });
});

describe("SCRUM-761 regression library workflow: the whole job is pinned", () => {
  test("every step equals this literal: keys, values, count and order", () => {
    expect(rawDoc.jobs["regression-library"]?.steps).toEqual([
      { uses: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5", with: { "persist-credentials": false } },
      { uses: "pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa", with: { version: "11.13.0" } },
      { name: "Use Node.js", uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", with: { "node-version": "22.21.1", cache: "pnpm" } },
      { name: "Install dependencies", run: "pnpm install --frozen-lockfile --ignore-scripts" },
      { name: "Install Playwright browsers", run: "pnpm exec playwright install --with-deps chromium webkit" },
      {
        name: "Refuse a release dispatch that is not main's current tip",
        if: "github.event_name == 'repository_dispatch'",
        run: [
          "set -euo pipefail",
          '[[ "$REQUESTED_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "commit_sha must be a full 40-character SHA"; exit 1; }',
          'TIP="$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)"',
          '[ "$REQUESTED_SHA" = "$GITHUB_SHA" ] && [ "$REQUESTED_SHA" = "$TIP" ] || { echo "release dispatch does not name main\'s current tip"; exit 1; }',
          "",
        ].join("\n"),
        env: { GH_TOKEN: "${{ github.token }}", REQUESTED_SHA: "${{ github.event.client_payload.commit_sha }}" },
      },
      {
        name: "Run the static visual projects",
        run: [
          "set -uo pipefail",
          "status=0",
          "mkdir -p regression-reports",
          "PLAYWRIGHT_JSON_OUTPUT_NAME=regression-reports/visual.json pnpm run test:visual:deal-cockpit --reporter=json || status=1",
          "PLAYWRIGHT_JSON_OUTPUT_NAME=regression-reports/opening-visual.json pnpm exec playwright test -c playwright.opening.visual.config.ts --reporter=json || status=1",
          'exit "$status"',
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
        name: "Run the backend-backed browser projects",
        id: "browser",
        run: [
          "set -uo pipefail",
          "status=0",
          "PLAYWRIGHT_JSON_OUTPUT_NAME=regression-reports/tests.json pnpm exec playwright test --reporter=json || status=1",
          "CROSS_SCREEN_ORACLE=1 PLAYWRIGHT_JSON_OUTPUT_NAME=regression-reports/scenarios.json pnpm exec playwright test -c playwright.scenarios.config.ts --reporter=json || status=1",
          "PLAYWRIGHT_JSON_OUTPUT_NAME=regression-reports/opening-proof.json pnpm exec playwright test -c playwright.opening-proof.config.ts --reporter=json || status=1",
          'exit "$status"',
          "",
        ].join("\n"),
        env: {
          AUTOFLOW_LOCAL_CONVEX_CI: "1",
          E2E_SEED_LEGACY_MANUAL_JOURNAL: "1",
          JEV_FORM_EXPLORER: "0",
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
          BASE_SHA: "${{ github.sha }}",
          HEAD_SHA: "${{ github.sha }}",
          TESTED_SHA: "${{ github.sha }}",
          CONTROLLER_SHA: "${{ github.workflow_sha }}",
          OPENING_PROOF_RUN_ID: "gh-${{ github.run_id }}-${{ github.run_attempt }}",
          CI: true,
        },
      },
      { name: "Verify the local backend was not changed during the run", if: "always()", run: `${LOCAL_BACKEND} verify`, env: backendEnv },
      { name: "Stop the local Convex backend", if: "always()", run: `${LOCAL_BACKEND} stop` },
      {
        name: "Judge every active record",
        if: "always()",
        run: "node scripts/regression/prRunner.mjs --tier full --playwright-report regression-reports/visual.json --playwright-report regression-reports/opening-visual.json --playwright-report regression-reports/tests.json --playwright-report regression-reports/scenarios.json --playwright-report regression-reports/opening-proof.json",
        env: { NODE_ENV: "test", NODE_OPTIONS: "--max-old-space-size=5632" },
      },
      {
        name: "Upload Playwright reports",
        uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
        if: "always()",
        with: { name: "regression-library-playwright-reports", path: "regression-reports/\nplaywright-json/\n", "if-no-files-found": "warn", "retention-days": 14 },
      },
    ]);
  });

  test("verify runs exactly always() and the backend steps before the verdict are unconditional", () => {
    const steps = workflow.jobs["regression-library"]?.steps ?? [];
    const at = (run: string) => steps.findIndex((item) => item.run?.trim() === run);
    expect(steps[at(`${LOCAL_BACKEND} verify`)]?.if).toBe("always()");
    expect(steps[at(`${LOCAL_BACKEND} stop`)]?.if).toBe("always()");
    const mark = at(`${LOCAL_BACKEND} mark`);
    const browser = steps.findIndex((item) => item.id === "browser");
    expect(mark).toBeGreaterThan(at(`${LOCAL_BACKEND} start`));
    expect(browser).toBeGreaterThan(mark);
    for (const step of steps.slice(mark, browser + 1)) expect(step.if).toBeUndefined();
    expect(at(`${LOCAL_BACKEND} verify`)).toBeGreaterThan(browser);
  });

  test("no Convex cloud preview, preview credential or lifecycle script anywhere in the file", () => {
    expect(source).not.toMatch(FORBIDDEN);
    expect(source).not.toMatch(/secrets\.CONVEX_/);
    expect(source).not.toMatch(/CONVEX_PREVIEW_(NAME|URL|CREATED_AT)\b/);
    // The scan is not vacuous.
    expect("CONVEX_DEPLOY_KEY --preview-create").toMatch(FORBIDDEN);
  });

  test("the verdict step runs the full tier and a skipped scenario is not a pass", () => {
    const verdict = (workflow.jobs["regression-library"]?.steps ?? []).find((item) => item.name === "Judge every active record");
    expect(verdict?.run).toContain("--tier full");
    expect(verdict?.if).toBe("always()");
  });
});

describe("SCRUM-761 PR-tier workflow: no backend, no secret, advisory", () => {
  const pr = read("scenario-runner.yml");
  test("runs on pull requests only, with read-only contents and no Convex or secret reference", () => {
    const doc = z
      .object({ on: z.record(z.string(), z.unknown()), permissions: z.record(z.string(), z.string()) })
      .passthrough()
      .parse(parse(pr));
    expect(Object.keys(doc.on)).toEqual(["pull_request"]);
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(pr).not.toMatch(/secrets\./);
    expect(pr).not.toMatch(FORBIDDEN);
    expect(pr).not.toMatch(/localConvexBackend|convex deploy/);
  });
});
