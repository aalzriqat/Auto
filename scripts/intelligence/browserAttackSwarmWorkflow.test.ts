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

  it("keeps the control plane on main and candidate code on the exact trusted head output", () => {
    const trusted = step("prepare", "Checkout trusted control plane from main");
    expect(trusted.uses).toMatch(/^actions\/checkout@/);
    expect(trusted.with?.ref).toBe("main");

    const workerTrusted = step(
      "attack-worker",
      "Checkout trusted browser controller from main",
    );
    expect(workerTrusted.with?.ref).toBe("main");
    expect(workerTrusted.with?.["persist-credentials"]).toBe(false);

    const candidate = step(
      "attack-worker",
      "Checkout exact candidate head as application code",
    );
    expect(candidate.with?.ref).toBe("${{ needs.prepare.outputs.head_sha }}");
    expect(candidate.with?.["persist-credentials"]).toBe(false);
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
      expect(run).not.toContain("/var/run/docker.sock");
      expect(run).not.toContain("$GITHUB_WORKSPACE/trusted");
    }
  });

  it("keeps preview/assertion credentials only in the trusted browser-controller step", () => {
    const env =
      step("attack-worker", "Execute trusted browser missions").env ?? {};

    expect(env).toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(env).toHaveProperty("CLERK_SECRET_KEY");
    expect(env).toHaveProperty("E2E_LOGIN_PASSWORD");
    expect(env).toHaveProperty("E2E_APPROVER_PASSWORD");
    expect(env).toHaveProperty("BROWSER_SWARM_TRUSTED_EXTERNAL_SERVER", "1");
    expect(env).toHaveProperty("PLAYWRIGHT_SKIP_WEBSERVER", "1");
  });

  it("keeps the workflow token read-only", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
  });
});
