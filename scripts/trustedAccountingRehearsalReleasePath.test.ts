/**
 * SCRUM-892 owner ruling option A (c24422): pull requests certify on the
 * runner-local self-hosted Convex backend, and the RELEASE rehearsal
 * (repository_dispatch `autoflow-release-accounting-rehearsal`) stays on a
 * disposable cloud preview, unchanged.
 *
 * These tests pin that split in trusted-accounting-rehearsal.yml:
 * - every step the release event can reach is byte-identical to origin/main at
 *   42ef0c57 (before this change), apart from `if:` lines;
 * - each of those `if:` lines is one of a fixed set, each true or false under
 *   repository_dispatch exactly as on that commit;
 * - the release path creates its preview with `--preview-create`, cleans it up
 *   strictly, and never touches the local backend;
 * - the pull-request path creates no preview and holds no cloud credential.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; steps?: Step[] };
const workflow = parse(readFileSync(".github/workflows/trusted-accounting-rehearsal.yml", "utf8")) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};
const steps = workflow.jobs.rehearsal?.steps ?? [];

const PR_LOCAL_IF =
  "github.event_name == 'workflow_run' && steps.provenance.outputs.stale == 'false' && steps.backend_inputs.outputs.run_rehearsal == 'true'";
const PR_STOP_IF = "always() && github.event_name == 'workflow_run'";
const RELEASE_ONLY_IF = "steps.provenance.outputs.stale == 'false' && github.event_name == 'repository_dispatch'";

/** A step the release event can never run: its condition starts by requiring workflow_run. */
function prOnly(step: Step): boolean {
  return typeof step.if === "string" && (step.if.startsWith("github.event_name == 'workflow_run' && ") || step.if === PR_STOP_IF);
}

const releaseSteps = steps.filter((step) => !prOnly(step));
// From the local backend's start onward; the earlier "Mark ... pending" step shares PR_LOCAL_IF.
const localStart = steps.findIndex((step) => step.name === "Start the local Convex backend");
const prLocalSteps = steps.slice(Math.max(localStart, 0)).filter((step) => step.if === PR_LOCAL_IF || step.if === PR_STOP_IF);

describe("the release rehearsal path is unchanged", () => {
  test("every step it can reach is byte-identical to origin/main before SCRUM-892, apart from if: lines", () => {
    const projection = releaseSteps.map(({ if: _if, ...rest }) => rest);
    expect(releaseSteps).toHaveLength(18);
    // Computed from origin/main 42ef0c57's copy of this workflow with the same
    // projection. Changing it needs a new owner ruling on the release rehearsal.
    expect(createHash("sha256").update(JSON.stringify(projection)).digest("hex")).toBe(
      "796cf19855623ae80c49541be424ba926570351e2acd9dd21f9bbfc0e211ddd4",
    );
  });

  test("each release-path condition is one that evaluated the same way under repository_dispatch before the change", () => {
    // On origin/main the cloud steps read `stale == 'false' && (dispatch || run_rehearsal)`;
    // under repository_dispatch that equals RELEASE_ONLY_IF. The others are unchanged.
    const allowed = new Set([
      undefined,
      "steps.provenance.outputs.stale == 'false' && (github.event_name == 'repository_dispatch' || steps.backend_inputs.outputs.run_rehearsal == 'true')",
      RELEASE_ONLY_IF,
      "always() && steps.provenance.outputs.stale == 'false' && env.CONVEX_PREVIEW_URL != ''",
      "github.event_name == 'repository_dispatch' && steps.provenance.outputs.stale == 'false'",
      "always() && steps.provenance.outputs.stale == 'false'",
      "always() && env.CONVEX_PREVIEW_CREATED_AT != ''",
    ]);
    for (const step of releaseSteps) expect(allowed, String(step.name)).toContain(step.if);
  });

  test("it still creates its backend with --preview-create and deletes it strictly", () => {
    const create = releaseSteps.find((step) => step.name === "Name and recreate disposable rehearsal preview from trusted main");
    expect(create?.if).toBe(RELEASE_ONLY_IF);
    expect(create?.run).toContain('--preview-create "$PREVIEW_NAME"');
    expect(create?.run).toContain("--preview-run e2eBootstrap:markPreviewDeployment");
    expect(create?.env?.CONVEX_DEPLOY_KEY).toBe("${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}");
    const strict = releaseSteps.map((step) => String(step.run ?? "")).join("\n");
    expect(strict).toContain("node scripts/previewDeploymentLifecycle.mjs pin --strict");
    expect(strict).toContain("node scripts/previewDeploymentLifecycle.mjs delete --strict");
    expect(releaseSteps.some((step) => step.name === "Refuse release rehearsal without a pinned cleanup identity")).toBe(true);
  });

  test("its evidence check is the cloud one: no expected deployment type, a named preview", () => {
    const check = releaseSteps.find((step) => step.name === "Refuse incomplete or wrong-target cloud evidence");
    expect(check?.if).toBe(RELEASE_ONLY_IF);
    expect(check?.env).toEqual({
      EXPECTED_TESTED_SHA: "${{ steps.provenance.outputs.tested_sha }}",
      EXPECTED_PREVIEW_NAME: "${{ env.CONVEX_PREVIEW_NAME }}",
      EXPECTED_PREVIEW_URL: "${{ env.NEXT_PUBLIC_CONVEX_URL }}",
    });
  });

  test("it never reaches the local backend", () => {
    for (const step of releaseSteps) {
      const text = JSON.stringify(step);
      expect(text, String(step.name)).not.toContain("localConvexBackend");
      expect(text, String(step.name)).not.toContain("CONVEX_SELF_HOSTED");
      expect(text, String(step.name)).not.toContain("EXPECTED_DEPLOYMENT_TYPE");
    }
  });

  test("the producer-bound check names and the release trigger are unchanged", () => {
    expect(workflow.on).toHaveProperty("repository_dispatch", { types: ["autoflow-release-accounting-rehearsal"] });
    expect(workflow.jobs.rehearsal?.name).toBe("trusted-accounting-rehearsal");
    expect(workflow.jobs.verdict?.name).toBe("trusted-accounting-rehearsal-verdict");
    expect(workflow.jobs.release_verdict?.name).toBe(
      "${{ (github.event_name == 'repository_dispatch' && needs.dispatch_preflight.outputs.exact_sha == 'true') && 'trusted-accounting-release-verdict' || 'trusted-accounting-release-not-dispatched' }}",
    );
  });
});

