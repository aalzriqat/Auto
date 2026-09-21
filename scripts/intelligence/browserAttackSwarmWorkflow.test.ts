import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

type WorkflowStep = {
  name?: string;
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
const playwrightWorkflow = parseYaml(
  readFileSync(
    path.resolve(process.cwd(), ".github/workflows/playwright.yml"),
    "utf8",
  ),
) as Workflow;

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
    expect(workerTrusted.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(workerTrusted.with?.["persist-credentials"]).toBe(false);

    const candidate = step(
      "attack-worker",
      "Checkout exact tested PR merge as application code",
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

  it("never exposes privileged secrets to candidate-controlled build or server processes", () => {
    for (const stepName of [
      "Build exact candidate frontend in isolated container",
      "Start exact candidate frontend in isolated container",
    ]) {
      const env = step("attack-worker", stepName).env ?? {};
      for (const key of CANDIDATE_FORBIDDEN_ENV) {
        expect(env, stepName + " must not receive " + key).not.toHaveProperty(key);
      }
    }
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

    const execute = step("attack-worker", "Execute trusted browser missions");
    const env = execute.env ?? {};
    expect(execute.run).toContain("--no-deps");
    expect(env).toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(env).toHaveProperty("CLERK_SECRET_KEY");
    expect(env).toHaveProperty("E2E_LOGIN_USER");
    expect(env).toHaveProperty("E2E_APPROVER_USER");
    expect(env).toHaveProperty(
      "PLAYWRIGHT_BASE_URL",
      "http://localhost:3000",
    );
    expect(env).not.toHaveProperty("E2E_LOGIN_PASSWORD");
    expect(env).not.toHaveProperty("E2E_LOGIN_VERIFICATION_CODE");
    expect(env).not.toHaveProperty("E2E_APPROVER_PASSWORD");
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
    expect(resolverEnv).toHaveProperty("CLERK_SECRET_KEY");
    expect(resolverRun).toContain("pk_test_*");
    expect(resolverRun).toContain("sk_test_*");
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

  it("grants only the explicit commit-status write needed for the trusted verdict bridge", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
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
      "ATTACK_RESULT",
      "${{ needs.attack-worker.result }}",
    );
    expect(verdictRun).toContain('STATE=failure');
    expect(verdictRun).toContain('[ "$PREPARE_RESULT" = "success" ]');
    expect(verdictRun).toContain('[ "$SHOULD_RUN" = "false" ]');
    expect(verdictRun).toContain(
      '[ "$SHOULD_RUN" = "true" ] && [ "$ATTACK_RESULT" = "success" ]',
    );
    expect(verdictRun).toContain("autoflow/trusted-browser-swarm");
    expect(verdictRun).toContain("Content-Type: application/json");
    expect(verdictRun).toContain('if [ "$STATE" != "success" ]');
  });
});
