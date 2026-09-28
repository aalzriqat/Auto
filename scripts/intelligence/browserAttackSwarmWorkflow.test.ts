import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

type WorkflowStep = {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, unknown>;
  steps?: WorkflowStep[];
};

type Workflow = {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  on?: {
    workflow_run?: {
      workflows?: string[];
      types?: string[];
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
};

const workflowPath = path.resolve(
  process.cwd(),
  ".github/workflows/browser-attack-swarm.yml",
);
const workflow = parseYaml(readFileSync(workflowPath, "utf8")) as Workflow;
const playwrightWorkflowSource = readFileSync(
  path.resolve(process.cwd(), ".github/workflows/playwright.yml"),
  "utf8",
);
const playwrightWorkflow = parseYaml(playwrightWorkflowSource) as Workflow;
const trustedMainE2EWorkflowSource = readFileSync(
  path.resolve(process.cwd(), ".github/workflows/trusted-main-e2e.yml"),
  "utf8",
);
const trustedMainE2EWorkflow = parseYaml(trustedMainE2EWorkflowSource) as Workflow;

function job(name: string): WorkflowJob {
  const value = workflow.jobs?.[name];
  if (!value) throw new Error("Missing workflow job " + name);
  return value;
}

function step(jobName: string, stepName: string): WorkflowStep {
  const value = job(jobName).steps?.find((entry) => entry.name === stepName);
  if (!value) throw new Error("Missing workflow step " + jobName + " :: " + stepName);
  return value;
}

function playwrightStep(stepName: string): WorkflowStep {
  const value = playwrightWorkflow.jobs?.playwright?.steps?.find(
    (entry) => entry.name === stepName,
  );
  if (!value) throw new Error("Missing Playwright workflow step :: " + stepName);
  return value;
}

const CANDIDATE_FORBIDDEN_ENV = [
  "CLERK_SECRET_KEY",
  "CONVEX_DEPLOY_KEY",
  "E2E_LOGIN_USER",
  "E2E_LOGIN_PASSWORD",
  "E2E_LOGIN_VERIFICATION_CODE",
  "E2E_APPROVER_USER",
  "E2E_APPROVER_PASSWORD",
  "GITHUB_TOKEN",
] as const;

describe("SCRUM-350 trusted browser swarm workflow authority", () => {
  it("keeps the PR preflight completely free of reusable secret references", () => {
    expect(playwrightWorkflowSource).not.toContain("secrets.");
    expect(playwrightWorkflowSource).not.toContain("CLERK_SECRET_KEY");
    expect(playwrightWorkflowSource).not.toContain("CONVEX_DEPLOY_KEY");
    expect(playwrightWorkflowSource).not.toContain("E2E_LOGIN_PASSWORD");
    expect(playwrightWorkflowSource).not.toContain("E2E_APPROVER_PASSWORD");

    const checkout = playwrightWorkflow.jobs?.playwright?.steps?.find(
      (entry) => String(entry.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("keeps credential-backed main E2E off pull_request entirely", () => {
    expect(trustedMainE2EWorkflowSource).toContain("secrets.");
    expect(trustedMainE2EWorkflow.on?.workflow_run).toBeUndefined();
    expect(trustedMainE2EWorkflowSource).not.toMatch(/^\s*pull_request:/m);
    expect(trustedMainE2EWorkflow.jobs?.playwright?.if).toBe(
      "github.ref == 'refs/heads/main'",
    );
  });

  it("runs only as a successful Playwright workflow_run follow-up", () => {
    expect(workflow.on?.workflow_run?.workflows).toEqual([
      "E2E Tests (Playwright)",
    ]);
    expect(workflow.on?.workflow_run?.types).toEqual(["completed"]);

    const prepareIf = String(job("prepare").if ?? "");
    expect(prepareIf).toContain(
      "github.event.workflow_run.event == 'pull_request'",
    );
    expect(prepareIf).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(prepareIf).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );

    const attackIf = String(job("attack-worker").if ?? "");
    expect(attackIf).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
  });

  it("serializes ordinary E2E and trusted swarm around the same PR preview resource", () => {
    expect(playwrightWorkflow.concurrency).toEqual({
      group: "playwright-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    });
    expect(workflow.concurrency).toEqual({
      group:
        "playwright-${{ github.event.workflow_run.pull_requests[0].number || github.event.workflow_run.id }}",
      "cancel-in-progress": true,
    });
  });

  it("pins the trusted control plane and executes the exact PR merge commit that produced the preview", () => {
    const trusted = step(
      "prepare",
      "Checkout trusted control plane from immutable workflow revision",
    );
    expect(trusted.uses).toMatch(/^actions\/checkout@/);
    expect(trusted.with?.ref).toBe("${{ github.workflow_sha }}");

    const workerTrusted = step(
      "attack-worker",
      "Checkout trusted browser controller from immutable workflow revision",
    );
    expect(workerTrusted.if).toBe(
      "${{ github.event.workflow_run.head_repository.full_name == github.repository }}",
    );
    expect(workerTrusted.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(workerTrusted.with?.["persist-credentials"]).toBe(false);

    const buildCandidate = step(
      "candidate-build",
      "Checkout exact tested PR merge for the one candidate build",
    );
    expect(buildCandidate.with?.ref).toBe(
      "${{ needs.prepare.outputs.tested_sha }}",
    );
    expect(buildCandidate.with?.["persist-credentials"]).toBe(false);

    expect(
      (job("attack-worker").steps ?? []).some(
        (entry) =>
          entry.name === "Checkout exact tested PR merge as application code",
      ),
    ).toBe(false);

    const fetchAndVerify = step(
      "prepare",
      "Fetch and verify exact PR head and tested merge commit as data only",
    );
    const fetchEnv = fetchAndVerify.env ?? {};
    const fetchRun = String(fetchAndVerify.run ?? "");
    expect(fetchEnv).not.toHaveProperty("EXPECTED_TESTED_SHA");
    expect(fetchRun).toContain("refs/pull/${PR_NUMBER}/merge:refs/autoflow/pr-merge");
    expect(fetchRun).toContain('git merge-base --is-ancestor "$FIRST_PARENT" refs/autoflow/swarm-main');
    expect(fetchRun).toContain('if [ "$live_base_ref" != "main" ]; then');
    expect(fetchRun).toContain("FETCHED_MERGE");
    expect(fetchRun).toContain("FIRST_PARENT");
    expect(fetchRun).toContain("SECOND_PARENT");
    expect(fetchEnv).not.toHaveProperty("EXPECTED_BASE_SHA");
    expect(fetchRun).toContain("EXPECTED_HEAD_SHA");
    expect(fetchRun).toContain("FIRST_PARENT");
    expect(fetchRun).toContain('echo "base_sha=$FIRST_PARENT" >> "$GITHUB_OUTPUT"');
    expect(fetchRun).toContain('echo "TESTED_SHA=$FETCHED_MERGE" >> "$GITHUB_ENV"');

    const plan = step(
      "prepare",
      "Assemble trusted run and fail closed on unsupported impact",
    );
    expect(plan.env).toHaveProperty("TESTED_SHA", "${{ env.TESTED_SHA }}");
  });

  it("reasserts same-repository trust at every privileged downstream job boundary", () => {
    for (const jobName of ["candidate-build", "verdict"]) {
      const condition = String(job(jobName).if ?? "");
      expect(condition).toContain(
        "github.event.workflow_run.event == 'pull_request'",
      );
      expect(condition).toContain(
        "github.event.workflow_run.head_repository.full_name == github.repository",
      );
      expect(condition).toContain(
        "github.event.workflow_run.pull_requests[0].number != null",
      );
    }
  });

  it("builds candidate frontend once with no reusable credentials and reuses only the verified artifact", () => {
    const build = step(
      "candidate-build",
      "Build exact tested candidate once in isolated container",
    );
    const buildEnv = build.env ?? {};
    for (const key of CANDIDATE_FORBIDDEN_ENV) {
      expect(buildEnv).not.toHaveProperty(key);
    }
    expect(buildEnv).toHaveProperty(
      "NEXT_PUBLIC_APP_URL",
      "http://127.0.0.1:3000",
    );
    expect(buildEnv).toHaveProperty(
      "VERCEL_GIT_COMMIT_SHA",
      "${{ needs.prepare.outputs.tested_sha }}",
    );
    expect(buildEnv).toHaveProperty("AUTOFLOW_SWARM_STANDALONE", "1");
    expect(String(build.run ?? "")).toContain("pnpm build");
    expect(String(build.run ?? "")).toContain("--cap-drop ALL");
    expect(String(build.run ?? "")).not.toContain("actions/cache");

    for (const jobName of ["trusted-e2e", "attack-worker"]) {
      const start = step(
        jobName,
        "Start verified exact-SHA candidate frontend artifact",
      );
      const env = start.env ?? {};
      for (const key of CANDIDATE_FORBIDDEN_ENV) {
        expect(env, jobName + " runtime must not receive " + key).not.toHaveProperty(
          key,
        );
      }
      const run = String(start.run ?? "");
      expect(run).toContain(
        "$RUNNER_TEMP/browser-swarm-candidate-build/runtime:/app:ro",
      );
      expect(run).toContain("node server.js");
      expect(run).not.toContain("pnpm install");
      expect(run).not.toContain("pnpm build");
    }

    const source = readFileSync(workflowPath, "utf8");
    expect(
      source.match(/Build exact tested candidate once in isolated container/g) ?? [],
    ).toHaveLength(1);
    expect(source).not.toContain("Build exact candidate frontend in isolated container");
  });

  it("scrubs the disposable preview to an explicit non-sensitive environment allowlist before candidate backend execution", () => {
    const trustedSteps = job("trusted-e2e").steps ?? [];
    const scrubIndex = trustedSteps.findIndex(
      (entry) =>
        entry.name ===
        "Scrub disposable preview environment before candidate execution",
    );
    const deployIndex = trustedSteps.findIndex(
      (entry) =>
        entry.name === "Deploy staged candidate backend with trusted Convex CLI",
    );
    expect(scrubIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(scrubIndex);

    const scrub = step(
      "trusted-e2e",
      "Scrub disposable preview environment before candidate execution",
    );
    const run = String(scrub.run ?? "");
    expect(scrub.env).toHaveProperty("CONVEX_PREVIEW_DEPLOY_KEY");
    expect(run).toContain("resolveConvexPreviewCredentials");
    expect(run).toContain("convex env list --names-only");
    expect(run).toContain("convex env remove");
    expect(run).toContain(
      "1x0000000000000000000000000000000AA",
    );
    for (const allowed of [
      "AUTOFLOW_DEPLOYMENT_CLASS",
      "CLERK_DEV_JWT_ISSUER_DOMAIN",
      "CLERK_JWT_ISSUER_DOMAIN",
      "NEXT_PUBLIC_APP_URL",
      "TURNSTILE_SECRET_KEY",
    ]) {
      expect(run).toContain(allowed);
    }
    expect(run).toContain(
      "Disposable preview environment does not match the trusted allowlist.",
    );
    expect(run).toContain('--url "$NEXT_PUBLIC_CONVEX_URL"');
    expect(run).toContain('--admin-key "$ADMIN_KEY"');
  });

  it("deploys the candidate backend only as staged data through the trusted Convex CLI (SCRUM-350)", () => {
    // The claim key is project-wide (run 36114902831), so it never reaches a
    // candidate-controlled install or CLI. Mounts, flags and ordering across
    // every workflow are pinned in convexCredentialBoundary.test.ts.
    const stage = step("trusted-e2e", "Stage exact candidate backend as data");
    expect(JSON.stringify(stage.env ?? {})).not.toContain("secrets.");
    const deploy = step(
      "trusted-e2e",
      "Deploy staged candidate backend with trusted Convex CLI",
    );
    const deployRun = String(deploy.run ?? "");
    expect(deploy.env).toHaveProperty("CONVEX_PREVIEW_DEPLOY_KEY");
    expect(deployRun).toContain("resolveConvexPreviewCredentials");
    expect(deployRun).toContain('"$RUNNER_TEMP/candidate-backend:/app:ro"');
    expect(deployRun).not.toContain("$GITHUB_WORKSPACE/candidate");
    expect(deployRun).not.toMatch(/\bpnpm\b/);
    expect(deployRun).toContain("--typecheck disable");
    expect(deployRun).not.toContain("--env CONVEX_PREVIEW_DEPLOY_KEY");
    expect(deployRun).not.toContain("--env CLERK_SECRET_KEY");
    expect(deployRun).toContain("--cap-drop ALL");
    expect(deployRun).toContain("--security-opt no-new-privileges");
  });

  it("keeps the one candidate build isolated and never gives workers candidate source or a mutable candidate cache", () => {
    const build = step(
      "candidate-build",
      "Build exact tested candidate once in isolated container",
    );
    const buildRun = String(build.run ?? "");
    expect(buildRun).toContain("docker run");
    expect(buildRun).toContain(
      "node:22.21.1-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
    );
    expect(buildRun).toContain("$GITHUB_WORKSPACE/candidate:/app");
    expect(buildRun).toContain("--cap-drop ALL");
    expect(buildRun).toContain("--security-opt no-new-privileges");
    expect(buildRun).not.toContain("/var/run/docker.sock");
    expect(buildRun).not.toContain("$GITHUB_WORKSPACE/trusted");

    const workflowSource = readFileSync(workflowPath, "utf8");
    expect(workflowSource).not.toContain("actions/cache@");
    expect(
      (job("attack-worker").steps ?? []).some((entry) =>
        String(entry.run ?? "").includes("$GITHUB_WORKSPACE/candidate:/app"),
      ),
    ).toBe(false);
  });

  it("publishes one same-run SHA-bound build artifact and every consumer independently verifies it", () => {
    const upload = step(
      "candidate-build",
      "Upload immutable exact-SHA candidate build",
    );
    expect(upload.with?.name).toBe(
      "trusted-candidate-build-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(upload.with?.["include-hidden-files"]).toBe(true);
    expect(upload.with?.["retention-days"]).toBe(1);

    for (const jobName of ["trusted-e2e", "attack-worker"]) {
      const download = step(jobName, "Download immutable exact-SHA candidate build");
      expect(download.uses).toBe(
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      );
      expect(download.with?.["artifact-ids"]).toBe(
        "${{ needs.candidate-build.outputs.artifact_id }}",
      );
      expect(download.with?.path).toBe(
        "${{ runner.temp }}/browser-swarm-candidate-build",
      );

      const verify = step(
        jobName,
        "Independently verify exact-SHA candidate build",
      );
      expect(String(verify.run ?? "")).toContain(
        "browserSwarmBuildArtifact.mjs verify",
      );
      expect(verify.env).toMatchObject({
        TESTED_SHA: "${{ needs.prepare.outputs.tested_sha }}",
        PR_NUMBER: "${{ needs.prepare.outputs.pr_number }}",
        BROWSER_SWARM_RUN_ID:
          "gh-${{ github.run_id }}-${{ github.run_attempt }}",
        CONTROLLER_SHA: "${{ github.workflow_sha }}",
        CONVEX_PREVIEW_NAME: "${{ needs.prepare.outputs.preview_name }}",
        NEXT_PUBLIC_CONVEX_URL:
          "${{ needs.prepare.outputs.convex_cloud_url }}",
      });
    }
  });

  it("spends the paid Jev call only after the disposable preview exists, just before its one consumer (SCRUM-376)", () => {
    // Every failed run between 2026-09-18 and 09-25 paid for a TypeSafe
    // request and then died recreating the preview (Convex deployment quota).
    const names = (job("prepare").steps ?? []).map((entry) => entry.name);
    const jevIndex = names.indexOf("Generate bounded Jev browser exploration once");
    const recreateIndex = names.indexOf("Recreate disposable Convex preview from trusted main");
    const resolveIndex = names.indexOf("Resolve named Convex preview from trusted control plane");
    const assembleIndex = names.indexOf("Assemble trusted run and fail closed on unsupported impact");
    expect(recreateIndex).toBeGreaterThanOrEqual(0);
    expect(resolveIndex).toBeGreaterThan(recreateIndex);
    expect(jevIndex).toBeGreaterThan(resolveIndex);
    expect(assembleIndex).toBe(jevIndex + 1);
  });

  it("calls Jev once in the trusted prepare job and gives workers only sanitized additive suggestions", () => {
    const jev = step(
      "prepare",
      "Generate bounded Jev browser exploration once",
    );
    expect(jev.run).toBe("pnpm browser-swarm:jev-exploration");
    expect(jev.env).toHaveProperty(
      "TYPESAFE_API_KEY",
      "${{ secrets.TYPESAFE_API_KEY }}",
    );
    expect(jev.env).toHaveProperty(
      "TESTED_SHA",
      "${{ steps.provenance.outputs.tested_sha }}",
    );

    const execute = step("attack-worker", "Execute trusted browser missions");
    expect(execute.env).toHaveProperty(
      "BROWSER_SWARM_JEV_SUGGESTIONS_JSON",
      "${{ needs.prepare.outputs.jev_suggestions_json }}",
    );
    expect(execute.env).not.toHaveProperty("TYPESAFE_API_KEY");

    expect(job("candidate-build").needs).toBe("prepare");
    expect(job("attack-worker").needs).toEqual([
      "prepare",
      "candidate-build",
      "trusted-e2e",
    ]);
  });

  it("revalidates the named preview before each worker and exact PR merge again before a success verdict", () => {
    const preview = step(
      "attack-worker",
      "Assert seeded preview from trusted control plane",
    );
    const previewRun = String(preview.run ?? "");
    expect(previewRun).toContain("resolveConvexPreviewAuthority");
    expect(previewRun).toContain(
      "Named preview was recreated underneath this swarm",
    );

    const fresh = step(
      "verdict",
      "Revalidate tested PR merge is still current",
    );
    const freshRun = String(fresh.run ?? "");
    expect(freshRun).toContain("refs/pull/${PR_NUMBER}/head");
    expect(freshRun).toContain("refs/pull/${PR_NUMBER}/merge");
    expect(freshRun).toContain("EXPECTED_HEAD_SHA");
    expect(freshRun).toContain("EXPECTED_TESTED_SHA");

    const verdict = step(
      "verdict",
      "Publish authoritative trusted swarm verdict",
    );
    expect(verdict.env).toHaveProperty(
      "FRESH_CURRENT",
      "${{ steps.freshness.outputs.fresh }}",
    );
    expect(String(verdict.run ?? "")).toContain(
      '[ "$FRESH_CURRENT" = "true" ]',
    );
  });

  it("treats the triggering workflow artifact as untrusted data, never as an extractable filesystem", () => {
    const run = String(
      step("prepare", "Download triggering E2E preview descriptor").run ?? "",
    );

    expect(run).toContain("artifact.size_in_bytes > 16384");
    expect(run).toContain("unzip -Z1");
    expect(run).toContain("unzip -p");
    expect(run).toContain("e2e-preview-descriptor.json");
    expect(run).not.toContain("unzip -q");
    expect(run).not.toMatch(/unzip\s+[^\n]*\s-d\s/);
  });

  it("keeps candidate handoff identity-only and resolves Convex URL from the trusted control plane", () => {
    const descriptor = playwrightStep("Write sanitized preview descriptor");
    expect(descriptor.env).not.toHaveProperty("NEXT_PUBLIC_CONVEX_URL");
    expect(descriptor.env).not.toHaveProperty("CONVEX_DEPLOY_KEY");

    const recreate = step(
      "prepare",
      "Recreate disposable Convex preview from trusted main",
    );
    expect(recreate.env).toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(String(recreate.run ?? "")).toContain("--preview-create");

    const authority = step(
      "prepare",
      "Resolve named Convex preview from trusted control plane",
    );
    expect(authority.run).toContain("convexPreviewAuthority.mjs");
    expect(authority.env).toHaveProperty("CONVEX_PREVIEW_DEPLOY_KEY");
    expect(authority.env).toHaveProperty("PR_NUMBER");

    const publish = step("prepare", "Publish trusted plan evidence");
    expect(String(publish.with?.path ?? "")).toContain(
      "browser-swarm-convex-authority.json",
    );

    const plan = step(
      "prepare",
      "Assemble trusted run and fail closed on unsupported impact",
    );
    expect(plan.env).not.toHaveProperty("NEXT_PUBLIC_CONVEX_URL");
  });

  it("authenticates only on trusted main and never retypes passwords into candidate code", () => {
    const auth = step(
      "attack-worker",
      "Authenticate E2E seats on trusted main frontend",
    );
    const authEnv = auth.env ?? {};
    expect(auth.run).toContain("auth.setup.ts");
    expect(authEnv).toHaveProperty("CLERK_SECRET_KEY");
    expect(authEnv).toHaveProperty("E2E_LOGIN_PASSWORD");
    expect(authEnv).toHaveProperty("E2E_APPROVER_PASSWORD");
    expect(authEnv).toHaveProperty(
      "PLAYWRIGHT_BASE_URL",
      "http://localhost:3000",
    );

    const attest = step(
      "attack-worker",
      "Assert seeded preview from trusted control plane",
    );
    expect(attest.env).toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(attest.env).toHaveProperty("CLERK_SECRET_KEY");
    expect(String(attest.run ?? "")).toContain("--assert-only");
    expect(String(attest.run ?? "")).toContain(
      "BROWSER_SWARM_PREVIEW_ATTESTED=1",
    );

    const execute = step("attack-worker", "Execute trusted browser missions");
    const env = execute.env ?? {};
    expect(execute.run).toContain("--no-deps");
    expect(env).not.toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(env).not.toHaveProperty("CLERK_SECRET_KEY");
    expect(env).not.toHaveProperty("E2E_LOGIN_USER");
    expect(env).not.toHaveProperty("E2E_APPROVER_USER");
    expect(env).toHaveProperty(
      "PLAYWRIGHT_BASE_URL",
      "http://localhost:3000",
    );
    expect(env).toHaveProperty(
      "BROWSER_SWARM_PREVIEW_ATTESTED",
      "${{ env.BROWSER_SWARM_PREVIEW_ATTESTED }}",
    );
    expect(env).toHaveProperty("BROWSER_SWARM_TRUSTED_EXTERNAL_SERVER", "1");
    expect(env).toHaveProperty("PLAYWRIGHT_SKIP_WEBSERVER", "1");
  });

  it("preserves exact candidate auth middleware and gives it only public JWT verification material", () => {
    const resolver = step(
      "attack-worker",
      "Resolve test-only Clerk public JWT verification key",
    );
    const resolverEnv = resolver.env ?? {};
    const resolverRun = String(resolver.run ?? "");
    expect(resolverEnv).toHaveProperty("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    expect(resolverEnv).not.toHaveProperty("CLERK_SECRET_KEY");
    expect(resolverRun).toContain("pk_test_*");
    expect(resolverRun).not.toContain("sk_test_*");
    expect(resolverRun).toContain("clerkPublicJwtKey.mjs");
    expect(resolverRun).toContain("CLERK_JWT_KEY");

    const allWorkerRun = (job("attack-worker").steps ?? [])
      .map((entry) => String(entry.run ?? ""))
      .join("\n");
    expect(allWorkerRun).not.toContain("candidate/proxy.ts");
    expect(allWorkerRun).not.toContain("candidate/middleware.ts");
    expect(allWorkerRun).not.toContain("candidate/src/proxy.ts");
    expect(allWorkerRun).not.toContain("candidate/src/middleware.ts");

    for (const stepName of [
      "Start verified exact-SHA candidate frontend artifact",
    ]) {
      const candidateStep = step("attack-worker", stepName);
      expect(candidateStep.env ?? {}).not.toHaveProperty("CLERK_SECRET_KEY");
      expect(String(candidateStep.run ?? "")).toContain("--env CLERK_JWT_KEY");
    }
  });

  it("runs the complete Playwright regression suite from trusted main against the exact candidate", () => {
    const run = step(
      "trusted-e2e",
      "Run full trusted E2E suite against exact candidate",
    );
    expect(run.run).toContain("playwright test --project=chromium --no-deps");
    expect(run.env).toHaveProperty("PLAYWRIGHT_SKIP_WEBSERVER", "1");
    expect(run.env).toHaveProperty(
      "NEXT_PUBLIC_CONVEX_URL",
      "${{ needs.prepare.outputs.convex_cloud_url }}",
    );
    expect(run.env).not.toHaveProperty("CLERK_SECRET_KEY");
    expect(run.env).not.toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(run.env).not.toHaveProperty("E2E_LOGIN_PASSWORD");
  });

  it("runs candidate runtime on an internal Docker network and cleans that network up", () => {
    const startRun = String(
      step(
        "attack-worker",
        "Start verified exact-SHA candidate frontend artifact",
      ).run ?? "",
    );
    expect(startRun).toContain("docker network create --internal");
    expect(startRun).toContain('--network "$CANDIDATE_NETWORK"');
    expect(startRun).toContain("--publish 127.0.0.1:3000:3000");
    expect(startRun).toContain("--cap-drop ALL");
    expect(startRun).toContain("--security-opt no-new-privileges");

    const stopRun = String(
      step("attack-worker", "Stop isolated candidate frontend").run ?? "",
    );
    expect(stopRun).toContain('docker network rm "$CANDIDATE_NETWORK"');
  });

  it("grants privileged workflow permissions only to the trusted jobs that need them", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
    });
    expect(job("prepare").permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(job("candidate-build").permissions).toEqual({
      contents: "read",
    });
    expect(job("trusted-e2e").permissions).toEqual({
      contents: "read",
    });
    expect(job("attack-worker").permissions).toEqual({
      contents: "read",
    });
    expect(job("verdict").permissions).toEqual({
      contents: "read",
      statuses: "write",
    });

    const pending = step(
      "prepare",
      "Mark trusted browser swarm pending on tested merge",
    );
    expect(pending.env).toHaveProperty("GITHUB_TOKEN", "${{ github.token }}");
    expect(String(pending.run ?? "")).toContain(
      "autoflow/trusted-browser-swarm",
    );
    expect(String(pending.run ?? "")).toContain("pending");
    expect(String(pending.run ?? "")).toContain(
      'Content-Type: application/json',
    );

    const verdict = step(
      "verdict",
      "Publish authoritative trusted swarm verdict",
    );
    const verdictRun = String(verdict.run ?? "");
    expect(verdict.env).toHaveProperty("GITHUB_TOKEN", "${{ github.token }}");
    expect(verdict.env).toHaveProperty(
      "TESTED_SHA",
      "${{ needs.prepare.outputs.tested_sha }}",
    );
    expect(verdict.env).toHaveProperty(
      "PREPARE_RESULT",
      "${{ needs.prepare.result }}",
    );
    expect(verdict.env).toHaveProperty(
      "TRUSTED_E2E_RESULT",
      "${{ needs.trusted-e2e.result }}",
    );
    expect(verdict.env).toHaveProperty(
      "ATTACK_RESULT",
      "${{ needs.attack-worker.result }}",
    );
    expect(verdict.env).toHaveProperty(
      "FRESH_CURRENT",
      "${{ steps.freshness.outputs.fresh }}",
    );
    expect(verdictRun).toContain('STATE=failure');
    expect(verdictRun).toContain('[ "$PREPARE_RESULT" = "success" ]');
    expect(verdictRun).toContain('[ "$TRUSTED_E2E_RESULT" = "success" ]');
    expect(verdictRun).toContain('[ "$SHOULD_RUN" = "false" ]');
    expect(verdictRun).toContain(
      '[ "$SHOULD_RUN" = "true" ] && [ "$ATTACK_RESULT" = "success" ]',
    );
    expect(verdictRun).toContain("autoflow/trusted-browser-swarm");
    expect(verdictRun).toContain("Content-Type: application/json");
    expect(verdictRun).toContain('if [ "$STATE" != "success" ]');
  });
});
