// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { selectForPr } from "./prRunner.mjs";
import { createLocalScenarioEvidence } from "./prScenarioEvidence.mjs";
import { runScenarioCompletionCommand } from "./scenarioCompletionCli.mjs";

const directories: string[] = [];
const record = { id: "ordinary-ledger", level: "backend", domain: "money", status: "active",
  fingerprint: "d".repeat(64), impl: { file: "ledger.test.ts", testName: "keeps the total" } };
const browser = { id: "supplier-p7-browser-ar", level: "browser", domain: "screen", status: "active",
  fingerprint: "e".repeat(64), sourceGlobs: ["screen.ts"],
  impl: { file: "playwright/tests/supplier-identity.spec.ts", testName: "supplier in Arabic" } };

function fixture(adopted = true, protectedReplay = false) {
  const root = mkdtempSync(path.join(tmpdir(), "autoflow-completion-cli-"));
  const scratch = mkdtempSync(path.join(tmpdir(), "autoflow-completion-cli-"));
  directories.push(root, scratch);
  const config = path.join(scratch, "empty.gitconfig");
  writeFileSync(config, "");
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config };
  const git = (...args: string[]) => execFileSync(resolveTrustedGitExecutable(), args, {
    cwd: root, env: gitEnv, encoding: "utf8", timeout: 5_000, stdio: "pipe",
  }).trim();
  git("init", "-q", "--template=");
  git("config", "user.name", "Completion fixture");
  git("config", "user.email", "fixture@example.test");
  mkdirSync(path.join(root, "regression/scenarios"), { recursive: true });
  writeFileSync(path.join(root, "regression/scenarios/ledger.scenario.json"), JSON.stringify(record));
  if (protectedReplay) {
    mkdirSync(path.join(root, "regression/scenarios/screen"));
    writeFileSync(path.join(root, `regression/scenarios/screen/${browser.id}.scenario.json`), JSON.stringify(browser));
  }
  writeFileSync(path.join(root, "regression/rulings.json"), "[]");
  writeFileSync(path.join(root, "screen.ts"), "base\n");
  if (adopted) {
    mkdirSync(path.join(root, "scripts/regression"), { recursive: true });
    writeFileSync(path.join(root, "scripts/regression/scenarioCompletionCli.mjs"), "// Protected adoption marker.\n");
  }
  git("add", ".");
  git("commit", "-qm", "protected base");
  const baseSha = git("rev-parse", "HEAD");
  git("checkout", "-qb", "candidate");
  writeFileSync(path.join(root, "screen.ts"), "candidate\n");
  // Candidate source must remain a Git object, even when it offers an executable.
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {
    postinstall: `touch ${path.join(scratch, "candidate-executed")}`,
  } }));
  git("add", ".");
  git("commit", "-qm", "candidate change");
  const headSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", baseSha);
  git("merge", "-q", "--no-ff", "--no-edit", headSha);
  const testedSha = git("rev-parse", "HEAD");
  git("update-ref", "refs/pull/12/merge", testedSha);
  git("checkout", "-q", "--detach", baseSha);
  git("remote", "add", "origin", root);
  const candidate = { repositoryId: 42, prNumber: 12, baseSha, headSha, testedSha, workflowRunId: 200, workflowAttempt: 2 };
  const pull = { number: 12, state: "open", draft: false,
    base: { ref: "main", sha: baseSha, repo: { id: 42 } }, head: { sha: headSha, repo: { id: 42 } } };
  const localRun = { id: 200, run_attempt: 2, workflow_id: 77, path: ".github/workflows/scenario-runner.yml",
    event: "pull_request", head_sha: headSha, head_repository: { id: 42 }, repository: { id: 42 },
    pull_requests: [{ number: 12, base: pull.base, head: pull.head }], status: "in_progress", conclusion: null as string | null };
  const publicationRoute = `/commits/${headSha}/check-runs?check_name=authenticated-pr-e2e&filter=all&per_page=100`;
  const responses = new Map<string, unknown>([
    ["/pulls/12", pull],
    ["/git/ref/pull/12/merge", { ref: "refs/pull/12/merge", object: { type: "commit", sha: testedSha } }],
    [`/git/commits/${testedSha}`, { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }] }],
    ["/actions/workflows/scenario-runner.yml", { id: 77, path: localRun.path }],
    [`/actions/workflows/scenario-runner.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`, { total_count: 1, workflow_runs: [localRun] }],
    ["/actions/runs/200", localRun],
    [publicationRoute, { total_count: 0, check_runs: [] }],
  ]);
  const checks: Record<string, unknown>[] = [];
  const checkRoute = `/commits/${testedSha}/check-runs?check_name=pr-scenario-runner&filter=all&per_page=100`;
  const request = vi.fn((method: string, route: string, body?: Record<string, unknown>) => {
    if (method === "GET") {
      if (route === checkRoute) return structuredClone({ total_count: checks.length, check_runs: checks });
      if (!responses.has(route)) throw new Error(`Unexpected fixture API route: ${route}`);
      return structuredClone(responses.get(route));
    }
    if (method === "POST" && route === "/check-runs") {
      const check = { ...body, id: 501, head_sha: testedSha, app: { slug: "github-actions" } };
      checks.push(check);
      return structuredClone(check);
    }
    if (method === "PATCH" && route === "/check-runs/501" && checks.length === 1) {
      Object.assign(checks[0], body);
      return structuredClone(checks[0]);
    }
    throw new Error("Unexpected fixture mutation");
  });
  const api = (route: string) => request("GET", route);
  const archiveDirectory = path.join(scratch, "archive");
  mkdirSync(archiveDirectory);
  const localRaw = createLocalScenarioEvidence(candidate, {
    selection: selectForPr(protectedReplay ? [record, browser] : [record], ["package.json", "screen.ts"]), issues: [],
    verdicts: [{ id: record.id, code: "PASS" }], browserVerdicts: protectedReplay ? [{ id: browser.id, code: "BROWSER_REPLAY_NOT_EXECUTED" }] : [],
  });
  writeFileSync(path.join(archiveDirectory, "scenario-evidence-1.json"), localRaw);
  const archivePath = path.join(scratch, "evidence.zip");
  const zip = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "/usr/bin/zip";
  const zipFlag = process.platform === "win32" ? "-acf" : "-q";
  execFileSync(zip, [zipFlag, archivePath, "scenario-evidence-1.json"], { cwd: archiveDirectory, timeout: 5_000 });
  const archive = readFileSync(archivePath);
  const artifact = { id: 99, name: "pr-local-scenarios-200-2", expired: false,
    size_in_bytes: archive.length, digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    created_at: "2026-11-21T00:03:00Z", updated_at: "2026-11-21T00:03:01Z",
    workflow_run: { id: 200, repository_id: 42, head_repository_id: 42, head_sha: headSha } };
  responses.set("/actions/runs/200/attempts/2/jobs?per_page=100", { total_count: 1, jobs: [{
    id: 201, name: "local-scenarios", run_id: 200, run_attempt: 2, status: "completed", conclusion: "success",
    started_at: "2026-11-21T00:01:00Z", completed_at: "2026-11-21T00:04:00Z",
    steps: ["Run the static visual projects", "Run the library's bound local scenarios", "Publish the selected local verdicts and bindings"]
      .map((name, index) => ({ name, number: index + 1, status: "completed", conclusion: "success" })),
  }] });
  responses.set("/actions/runs/200/artifacts?name=pr-local-scenarios-200-2&per_page=100", { total_count: 1, artifacts: [artifact] });
  responses.set("/actions/artifacts/99", artifact);
  const archives = new Map([[99, archive]]);
  const check = { id: 301, name: "authenticated-pr-e2e", app: { slug: "github-actions" }, head_sha: headSha,
    external_id: "g5:12:300:1", status: "completed", conclusion: "success",
    output: { summary: `Tested backend and frontend merge: ${testedSha}` } };
  if (protectedReplay) {
    const producerRun = { id: 300, run_attempt: 1, workflow_id: 78, event: "workflow_run",
      path: ".github/workflows/browser-attack-swarm.yml", repository: { id: 42 }, head_repository: { id: 42 },
      head_branch: "main", head_sha: baseSha, status: "completed", conclusion: "success" };
    const browserDirectory = path.join(scratch, "browser");
    mkdirSync(browserDirectory);
    writeFileSync(path.join(browserDirectory, "evidence.json"), JSON.stringify({ headSha, testedSha, controllerSha: baseSha,
      executedDefinitions: ["supplier-identity.spec.ts"],
      supplierArabicReplay: { id: browser.id, code: "PASS", producerRunId: "300", producerAttempt: "1" } }));
    const filename = path.join(scratch, "browser.zip");
    execFileSync(zip, [zipFlag, filename, "evidence.json"], { cwd: browserDirectory, timeout: 5_000 });
    const bytes = readFileSync(filename);
    archives.set(98, bytes);
    const browserArtifact = { id: 98, name: "trusted-g5-evidence-300-1", expired: false,
      size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      workflow_run: { id: 300, repository_id: 42, head_repository_id: 42, head_branch: "main", head_sha: baseSha } };
    responses.set(publicationRoute, { total_count: 1, check_runs: [check] });
    responses.set("/actions/workflows/browser-attack-swarm.yml", { id: 78, path: producerRun.path });
    responses.set("/actions/runs/300", producerRun);
    responses.set("/actions/runs/300/artifacts?name=trusted-g5-evidence-300-1&per_page=100", { total_count: 1, artifacts: [browserArtifact] });
    responses.set("/actions/artifacts/98", browserArtifact);
    responses.set("/actions/runs/300/attempts/1/jobs?per_page=100", { total_count: 2, jobs:
      ["trusted-e2e", "authenticated-pr-e2e-publish"].map(name => ({ name, run_id: 300, run_attempt: 1, status: "completed", conclusion: "success" })) });
  }
  const downloadZip = vi.fn((id: number) => {
    const bytes = archives.get(id);
    if (!bytes) throw new Error("Unexpected fixture archive");
    return bytes;
  });
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "fixture/Auto", GITHUB_REPOSITORY_ID: "42",
    GITHUB_RUN_ID: "400", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKFLOW_SHA: baseSha,
    GITHUB_WORKFLOW_REF: "fixture/Auto/.github/workflows/scenario-completion.yml@refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_run", SCENARIO_PR_NUMBER: "12",
    GITHUB_EVENT_PATH: path.join(scratch, "event.json"), GITHUB_OUTPUT: path.join(scratch, "output") };
  const transport = { api, request, receipts: { api, downloadZip } };
  const log = vi.fn();
  return { input: { root, args: ["verify"], env, transport, log }, candidate, pull, localRun, responses,
    checks, request, downloadZip, git, scratch, log, check, publicationRoute };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== tmpdir() || !path.basename(directory).startsWith("autoflow-completion-cli-")) {
      throw new Error("Unsafe completion fixture cleanup");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

it("releases the callback while the producer runs and publishes a blocking exact-merge verdict", async () => {
  const { input, checks, downloadZip, candidate, git, scratch } = fixture();
  await expect(runScenarioCompletionCommand(input)).resolves.toMatchObject({ kind: "pending" });
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ name: "pr-scenario-runner", head_sha: candidate.testedSha,
    status: "completed", conclusion: "failure", external_id: `scenario:12:${candidate.testedSha}` });
  expect(downloadZip).not.toHaveBeenCalled();
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  expect(existsSync(path.join(scratch, "candidate-executed"))).toBe(false);
});