describe("the pull-request rehearsal path runs on the local backend", () => {
  test("its steps are the local lifecycle, in order, with the tripwire around the cases", () => {
    expect(prLocalSteps.map((step) => step.name)).toEqual([
      "Start the local Convex backend",
      "Set and verify the local backend environment allowlist before candidate execution",
      "Stage exact candidate backend as data",
      "Audit staged backend inputs without credentials",
      "Deploy staged candidate backend with trusted Convex CLI",
      "Mint the disposable-preview marker with the trusted CLI",
      "Seed synthetic QA dealership on the local backend from trusted main",
      "Run local accounting rehearsal from trusted main",
      "Verify the local backend was not changed during the run",
      "Refuse incomplete or wrong-target local evidence",
      "Stop the local Convex backend",
    ]);
    expect(prLocalSteps.at(-1)?.if).toBe(PR_STOP_IF);
  });

  test("it creates no preview and holds no cloud Convex credential", () => {
    for (const step of prLocalSteps) {
      const text = JSON.stringify(step);
      expect(text, String(step.name)).not.toMatch(/CONVEX_PREVIEW_DEPLOY_KEY|CONVEX_DEPLOY_KEY|--preview-create|previewDeploymentLifecycle/);
    }
  });

  test("it validates the evidence as local, against the URL the start step exported", () => {
    const check = prLocalSteps.find((step) => step.name === "Refuse incomplete or wrong-target local evidence");
    expect(check?.run).toBe("node scripts/validateAccountingReleaseEvidence.mjs rehearsal-evidence.json");
    expect(check?.env).toEqual({
      EXPECTED_DEPLOYMENT_TYPE: "local",
      EXPECTED_TESTED_SHA: "${{ steps.provenance.outputs.tested_sha }}",
      EXPECTED_PREVIEW_URL: "${{ env.NEXT_PUBLIC_CONVEX_URL }}",
    });
  });

  test("the cases run the same driver as the release, with the local target", () => {
    const run = prLocalSteps.find((step) => step.name === "Run local accounting rehearsal from trusted main");
    const cloud = releaseSteps.find((step) => step.name === "Run cloud accounting rehearsal from trusted main");
    expect(run?.run).toBe(cloud?.run);
    expect(Object.keys(run?.env ?? {}).sort()).toEqual([
      "CLERK_SECRET_KEY", "CONVEX_SELF_HOSTED_ADMIN_KEY", "CONVEX_SELF_HOSTED_URL",
      "E2E_APPROVER_USER", "E2E_LOGIN_USER", "NEXT_PUBLIC_CONVEX_URL",
    ]);
  });
});
