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
  permissions?: Record<string, string>;
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

    const candidate = step(
      "attack-worker",
      "Checkout exact tested PR merge as application code",
    );
    expect(candidate.if).toBe(
      "${{ github.event.workflow_run.head_repository.full_name == github.repository }}",
    );
    expect(candidate.with?.ref).toBe("${{ needs.prepare.outputs.tested_sha }}");
    expect(candidate.with?.["persist-credentials"]).toBe(false);

    const fetchAndVerify = step(
      "prepare",
      "Fetch and verify exact PR head and tested merge commit as data only",
    );
    const fetchEnv = fetchAndVerify.env ?? {};
    const fetchRun = String(fetchAndVerify.run ?? "");
    expect(fetchEnv).not.toHaveProperty("EXPECTED_TESTED_SHA");
    expect(fetchRun).toContain("refs/pull/${PR_NUMBER}/merge:refs/autoflow/pr-merge");
    expect(fetchRun).toContain("FETCHED_MERGE");
    expect(fetchRun).toContain("FIRST_PARENT");
    expect(fetchRun).toContain("SECOND_PARENT");
    expect(fetchRun).toContain("EXPECTED_BASE_SHA");
    expect(fetchRun).toContain("EXPECTED_HEAD_SHA");
    expect(fetchRun).toContain('echo "TESTED_SHA=$FETCHED_MERGE" >> "$GITHUB_ENV"');

    const plan = step(
      "prepare",
      "Assemble trusted run and fail closed on unsupported impact",
    );
    expect(plan.env).toHaveProperty("TESTED_SHA", "${{ env.TESTED_SHA }}");
  });

  it("never exposes reusable credentials to candidate frontend processes", () => {
    for (const jobName of ["trusted-e2e", "attack-worker"]) {
      for (const stepName of [
        "Build exact candidate frontend in isolated container",
        "Start exact candidate frontend in isolated container",
      ]) {
        const env = step(jobName, stepName).env ?? {};
        for (const key of CANDIDATE_FORBIDDEN_ENV) {
          expect(
            env,
            jobName + " :: " + stepName + " must not receive " + key,
          ).not.toHaveProperty(key);
        }
        expect(env).toHaveProperty(
          "NEXT_PUBLIC_APP_URL",
          "http://127.0.0.1:3000",
        );
      }
    }
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
        entry.name ===
        "Deploy exact candidate backend with disposable preview credential",
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

  it("deploys candidate backend only with a deployment-scoped preview credential", () => {
    const deploy = step(
      "trusted-e2e",
      "Deploy exact candidate backend with disposable preview credential",
    );
    const deployRun = String(deploy.run ?? "");
    expect(deploy.env).toHaveProperty("CONVEX_PREVIEW_DEPLOY_KEY");
    expect(deployRun).toContain("resolveConvexPreviewCredentials");
    expect(deployRun).toContain("--env CONVEX_PREVIEW_ADMIN_KEY=");
    expect(deployRun).toContain('--admin-key "$CONVEX_PREVIEW_ADMIN_KEY"');
    expect(deployRun).not.toContain("--env CONVEX_PREVIEW_DEPLOY_KEY");
    expect(deployRun).not.toContain("--env CLERK_SECRET_KEY");
    expect(deployRun).not.toContain("$GITHUB_WORKSPACE/trusted:/");
    expect(deployRun).toContain("--cap-drop ALL");
    expect(deployRun).toContain("--security-opt no-new-privileges");
  });

  it("runs candidate-controlled code only inside the pinned isolation container", () => {
    for (const stepName of [
      "Build exact candidate frontend in isolated container",
      "Start exact candidate frontend in isolated container",
    ]) {
      const run = String(step("attack-worker", stepName).run ?? "");
      expect(run).toContain("docker run");
      expect(run).toContain(
        "node:22.21.1-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
      );
      expect(run).toContain('$GITHUB_WORKSPACE/candidate:/app');
      expect(run).toContain("--cap-drop ALL");
      expect(run).toContain("--security-opt no-new-privileges");
      expect(run).not.toContain("/var/run/docker.sock");
      expect(run).not.toContain("$GITHUB_WORKSPACE/trusted");
    }
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
      "Build exact candidate frontend in isolated container",
      "Start exact candidate frontend in isolated container",
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
        "Start exact candidate frontend in isolated container",
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
      statuses: "write",
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