it("publishes success only after the existing local archive and exact-merge aggregation pass", async () => {
  const { input, localRun, checks, downloadZip, scratch, candidate, log } = fixture();
  Object.assign(localRun, { status: "completed", conclusion: "success" });
  await expect(runScenarioCompletionCommand(input)).resolves.toMatchObject({ kind: "success", counts: { selected: 1, passed: 1 } });
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ conclusion: "success", output: { summary: expect.stringContaining("Selected scenarios: 1. Passed scenarios: 1.") } });
  expect(log).toHaveBeenCalledExactlyOnceWith(`Scenario completion check 501 for PR 12, merge ${candidate.testedSha}: success.`);
  expect(downloadZip).toHaveBeenCalledExactlyOnceWith(99);
  expect(existsSync(path.join(scratch, "candidate-executed"))).toBe(false);
});

it("revokes success for a new source attempt without starting any tests", async () => {
  const value = fixture();
  Object.assign(value.localRun, { status: "completed", conclusion: "success" });
  await runScenarioCompletionCommand(value.input);
  Object.assign(value.localRun, { run_attempt: 3, status: "in_progress", conclusion: null });
  value.downloadZip.mockClear();
  await expect(runScenarioCompletionCommand(value.input)).resolves.toMatchObject({ kind: "pending" });
  expect(value.checks).toHaveLength(1);
  expect(value.checks[0]).toMatchObject({ conclusion: "failure", output: { text: expect.stringContaining("attempt 3") } });
  expect(value.downloadZip).not.toHaveBeenCalled();
});

