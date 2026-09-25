import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * SCRUM-350: the Convex preview credential is PROJECT-WIDE. Run 36114902831
 * proved that `claim_preview_deployment` hands back the preview deploy key
 * itself, accepted by every preview, so no step can be given "a key for just
 * this preview". The only boundary left is which code runs while a key is
 * present, and this file is what holds that boundary in place:
 *
 * - no step that executes candidate-controlled code holds a Convex credential;
 * - in every job, each credential-holding step runs before the first
 *   candidate-executing step, so no live credential sits beside a running
 *   candidate container;
 * - no credential is written to $GITHUB_ENV, $GITHUB_OUTPUT or a job output;
 * - the one step that deploys the candidate backend runs the TRUSTED Convex
 *   CLI in a container that sees exactly the staged backend and the trusted
 *   node_modules, both read-only, with typecheck and codegen off, so no
 *   candidate package, binary or typescript ever runs beside the key.
 */

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

type Job = {
  env?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  steps?: Step[];
};

type Workflow = { env?: Record<string, unknown>; jobs?: Record<string, Job> };

const workflowsDir = path.resolve(process.cwd(), ".github/workflows");

const workflows = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({
    name,
    workflow: parseYaml(readFileSync(path.join(workflowsDir, name), "utf8")) as Workflow,
  }));

const CONVEX_SECRET = /secrets\.CONVEX_[A-Z0-9_]+/;
// Anything a step could carry a resolved credential in, besides env.
const CREDENTIAL_NAME = /ADMIN_KEY|DEPLOY_KEY|OPERATOR_KEY|OBSERVER_KEY/;

const STAGED_DEPLOY_STEP = "Deploy staged candidate backend with trusted Convex CLI";
const STAGE_STEP = "Stage exact candidate backend as data";
const STAGED_DEPLOY_VOLUMES = [
  '"$RUNNER_TEMP/candidate-backend:/app:ro"',
  '"$GITHUB_WORKSPACE/trusted/node_modules:/app/node_modules:ro"',
];

function holdsConvexCredential(step: Step): boolean {
  return CONVEX_SECRET.test(JSON.stringify(step.env ?? {}));
}

