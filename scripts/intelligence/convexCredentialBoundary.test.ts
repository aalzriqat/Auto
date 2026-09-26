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
 *   candidate package, binary or typescript ever runs beside the key;
 * - a credential-free audit before it proves every file that CLI's bundler
 *   reads lies inside the stage (Sol F1 on PR #341).
 *
 * The two staged container steps are recognised by their EXACT canonical
 * command, never by name: whatever else such a step runs is classified like
 * any other step (Sol F3 on PR #341). This file runs in the trusted controller
 * through `pnpm test:browser-swarm`, not only in candidate-controlled PR CI.
 */

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
  if?: string;
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
const AUDIT_STEP = "Audit staged backend inputs without credentials";
const STAGE_STEP = "Stage exact candidate backend as data";
const STAGED_DEPLOY_VOLUMES = [
  '"$RUNNER_TEMP/candidate-backend:/app:ro"',
  '"$GITHUB_WORKSPACE/trusted/node_modules:/app/node_modules:ro"',
];
const NODE_IMAGE =
  "node:22.21.1-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const CONTAINER_HARDENING =
  "--read-only --tmpfs /tmp:rw,size=512m --cap-drop ALL --security-opt no-new-privileges";

// The only container commands a staged step may run, character for character
// after joining continuation lines.
const CANONICAL_STAGED_COMMAND: Record<string, string> = {
  [STAGED_DEPLOY_STEP]:
    "docker run --rm --name autoflow-trusted-staged-backend-deploy --network bridge " +
    CONTAINER_HARDENING +
    " --volume " + STAGED_DEPLOY_VOLUMES.join(" --volume ") +
    ' --workdir /app --env HOME=/tmp/home --env NEXT_PUBLIC_CONVEX_URL --env CONVEX_PREVIEW_ADMIN_KEY="$ADMIN_KEY" ' +
    NODE_IMAGE +
    " sh -c 'exec node /app/node_modules/convex/bin/main.js deploy --url \"$NEXT_PUBLIC_CONVEX_URL\" --admin-key \"$CONVEX_PREVIEW_ADMIN_KEY\" --typecheck disable --codegen disable'",
  [AUDIT_STEP]:
    "docker run --rm --name autoflow-staged-backend-input-audit --network none " +
    CONTAINER_HARDENING +
    " --volume " + STAGED_DEPLOY_VOLUMES.join(" --volume ") +
    ' --volume "$GITHUB_WORKSPACE/trusted/scripts/intelligence/auditStagedBackendInputs.mjs:/audit/auditStagedBackendInputs.mjs:ro"' +
    " --workdir /app --env HOME=/tmp/home " +
    NODE_IMAGE +
    " node /audit/auditStagedBackendInputs.mjs",
};

function normalizeRun(run: string): string {
  return run.replace(/\\\r?\n\s*/g, " ").replace(/[ \t]+/g, " ");
}

/**
 * The part of a step's script that is NOT its canonical staged container
 * command. For every other step, the whole script.
 */
function residualRun(step: Step): string {
  const run = normalizeRun(String(step.run ?? ""));
  const canonical = step.name ? CANONICAL_STAGED_COMMAND[step.name] : undefined;
  if (!canonical || run.split(canonical).length !== 2) return run;
  return run.replace(canonical, " ");
}

function holdsConvexCredential(step: Step): boolean {
  return CONVEX_SECRET.test(JSON.stringify(step.env ?? {}));
}

function dockerVolumes(run: string): string[] {
  return [...run.matchAll(/--volume\s+("[^"]+"|\S+)/g)].map((match) => match[1] ?? "");
}

/**
 * Candidate-controlled code runs in this step: a container over the candidate
 * checkout, its built runtime or its staged backend, a candidate working
 * directory, or a direct invocation from it. A staged step's exact canonical
 * command parses candidate code without executing it, so only that command is
 * set aside; the rest of the step is judged like any other.
 */
function executesCandidate(step: Step): boolean {
  const run = residualRun(step);
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

  it("sets aside only a staged step's exact canonical command, never the step's name (Sol F3 on PR #341)", () => {
    for (const name of [STAGED_DEPLOY_STEP, AUDIT_STEP]) {
      const canonical = CANONICAL_STAGED_COMMAND[name] as string;
      expect(executesCandidate({ name, run: canonical }), name).toBe(false);
      // Candidate code appended to the named step.
      expect(executesCandidate({ name, run: canonical + "\nnode candidate/scripts/exfil.mjs" }), name).toBe(true);
      // The canonical command altered: the stage mount is then judged as a candidate container.
      expect(
        executesCandidate({ name, run: canonical.replace("--network", "--volume \"$RUNNER_TEMP/x:/x\" --network") }),
        name,
      ).toBe(true);
      // The canonical command run twice is not the canonical step.
      expect(executesCandidate({ name, run: canonical + "\n" + canonical }), name).toBe(true);
    }
    // Every real staged step is exactly canonical, with nothing container-shaped left over.
    for (const { label, job } of everyJob()) {
      for (const step of job.steps ?? []) {
        if (!step.name || !(step.name in CANONICAL_STAGED_COMMAND)) continue;
        const run = normalizeRun(String(step.run ?? ""));
        expect(run.split(CANONICAL_STAGED_COMMAND[step.name] as string).length, label + " :: " + step.name).toBe(2);
        expect(residualRun(step), label + " :: " + step.name).not.toMatch(/\bdocker\b/);
      }
    }
  });

  it("is run by the trusted controller, not only by candidate-controlled PR CI (Sol F3 on PR #341)", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const command = pkg.scripts["test:browser-swarm"] ?? "";
    for (const file of [
      "scripts/intelligence/convexCredentialBoundary.test.ts",
      "scripts/intelligence/stageCandidateBackend.test.ts",
      "scripts/intelligence/auditStagedBackendInputs.test.ts",
    ]) {
      expect(command).toContain(file);
    }
    const swarm = readFileSync(path.join(workflowsDir, "browser-attack-swarm.yml"), "utf8");
    expect(swarm).toContain("pnpm test:browser-swarm");
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

  it("runs docker beside a credential only as the staged deploy's canonical command", () => {
    for (const { label, job } of everyJob()) {
      for (const step of job.steps ?? []) {
        if (!holdsConvexCredential(step)) continue;
        if (!/\bdocker\b/.test(String(step.run ?? ""))) continue;
        expect(step.name, label).toBe(STAGED_DEPLOY_STEP);
        expect(residualRun(step), label).not.toMatch(/\bdocker\b/);
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

  it("stages and audits the candidate backend with no credential, immediately before the deploy that consumes it", () => {
    for (const { label, job } of everyJob()) {
      const steps = job.steps ?? [];
      const deployIndex = steps.findIndex((step) => step.name === STAGED_DEPLOY_STEP);
      if (deployIndex < 0) continue;
      const stageIndex = steps.findIndex((step) => step.name === STAGE_STEP);
      const auditIndex = steps.findIndex((step) => step.name === AUDIT_STEP);
      expect(stageIndex, label).toBeGreaterThanOrEqual(0);
      // Nothing runs between the audit and the deploy it licenses.
      expect([stageIndex, auditIndex, deployIndex], label).toEqual([deployIndex - 2, deployIndex - 1, deployIndex]);
      const audit = steps[auditIndex] as Step;
      expect(JSON.stringify(audit.env ?? {}), label).not.toMatch(/secrets\./);
      expect(String(audit.run ?? ""), label).not.toMatch(CREDENTIAL_NAME);
      expect(String(audit.if ?? ""), label).toBe(String((steps[deployIndex] as Step).if ?? ""));
      const stage = steps[stageIndex] as Step;
      expect(JSON.stringify(stage.env ?? {}), label).not.toMatch(/secrets\./);
      expect(String(stage.run ?? ""), label).toContain(
        "trusted/scripts/intelligence/stageCandidateBackend.mjs",
      );
    }
  });
});