it("keeps a prior base on its existing native certification gate", async () => {
  const { input, checks, downloadZip } = fixture(false);
  await expect(runScenarioCompletionCommand(input)).resolves.toEqual({ kind: "legacy" });
  expect(checks).toEqual([]);
  expect(downloadZip).not.toHaveBeenCalled();
});

it("leaves the check blocking when a producer changes during archive verification", async () => {
  const { input, localRun, checks, downloadZip, git } = fixture();
  Object.assign(localRun, { status: "completed", conclusion: "success" });
  const original = downloadZip.getMockImplementation()!;
  downloadZip.mockImplementation(id => {
    localRun.run_attempt++;
    localRun.status = "in_progress";
    localRun.conclusion = null;
    return original(id);
  });
  await expect(runScenarioCompletionCommand(input)).rejects.toThrow("SCENARIO_COMPLETION_CONTEXT_CHANGED");
  expect(checks).toHaveLength(1);
  expect(checks[0].conclusion).toBe("failure");
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
});

it("joins completed browser and local producers into the same exact-merge verdict", async () => {
  const { input, localRun, checks, downloadZip } = fixture(true, true);
  Object.assign(localRun, { status: "completed", conclusion: "success" });
  await expect(runScenarioCompletionCommand(input)).resolves.toMatchObject({ kind: "success", counts: { selected: 2, passed: 2 } });
  expect(checks).toHaveLength(1);
  expect(checks[0].conclusion).toBe("success");
  expect(downloadZip.mock.calls.map(([id]) => id).sort()).toEqual([98, 99]);
});

