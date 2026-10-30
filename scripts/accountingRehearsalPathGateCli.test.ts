// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { parse } from "yaml";
import { readBackendChangeDecision, runPathGateStep } from "./accountingRehearsalPathGateCli.mjs";

const directory = mkdtempSync(path.join(tmpdir(), "scrum883-path-gate-"));
afterAll(() => {
  if (!path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), "scrum883-path-gate-"))) {
    throw new Error("Refusing cleanup outside the test directory");
  }
  rmSync(directory, { recursive: true, force: true });
});
const git = (...args: string[]) => execFileSync("git", [
  "-c", "user.name=Rehearsal Test", "-c", "user.email=rehearsal@example.test", ...args,
], { cwd: directory, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

test("fetched Git objects give a complete PR diff, detect renamed backend files and fail closed on missing objects", () => {
  git("init", "--initial-branch=main");
  mkdirSync(path.join(directory, "convex"));
  mkdirSync(path.join(directory, "docs"));
  writeFileSync(path.join(directory, "convex", "backend.ts"), "export const value = 1;\n");
  git("add", "--", "convex/backend.ts");
  git("commit", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  writeFileSync(path.join(directory, "docs", "notes.md"), "frontend-only evidence\n");
  git("add", "--", "docs/notes.md");
  git("commit", "-m", "docs only");
  const docsHead = git("rev-parse", "HEAD");
  expect(readBackendChangeDecision({ baseSha, headSha: docsHead, testedSha: docsHead, cwd: directory })).toMatchObject({ run: false, baseSha, headSha: docsHead });
  renameSync(path.join(directory, "convex", "backend.ts"), path.join(directory, "docs", "backend.ts"));
  git("add", "--", "convex/backend.ts", "docs/backend.ts");
  git("commit", "-m", "move backend out of deploy tree");
  const movedHead = git("rev-parse", "HEAD");
  expect(readBackendChangeDecision({ baseSha, headSha: movedHead, testedSha: movedHead, cwd: directory }).run).toBe(true);
  expect(readBackendChangeDecision({ baseSha, headSha: "f".repeat(40), testedSha: "f".repeat(40), cwd: directory }).run).toBe(true);
  expect(readBackendChangeDecision({ baseSha, headSha: baseSha, testedSha: baseSha, cwd: directory }).run).toBe(true);
});

test("a test merge that carries a PR edit into a backend path RUNS, even when the branch never touched it", () => {
  const repo = mkdtempSync(path.join(directory, "merge-"));
  const run = (...args: string[]) => execFileSync("git", [
    "-c", "user.name=Rehearsal Test", "-c", "user.email=rehearsal@example.test", ...args,
  ], { cwd: repo, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  run("init", "--initial-branch=main");
  mkdirSync(path.join(repo, "app"));
  mkdirSync(path.join(repo, "lib"));
  const body = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
  writeFileSync(path.join(repo, "app", "shared.ts"), body);
  run("add", "--", "app/shared.ts");
  run("commit", "-m", "base");
  run("checkout", "-b", "pr");
  writeFileSync(path.join(repo, "app", "shared.ts"), body.replace("v0 = 0", "v0 = 42"));
  run("add", "--", "app/shared.ts");
  run("commit", "-m", "pr edits app/shared.ts");
  const headSha = run("rev-parse", "HEAD");
  run("checkout", "main");
  run("mv", "app/shared.ts", "lib/shared.ts");
  run("commit", "-m", "main moves the helper into lib/");
  const baseSha = run("rev-parse", "HEAD");
  run("merge", "--no-ff", "--no-edit", "pr");
  const testedSha = run("rev-parse", "HEAD");
  expect(readFileSync(path.join(repo, "lib", "shared.ts"), "utf8")).toContain("v0 = 42");
  // The branch-only diff the gate used before sees no backend path: the fail-open this test pins.
  expect(run("diff", "--name-only", "--no-renames", `${baseSha}...${headSha}`)).toBe("app/shared.ts");
  expect(readBackendChangeDecision({ baseSha, headSha, testedSha, cwd: repo })).toMatchObject({ run: true, testedSha });
});

test("an unlocatable git binary fails closed: the rehearsal RUNS", () => {
  const sha = "a".repeat(40);
  expect(readBackendChangeDecision({ baseSha: sha, headSha: "b".repeat(40), testedSha: "c".repeat(40), cwd: directory, findGit: () => undefined }).run).toBe(true);
  expect(readBackendChangeDecision({ baseSha: "", headSha: sha, testedSha: sha, cwd: directory }).run).toBe(true);
});

test("the workflow step writes the evidence file, the step output and a summary naming both SHAs", () => {
  const out = mkdtempSync(path.join(directory, "step-"));
  const output = path.join(out, "output.txt");
  const summary = path.join(out, "summary.md");
  const baseSha = git("rev-list", "--max-parents=0", "HEAD");
  const headSha = git("rev-parse", "HEAD");
  const decision = runPathGateStep({ cwd: directory, env: { BASE_SHA: baseSha, HEAD_SHA: headSha, TESTED_SHA: headSha, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
  expect(decision.run).toBe(true);
  expect(readFileSync(output, "utf8")).toBe("run_rehearsal=true\n");
  expect(readFileSync(summary, "utf8")).toContain(`Base: ${baseSha}. Head: ${headSha}. Tested merge: ${headSha}.`);
  expect(JSON.parse(readFileSync(path.join(directory, "backend-input-evidence.json"), "utf8"))).toMatchObject({ run: true, baseSha, headSha });
});

type Step = { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, {
  name?: string; if?: string; permissions?: Record<string, string>; steps: Step[];
}> };
const source = readFileSync(".github/workflows/trusted-accounting-rehearsal.yml", "utf8");
const workflow: Workflow = parse(source);

test("PR path decision precedes preview creation; release bypasses it and retains its distinct verdict", () => {
  const steps = workflow.jobs.rehearsal.steps;
  const gate = steps.findIndex(step => step.id === "backend_inputs");
  const create = steps.findIndex(step => step.name?.startsWith("Name and recreate"));
  expect(gate).toBeGreaterThan(steps.findIndex(step => step.id === "provenance"));
  expect(gate).toBeLessThan(create);
  expect(steps[gate]?.if).toContain("github.event_name == 'workflow_run'");
  expect(steps[gate]?.run).toBe("node scripts/accountingRehearsalPathGateCli.mjs");
  expect(steps[create]?.if).toContain("github.event_name == 'repository_dispatch' || steps.backend_inputs.outputs.run_rehearsal == 'true'");
  expect(workflow.on).not.toHaveProperty("schedule");
  expect(workflow.jobs.release_verdict.if).toBe("always() && github.event_name == 'repository_dispatch'");
  expect(workflow.jobs.release_verdict.name).toContain("trusted-accounting-release-not-dispatched");
  expect(Object.values(workflow.jobs).flatMap(job => job.steps).every(step => !step.run?.includes("${{"))).toBe(true);
});

test("NOT_APPLICABLE publishes a neutral PR check with both SHAs and cannot publish a success status", () => {
  const verdict = workflow.jobs.verdict;
  expect(verdict.permissions?.checks).toBe("write");
  const neutral = verdict.steps.find(step => step.name?.startsWith("Publish NOT_APPLICABLE"));
  expect(neutral?.if).toContain("needs.rehearsal.outputs.run_rehearsal == 'false'");
  // Execute the exact payload program used by the trusted workflow, with no HTTP request.
  const program = neutral?.run?.match(/node -e '([\s\S]*?)'\)/)?.[1];
  expect(program).toBeTruthy();
  const payload = JSON.parse(execFileSync(process.execPath, ["-e", program ?? ""], { encoding: "utf8", env: {
    NODE_ENV: "test", TESTED_SHA: "a".repeat(40), BASE_SHA: "b".repeat(40), HEAD_SHA: "c".repeat(40),
  } }));
  expect(payload).toMatchObject({ name: "autoflow/trusted-accounting-rehearsal", head_sha: "a".repeat(40), conclusion: "neutral",
    output: { title: "NOT_APPLICABLE: no backend input changed" } });
  expect(payload.output.summary).toContain("b".repeat(40));
  expect(payload.output.summary).toContain("c".repeat(40));
  expect(payload.output.summary).toContain("No preview was created");
  expect(verdict.steps.find(step => step.name === "Publish trusted accounting rehearsal verdict")?.if)
    .toBe("needs.rehearsal.outputs.run_rehearsal != 'false' || needs.rehearsal.result != 'success'");
});