function dockerVolumes(run: string): string[] {
  return [...run.matchAll(/--volume\s+("[^"]+"|\S+)/g)].map((match) => match[1] ?? "");
}

/**
 * Candidate-controlled code runs in this step: a container over the candidate
 * checkout or its built runtime, a candidate working directory, or a direct
 * invocation from it. The staged deploy mounts the stage instead, and its
 * trusted CLI never executes candidate code, so it is classified separately.
 */
function executesCandidate(step: Step): boolean {
  if (step.name === STAGED_DEPLOY_STEP) return false;
  const run = String(step.run ?? "");
  const workingDirectory = String(step["working-directory"] ?? "");
  if (/^candidate(\/|$)/.test(workingDirectory)) return true;
  if (/(^|\s|;|&&)cd\s+"?candidate\b/.test(run)) return true;
  // A direct invocation of anything under the candidate checkout, with no cd
  // and no container (Sonnet F-2 on PR #341).
  if (/\b(node|bash|sh|python3?|pnpm|npm|npx|tsx|deno|bun)\b[^\n]*?[\s"'=/]candidate\//.test(run)) {
    return true;
  }
  if (!/\bdocker\s+run\b/.test(run)) return false;
  return dockerVolumes(run).some(
    (volume) =>
      volume.includes("/candidate:") ||
      volume.includes("/candidate\"") ||
      volume.includes("candidate-build/runtime") ||
      volume.includes("candidate-backend"),
  );
}

function everyJob(): Array<{ label: string; workflow: Workflow; job: Job }> {
  return workflows.flatMap(({ name, workflow }) =>
    Object.entries(workflow.jobs ?? {}).map(([jobName, job]) => ({
      label: name + " :: " + jobName,
      workflow,
      job,
    })),
  );
}

function stagedDeploySteps(): Array<{ label: string; step: Step }> {
  return everyJob().flatMap(({ label, job }) =>
    (job.steps ?? [])
      .filter((step) => step.name === STAGED_DEPLOY_STEP)
      .map((step) => ({ label, step })),
  );
}

describe("Convex credential boundary across every workflow (SCRUM-350)", () => {
  it("classifies the candidate steps it guards (the guard is not vacuous)", () => {
    const candidateSteps = everyJob().flatMap(({ job }) =>
      (job.steps ?? []).filter(executesCandidate),
    );
    // Swarm: build, trusted-e2e frontend, one per worker; rehearsal: none after
    // the staged deploy. A classifier that matched nothing would pass anything.
    expect(candidateSteps.length).toBeGreaterThanOrEqual(3);
  });

  it("recognises every way a step can run candidate code, and not trusted code that merely names it", () => {
    for (const run of [
      "node candidate/scripts/x.mjs",
      "bash candidate/x.sh",
      'pnpm --dir "$GITHUB_WORKSPACE" exec tsx candidate/y.ts',
      "cd candidate && pnpm test",
      'docker run --volume "$GITHUB_WORKSPACE/candidate:/app" img',
    ]) {
      expect(executesCandidate({ name: "synthetic", run }), run).toBe(true);
    }
    expect(executesCandidate({ name: "synthetic", "working-directory": "candidate", run: "ls" })).toBe(true);
    for (const run of [
      "node trusted/scripts/intelligence/stageCandidateBackend.mjs",
      "node trusted/scripts/intelligence/browserSwarmBuildArtifact.mjs verify",
      'echo "candidate backend staged"',
    ]) {
      expect(executesCandidate({ name: "synthetic", run }), run).toBe(false);
    }
  });

  it("never sets a Convex credential at workflow or job level, where every step would inherit it", () => {
    for (const { label, workflow, job } of everyJob()) {
      expect(JSON.stringify(workflow.env ?? {}), label).not.toMatch(CONVEX_SECRET);
      expect(JSON.stringify(job.env ?? {}), label).not.toMatch(CONVEX_SECRET);
    }
  });

  it("gives no step that executes candidate code a Convex credential", () => {
    for (const { label, job } of everyJob()) {
      for (const step of job.steps ?? []) {
        if (!executesCandidate(step)) continue;
        const where = label + " :: " + String(step.name);
        expect(holdsConvexCredential(step), where).toBe(false);
        expect(String(step.run ?? ""), where).not.toMatch(CREDENTIAL_NAME);
      }
    }
  });

  it("runs every credential-holding step before the first candidate-executing step of its job", () => {
    for (const { label, job } of everyJob()) {
      const steps = job.steps ?? [];
      const firstCandidate = steps.findIndex(executesCandidate);
      if (firstCandidate < 0) continue;
      steps.forEach((step, index) => {
        if (holdsConvexCredential(step)) {
          expect(index, label + " :: " + String(step.name)).toBeLessThan(firstCandidate);
        }
      });
    }
  });

  it("never writes a credential into $GITHUB_ENV, $GITHUB_OUTPUT or a job output", () => {
    for (const { label, job } of everyJob()) {
      expect(JSON.stringify(job.outputs ?? {}), label).not.toMatch(CONVEX_SECRET);
      expect(JSON.stringify(job.outputs ?? {}), label).not.toMatch(CREDENTIAL_NAME);
      for (const step of job.steps ?? []) {
        for (const line of String(step.run ?? "").split("\n")) {
          if (!/GITHUB_(ENV|OUTPUT)/.test(line)) continue;
          expect(line, label + " :: " + String(step.name)).not.toMatch(CREDENTIAL_NAME);
        }
      }
    }
  });

  it("runs docker beside a credential only in the staged candidate backend deploy", () => {
    for (const { label, job } of everyJob()) {
      for (const step of job.steps ?? []) {
        if (!holdsConvexCredential(step)) continue;
        if (!/\bdocker\s+run\b/.test(String(step.run ?? ""))) continue;
        expect(step.name, label).toBe(STAGED_DEPLOY_STEP);
      }
    }
  });

  it("deploys the candidate backend in both PR lanes only through the staged, trusted-CLI step", () => {
    const labels = stagedDeploySteps().map(({ label }) => label).sort();
    expect(labels).toEqual([
      "browser-attack-swarm.yml :: trusted-e2e",
      "trusted-accounting-rehearsal.yml :: rehearsal",
    ]);
  });

  it("gives the staged deploy container exactly the stage and trusted node_modules, read-only, and the trusted CLI", () => {
    for (const { label, step } of stagedDeploySteps()) {
      const run = String(step.run ?? "");
      expect(dockerVolumes(run), label).toEqual(STAGED_DEPLOY_VOLUMES);
      for (const flag of [
        "--read-only",
        "--cap-drop ALL",
        "--security-opt no-new-privileges",
        "--tmpfs /tmp",
        "node /app/node_modules/convex/bin/main.js deploy",
        "--typecheck disable",
        "--codegen disable",
      ]) {
        expect(run, label).toContain(flag);
      }
      // No package manager: it would read candidate-adjacent config and could
      // resolve a different convex binary than the trusted lockfile's.
      expect(run, label).not.toMatch(/\b(pnpm|npm|npx|corepack|yarn)\b/);
      expect(run, label).not.toContain("--typecheck enable");
      expect(run, label).not.toContain("--typecheck try");
      expect(run, label).not.toContain("--env CONVEX_PREVIEW_DEPLOY_KEY");
    }
  });

  it("stages the candidate backend with no credential and before the deploy that consumes it", () => {
    for (const { label, job } of everyJob()) {
      const steps = job.steps ?? [];
      const deployIndex = steps.findIndex((step) => step.name === STAGED_DEPLOY_STEP);
      if (deployIndex < 0) continue;
      const stageIndex = steps.findIndex((step) => step.name === STAGE_STEP);
      expect(stageIndex, label).toBeGreaterThanOrEqual(0);
      expect(stageIndex, label).toBeLessThan(deployIndex);
      const stage = steps[stageIndex] as Step;
      expect(JSON.stringify(stage.env ?? {}), label).not.toMatch(/secrets\./);
      expect(String(stage.run ?? ""), label).toContain(
        "trusted/scripts/intelligence/stageCandidateBackend.mjs",
      );
    }
  });
});