it.each(["browser publication", "local run inventory"])("revokes prior success when the %s is unavailable", async source => {
  const { input, localRun, checks, responses, candidate, publicationRoute, downloadZip } = fixture(true, true);
  Object.assign(localRun, { status: "completed", conclusion: "success" });
  await expect(runScenarioCompletionCommand(input)).resolves.toMatchObject({ kind: "success" });
  const missingRoute = source === "browser publication" ? publicationRoute :
    `/actions/workflows/scenario-runner.yml/runs?event=pull_request&head_sha=${candidate.headSha}&per_page=100`;
  responses.delete(missingRoute);
  downloadZip.mockClear();

  await expect(runScenarioCompletionCommand(input)).rejects.toThrow("Unexpected fixture API route");
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ conclusion: "failure", head_sha: candidate.testedSha });
  expect(downloadZip).not.toHaveBeenCalled();
});

it("refuses stale receipt reads even when the initial and final live snapshots agree", async () => {
  const { input, localRun, checks, check, publicationRoute } = fixture(true, true);
  Object.assign(localRun, { status: "completed", conclusion: "success" });
  const oldPublication = structuredClone(check);
  check.output.summary = "The current publication no longer proves this merge.";
  const liveApi = input.transport.api;
  input.transport.receipts.api = route => route === publicationRoute
    ? { total_count: 1, check_runs: [oldPublication] } : liveApi(route);
  await expect(runScenarioCompletionCommand(input)).resolves.toMatchObject({ kind: "failure", code: "SCENARIO_EVIDENCE_INVALID" });
  expect(checks).toHaveLength(1);
  expect(checks[0].conclusion).toBe("failure");
});

it("refuses a moved merge ref before reading or executing candidate files", async () => {
  const { input, candidate, git, checks } = fixture();
  git("update-ref", "refs/pull/12/merge", candidate.headSha);
  await expect(runScenarioCompletionCommand(input)).rejects.toThrow("SCENARIO_COMPLETION_CONTEXT_CHANGED");
  expect(checks).toEqual([]);
});

it("resolves admission from the live PR rather than trusting event identities", async () => {
  const { input, pull } = fixture();
  input.args = ["resolve"];
  input.env.GITHUB_EVENT_NAME = "pull_request_target";
  writeFileSync(input.env.GITHUB_EVENT_PATH, JSON.stringify({ action: "synchronize", repository: { id: 42, full_name: "fixture/Auto" }, pull_request: pull }));
  await expect(runScenarioCompletionCommand(input)).resolves.toMatchObject({ mode: "admission", targets: [{ prNumber: 12 }] });
  expect(readFileSync(input.env.GITHUB_OUTPUT, "utf8")).toBe(`targets=${JSON.stringify([{ prNumber: 12, headSha: pull.head.sha, baseSha: pull.base.sha }])}\n`);
});

it.each([
  ["GITHUB_ACTIONS", "false"], ["GITHUB_WORKFLOW_REF", "fixture/Auto/.github/workflows/scenario-completion.yml@refs/heads/candidate"],
  ["GITHUB_WORKFLOW_SHA", "short"], ["GITHUB_EVENT_NAME", "pull_request"], ["GITHUB_RUN_ATTEMPT", "0"],
])("refuses an untrusted controller environment: %s", async (key, value) => {
  const { input, request } = fixture();
  await expect(runScenarioCompletionCommand({ ...input, env: { ...input.env, [key]: value } })).rejects.toThrow("SCENARIO_COMPLETION_ENVIRONMENT_INVALID");
  expect(request).not.toHaveBeenCalled();
});
