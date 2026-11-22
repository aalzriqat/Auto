// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { selectForPr } from "./prRunner.mjs";
import { createLocalScenarioEvidence } from "./prScenarioEvidence.mjs";
import { evaluateScenarioCompletion, matchesScenarioCompletionEvidenceSnapshot, selectProtectedScenarioReplays } from "./scenarioCompletionEvidence.mjs";

const parent = tmpdir();
const directories: string[] = [];
const backend = { id: "ordinary-ledger", level: "backend", domain: "money", status: "active",
  fingerprint: "d".repeat(64), impl: { file: "ledger.test.ts", testName: "keeps the total" } };
const browser = { id: "supplier-p7-browser-ar", level: "browser", domain: "screen", status: "active",
  fingerprint: "e".repeat(64), sourceGlobs: ["screen.ts"],
  impl: { file: "playwright/tests/supplier-identity.spec.ts", testName: "supplier in Arabic" } };
const requiredSteps = ["Run the static visual projects", "Run the library's bound local scenarios",
  "Publish the selected local verdicts and bindings"];

function fixture(protectedReplay = false) {
  const checkout = mkdtempSync(path.join(parent, "autoflow-completion-evidence-"));
  const scratch = mkdtempSync(path.join(parent, "autoflow-completion-evidence-"));
  directories.push(checkout, scratch);
  const emptyConfig = path.join(scratch, "empty.gitconfig");
  writeFileSync(emptyConfig, "");
  const gitEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(gitEnv)) if (/^GIT_/iu.test(name)) delete gitEnv[name];
  Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig });
  const git = (...args: string[]) => execFileSync(resolveTrustedGitExecutable(), args, {
    cwd: checkout, env: gitEnv, encoding: "utf8", timeout: 5_000, stdio: "pipe",
  }).trim();
  git("init", "-q", "--template=");
  git("config", "user.name", "Completion fixture");
  git("config", "user.email", "fixture@example.test");
  mkdirSync(path.join(checkout, "regression/scenarios/screen"), { recursive: true });
  writeFileSync(path.join(checkout, "regression/scenarios/ordinary-ledger.scenario.json"), JSON.stringify(backend));
  if (protectedReplay) writeFileSync(path.join(checkout, `regression/scenarios/screen/${browser.id}.scenario.json`), JSON.stringify(browser));
  writeFileSync(path.join(checkout, "regression/rulings.json"), "[]");
  writeFileSync(path.join(checkout, "screen.ts"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base fixture");
  const baseSha = git("rev-parse", "HEAD");
  git("checkout", "-qb", "candidate");
  writeFileSync(path.join(checkout, "screen.ts"), "candidate\n");
  git("commit", "-qam", "candidate fixture");
  const headSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", baseSha);
  git("merge", "-q", "--no-ff", "--no-edit", headSha);
  const testedSha = git("rev-parse", "HEAD");
  git("update-ref", "refs/autoflow/scenario-merge", testedSha);
  git("checkout", "-q", "--detach", baseSha);
  const candidate = { repositoryId: 42, prNumber: 12, baseSha, headSha, testedSha, workflowRunId: 200, workflowAttempt: 2 };
  const localRun = { id: 200, run_attempt: 2, workflow_id: 77, event: "pull_request",
    path: ".github/workflows/scenario-runner.yml", repository: { id: 42 }, head_repository: { id: 42 },
    head_sha: headSha, status: "completed", conclusion: "success" as string | null };
  const localJob = { id: 201, name: "local-scenarios", run_id: 200, run_attempt: 2,
    status: "completed", conclusion: "success", started_at: "2026-11-21T00:01:00Z", completed_at: "2026-11-21T00:04:00Z",
    steps: requiredSteps.map((name, index) => ({ name, number: index + 1, status: "completed", conclusion: "success" })) };
  const responses = new Map<string, unknown>();
  const archives = new Map<number, Buffer>();
  const archive = (id: number, entries: Record<string, string>) => {
    const directory = path.join(scratch, String(id));
    mkdirSync(directory, { recursive: true });
    for (const [name, raw] of Object.entries(entries)) writeFileSync(path.join(directory, name), raw);
    const filename = path.join(directory, "evidence.zip");
    const zip = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "/usr/bin/zip";
    execFileSync(zip, [process.platform === "win32" ? "-acf" : "-q", filename, ...Object.keys(entries)], { cwd: directory, timeout: 5_000 });
    const bytes = readFileSync(filename);
    archives.set(id, bytes);
    return { size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  };
  const records = protectedReplay ? [backend, browser] : [backend];
  const selection = selectForPr(records, ["screen.ts"]);
  const localRaw = createLocalScenarioEvidence(candidate, { selection, issues: [],
    verdicts: [{ id: backend.id, code: "PASS" }],
    browserVerdicts: protectedReplay ? [{ id: browser.id, code: "BROWSER_REPLAY_NOT_EXECUTED" }] : [] });
  const artifact = { id: 99, name: "pr-local-scenarios-200-2", expired: false,
    ...archive(99, { "scenario-evidence-1.json": localRaw }),
    created_at: "2026-11-21T00:03:00Z", updated_at: "2026-11-21T00:03:01Z",
    workflow_run: { id: 200, repository_id: 42, head_repository_id: 42, head_sha: headSha } };
  const localJobsRoute = "/actions/runs/200/attempts/2/jobs?per_page=100";
  const localArtifactsRoute = "/actions/runs/200/artifacts?name=pr-local-scenarios-200-2&per_page=100";
  responses.set(localJobsRoute, { total_count: 1, jobs: [localJob] });
  responses.set(localArtifactsRoute, { total_count: 1, artifacts: [artifact] });
  responses.set("/actions/artifacts/99", artifact);
  const publicationRoute = `/commits/${headSha}/check-runs?check_name=authenticated-pr-e2e&filter=all&per_page=100`;
  const check = { id: 301, name: "authenticated-pr-e2e", app: { slug: "github-actions" }, head_sha: headSha,
    external_id: "g5:12:300:1", status: "completed", conclusion: "success" as string | null,
    output: { summary: `Tested backend and frontend merge: ${testedSha}` } };
  const producerRun = { id: 300, run_attempt: 1, workflow_id: 78, event: "workflow_run",
    path: ".github/workflows/browser-attack-swarm.yml", repository: { id: 42 }, head_repository: { id: 42 },
    head_branch: "main", head_sha: baseSha, status: "completed", conclusion: "success" as string | null };
  const evidence = { headSha, testedSha, controllerSha: baseSha, executedDefinitions: ["supplier-identity.spec.ts"],
    supplierArabicReplay: { id: browser.id, code: "PASS", producerRunId: "300", producerAttempt: "1" } };
  const browserArtifact = { id: 98, name: "trusted-g5-evidence-300-1", expired: false,
    ...archive(98, { "evidence.json": JSON.stringify(evidence) }),
    workflow_run: { id: 300, repository_id: 42, head_repository_id: 42, head_branch: "main", head_sha: baseSha } };
  const browserJobs = ["trusted-e2e", "authenticated-pr-e2e-publish"].map(name => ({ name, run_id: 300,
    run_attempt: 1, status: "completed", conclusion: "success" }));
  responses.set(publicationRoute, { total_count: 1, check_runs: [check] });
  responses.set("/actions/workflows/browser-attack-swarm.yml", { id: 78, path: producerRun.path });
  responses.set("/actions/runs/300", producerRun);
  responses.set("/actions/runs/300/artifacts?name=trusted-g5-evidence-300-1&per_page=100", { total_count: 1, artifacts: [browserArtifact] });
  responses.set("/actions/artifacts/98", browserArtifact);
  responses.set("/actions/runs/300/attempts/1/jobs?per_page=100", { total_count: 2, jobs: browserJobs });
  responses.set("/pulls/12", { number: 12, state: "open", draft: false,
    base: { ref: "main", sha: baseSha, repo: { id: 42 } }, head: { sha: headSha, repo: { id: 42 } } });
  responses.set("/git/ref/pull/12/merge", { ref: "refs/pull/12/merge", object: { type: "commit", sha: testedSha } });
  responses.set(`/git/commits/${testedSha}`, { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }] });
  const api = vi.fn((route: string) => {
    if (!responses.has(route)) throw new Error("Unexpected fixture API route");
    return responses.get(route);
  });
  const downloadZip = vi.fn((id: number) => {
    if (!archives.has(id)) throw new Error("Unexpected fixture artifact");
    return archives.get(id)!;
  });
  const input = { checkout, candidate, localRun, api, downloadZip, env: { GITHUB_REPOSITORY: "fixture/Auto" } };
  return { input, localJob, artifact, check, producerRun, browserArtifact, browserJobs, archives, responses,
    localJobsRoute, localArtifactsRoute, publicationRoute, git, localRaw, archive, evidence };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith("autoflow-completion-evidence-")) {
      throw new Error("Unsafe completion fixture cleanup path");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([false, true])("selects protected replay dependencies from the exact base and merge (%s)", protectedReplay => {
  const { input } = fixture(protectedReplay);
  expect(selectProtectedScenarioReplays(input)).toEqual(protectedReplay ? [browser] : []);
  expect(input.api).not.toHaveBeenCalled();
});

it("refuses an unreadable base registry when selecting protected replay dependencies", () => {
  const { input } = fixture();
  writeFileSync(path.join(input.checkout, "regression/scenarios/ordinary-ledger.scenario.json"), "invalid json");
  expect(() => selectProtectedScenarioReplays(input)).toThrow("SCENARIO_REGISTRY_INVALID");
});

it.each(["requested", "queued", "pending", "waiting", "in_progress"])("returns pending immediately while local production is %s", status => {
  const { input } = fixture();
  Object.assign(input.localRun, { status, conclusion: null });
  expect(evaluateScenarioCompletion(input)).toMatchObject({ kind: "pending", code: "LOCAL_SCENARIOS_PENDING" });
  expect(input.api).not.toHaveBeenCalled();
  expect(input.downloadZip).not.toHaveBeenCalled();
});

it.each(["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", null])("fails immediately for a terminal local producer with %s", conclusion => {
  const { input } = fixture();
  input.localRun.conclusion = conclusion;
  expect(evaluateScenarioCompletion(input)).toMatchObject({ kind: "failure", code: "LOCAL_SCENARIOS_FAILED" });
  expect(input.api).not.toHaveBeenCalled();
});

it("verifies the exact published local archive without executing the bound tests again", () => {
  const { input } = fixture();
  const result = evaluateScenarioCompletion(input);
  expect(result).toMatchObject({ kind: "success", code: "SCENARIO_EVIDENCE_COMPLETE", counts: { selected: 1, passed: 1, failed: 0 } });
  expect(Object.values(result.counts!)).toEqual(expect.arrayContaining([1, 0]));
  expect(Object.values(result.counts!).every(value => Number.isSafeInteger(value))).toBe(true);
  expect(input.downloadZip).toHaveBeenCalledExactlyOnceWith(99);
  expect(input.api.mock.calls.map(([route]) => route).some(route => route.includes("/check-runs?"))).toBe(false);
  expect(new Set(input.api.mock.calls.map(([route]) => route)).size).toBe(input.api.mock.calls.length);
});

it("reuses the existing protected receipt verifier and exact candidate aggregation", () => {
  const { input, check } = fixture(true);
  const result = evaluateScenarioCompletion(input);
  expect(result).toMatchObject({ kind: "success", code: "SCENARIO_EVIDENCE_COMPLETE", counts: { selected: 2, passed: 2, failed: 0 } });
  expect(input.downloadZip.mock.calls.map(([id]) => id).sort()).toEqual([98, 99]);
  expect(new Set(input.api.mock.calls.map(([route]) => route)).size).toBe(input.api.mock.calls.length);
  expect(JSON.parse(result.fingerprint!)).toEqual({
    localRun: { id: 200, attempt: 2, status: "completed", conclusion: "success", headSha: input.candidate.headSha, workflowId: 77 },
    publication: { id: 301, externalId: "g5:12:300:1", status: "completed", conclusion: "success", headSha: input.candidate.headSha,
      summaryDigest: createHash("sha256").update(check.output.summary).digest("hex") },
    producerRun: { id: 300, attempt: 1, status: "completed", conclusion: "success", headSha: input.candidate.baseSha, workflowId: 78 },
  });
});

it.each(["queued", "waiting", "in_progress"])("returns without downloading or polling while protected production is %s", status => {
  const { input, producerRun, check } = fixture(true);
  Object.assign(producerRun, { status, conclusion: null });
  Object.assign(check, { status: "in_progress", conclusion: null });
  expect(evaluateScenarioCompletion(input)).toMatchObject({ kind: "pending", code: "BROWSER_EVIDENCE_PENDING" });
  expect(input.downloadZip).not.toHaveBeenCalled();
  expect(input.api.mock.calls.filter(([route]) => route === "/actions/runs/300")).toHaveLength(1);
});

it("waits without occupying a runner when the protected publication has not appeared", () => {
  const { input, responses, publicationRoute } = fixture(true);
  responses.set(publicationRoute, { total_count: 0, check_runs: [] });
  expect(evaluateScenarioCompletion(input)).toMatchObject({ kind: "pending", code: "BROWSER_EVIDENCE_PENDING" });
  expect(input.downloadZip).not.toHaveBeenCalled();
});

it("invalidates the old receipt as soon as the protected producer is rerun", () => {
  const { input, producerRun } = fixture(true);
  Object.assign(producerRun, { run_attempt: 2, status: "in_progress", conclusion: null });
  const result = evaluateScenarioCompletion(input);
  expect(result).toMatchObject({ kind: "pending", code: "BROWSER_EVIDENCE_PENDING" });
  expect(JSON.parse(result.fingerprint!).producerRun.attempt).toBe(2);
  expect(input.downloadZip).not.toHaveBeenCalled();
});

it.each(["failure", "cancelled", "timed_out"])("fails a terminal protected producer with %s even if its check never completed", conclusion => {
  const { input, producerRun, check } = fixture(true);
  producerRun.conclusion = conclusion;
  Object.assign(check, { status: "in_progress", conclusion: null, output: { summary: "" } });
  expect(evaluateScenarioCompletion(input)).toMatchObject({ kind: "failure", code: "BROWSER_EVIDENCE_INVALID" });
  expect(input.downloadZip).not.toHaveBeenCalled();
});

const localRefusals: [string, (value: ReturnType<typeof fixture>) => void, string][] = [
  ["another local attempt", ({ input }) => { input.localRun.run_attempt++; }, "SCENARIO_CERTIFICATION_UNAVAILABLE"],
  ["another local workflow", ({ input }) => { input.localRun.path = ".github/workflows/other.yml"; }, "SCENARIO_CERTIFICATION_UNAVAILABLE"],
  ["a local run from a fork", ({ input }) => { input.localRun.head_repository.id++; }, "SCENARIO_CERTIFICATION_UNAVAILABLE"],
  ["an unknown local status", ({ input }) => { input.localRun.status = "unknown"; }, "SCENARIO_CERTIFICATION_UNAVAILABLE"],
  ["a partial jobs inventory", ({ responses, localJobsRoute, localJob }) => { responses.set(localJobsRoute, { total_count: 2, jobs: [localJob] }); }, "SCENARIO_EVIDENCE_INVALID"],
  ["duplicate local jobs", ({ responses, localJobsRoute, localJob }) => { responses.set(localJobsRoute, { total_count: 2, jobs: [localJob, localJob] }); }, "SCENARIO_EVIDENCE_INVALID"],
  ["a previous job attempt", ({ localJob }) => { localJob.run_attempt--; }, "SCENARIO_EVIDENCE_INVALID"],
  ["a failed local job", ({ localJob }) => { localJob.conclusion = "failure"; }, "SCENARIO_EVIDENCE_INVALID"],
  ["a missing static execution", ({ localJob }) => { localJob.steps.shift(); }, "SCENARIO_EVIDENCE_INVALID"],
  ["a skipped local execution", ({ localJob }) => { localJob.steps[1].conclusion = "skipped"; }, "SCENARIO_EVIDENCE_INVALID"],
  ["an unsuccessful upload", ({ localJob }) => { localJob.steps[2].conclusion = "failure"; }, "SCENARIO_EVIDENCE_INVALID"],
  ["a duplicate upload step", ({ localJob }) => { localJob.steps.push(localJob.steps[2]); }, "SCENARIO_EVIDENCE_INVALID"],
  ["invalid job timestamps", ({ localJob }) => { localJob.completed_at = "invalid"; }, "SCENARIO_EVIDENCE_INVALID"],
  ["a partial artifacts inventory", ({ responses, localArtifactsRoute, artifact }) => { responses.set(localArtifactsRoute, { total_count: 2, artifacts: [artifact] }); }, "SCENARIO_EVIDENCE_INVALID"],
  ["duplicate artifacts", ({ responses, localArtifactsRoute, artifact }) => { responses.set(localArtifactsRoute, { total_count: 2, artifacts: [artifact, artifact] }); }, "SCENARIO_EVIDENCE_INVALID"],
  ["another artifact name", ({ artifact }) => { artifact.name = "pr-local-scenarios-200-1"; }, "SCENARIO_EVIDENCE_INVALID"],
  ["an expired artifact", ({ artifact }) => { artifact.expired = true; }, "SCENARIO_EVIDENCE_INVALID"],
  ["a missing artifact digest", ({ artifact }) => { artifact.digest = ""; }, "SCENARIO_EVIDENCE_INVALID"],
  ["an oversized artifact", ({ artifact }) => { artifact.size_in_bytes = 1024 * 1024 + 1; }, "SCENARIO_EVIDENCE_INVALID"],
  ["an artifact from another source run", ({ artifact }) => { artifact.workflow_run.id++; }, "SCENARIO_EVIDENCE_INVALID"],
  ["an artifact from another head", ({ artifact }) => { artifact.workflow_run.head_sha = "a".repeat(40); }, "SCENARIO_EVIDENCE_INVALID"],
  ["an artifact created before its job", ({ artifact }) => { artifact.created_at = "2026-11-21T00:00:00Z"; }, "SCENARIO_EVIDENCE_INVALID"],
  ["an artifact changed after its job", ({ artifact }) => { artifact.updated_at = "2026-11-21T00:05:00Z"; }, "SCENARIO_EVIDENCE_INVALID"],
  ["an artifact with reversed timestamps", ({ artifact }) => { artifact.updated_at = "2026-11-21T00:02:00Z"; }, "SCENARIO_EVIDENCE_INVALID"],
  ["downloaded bytes that differ from the digest", ({ archives }) => { archives.set(99, Buffer.from("forged evidence")); }, "SCENARIO_EVIDENCE_INVALID"],
];

it.each(localRefusals)("refuses %s", (_name, mutate, code) => {
  const value = fixture();
  mutate(value);
  expect(evaluateScenarioCompletion(value.input)).toMatchObject({ kind: "failure", code });
});

const protectedRefusals: [string, (value: ReturnType<typeof fixture>) => void][] = [
  ["a partial check inventory", ({ responses, publicationRoute, check }) => { responses.set(publicationRoute, { total_count: 2, check_runs: [check] }); }],
  ["duplicate publications", ({ responses, publicationRoute, check }) => { responses.set(publicationRoute, { total_count: 2, check_runs: [check, check] }); }],
  ["a publication for another PR", ({ check }) => { check.external_id = "g5:13:300:1"; }],
  ["a publication for another head", ({ check }) => { check.head_sha = "a".repeat(40); }],
  ["a publication newer than its producer", ({ check }) => { check.external_id = "g5:12:300:2"; }],
  ["a completed rerun with the old publication", ({ producerRun }) => { producerRun.run_attempt++; }],
  ["an incomplete check after producer completion", ({ check }) => { check.status = "in_progress"; check.conclusion = null; }],
  ["a refused check", ({ check }) => { check.conclusion = "failure"; }],
  ["another protected workflow", ({ producerRun }) => { producerRun.workflow_id++; }],
  ["a producer from another repository", ({ producerRun }) => { producerRun.repository.id++; }],
  ["a non-main protected controller", ({ producerRun }) => { producerRun.head_branch = "candidate"; }],
  ["a producer with an unknown status", ({ producerRun }) => { producerRun.status = "unknown"; }],
  ["a protected receipt missing after completion", ({ responses }) => { responses.set("/actions/runs/300/artifacts?name=trusted-g5-evidence-300-1&per_page=100", { total_count: 0, artifacts: [] }); }],
  ["a protected artifact for another controller", ({ browserArtifact }) => { browserArtifact.workflow_run.head_sha = "a".repeat(40); }],
  ["a skipped protected publisher", ({ browserJobs }) => { browserJobs[1].conclusion = "skipped"; }],
  ["a protected archive with unverified bytes", ({ archives }) => { archives.set(98, Buffer.from("forged receipt")); }],
  ["a superseded current merge", ({ responses }) => { responses.set("/git/ref/pull/12/merge", { object: { sha: "a".repeat(40) } }); }],
];

it.each(protectedRefusals)("fails closed for %s without turning terminal invalid evidence into a wait", (_name, mutate) => {
  const value = fixture(true);
  mutate(value);
  expect(evaluateScenarioCompletion(value.input)).toMatchObject({ kind: "failure", code: "BROWSER_EVIDENCE_INVALID" });
});

it("returns only a fixed refusal code when an API failure contains private text", () => {
  const { input } = fixture(true);
  input.api.mockImplementation(() => { throw new Error("private artifact content must not appear in output"); });
  const result = evaluateScenarioCompletion(input);
  expect(result.kind).toBe("failure");
  expect(JSON.stringify(result)).not.toContain("private artifact");
  expect(result.code).toMatch(/^[A-Z_]+$/u);
});

it.each(["candidate", "verdict", "issues"])("rejects an authentic local archive with an invalid %s inside its report", field => {
  const { input, artifact, archive, localRaw } = fixture();
  const report = JSON.parse(localRaw);
  if (field === "candidate") report.candidate.workflowAttempt--;
  if (field === "verdict") report.backend[0].code = "TEST_SKIPPED";
  if (field === "issues") report.issues.push("ZERO_SCENARIOS_SELECTED");
  Object.assign(artifact, archive(99, { "scenario-evidence-1.json": JSON.stringify(report) }));
  expect(evaluateScenarioCompletion(input)).toMatchObject({ kind: "failure", code: "SCENARIO_EVIDENCE_INVALID" });
  expect(input.downloadZip).toHaveBeenCalledExactlyOnceWith(99);
});

it("requires a matching protected case inside an authentic browser archive", () => {
  const { input, browserArtifact, archive, evidence } = fixture(true);
  evidence.supplierArabicReplay.producerAttempt = "2";
  Object.assign(browserArtifact, archive(98, { "evidence.json": JSON.stringify(evidence) }));
  expect(evaluateScenarioCompletion(input)).toMatchObject({ kind: "failure", code: "BROWSER_EVIDENCE_INVALID" });
  expect(input.downloadZip.mock.calls.map(([id]) => id).sort()).toEqual([98, 99]);
});

it("matches the evidence snapshot to the exact source state captured before verification", () => {
  const { input, check: publication, producerRun } = fixture(true);
  const result = evaluateScenarioCompletion(input);
  const state = { localRun: input.localRun, publication, producerRun };
  expect(matchesScenarioCompletionEvidenceSnapshot(result.fingerprint, state)).toBe(true);
  expect(matchesScenarioCompletionEvidenceSnapshot(result.fingerprint,
    { ...state, localRun: { ...input.localRun, run_attempt: 3 } })).toBe(false);
  expect(matchesScenarioCompletionEvidenceSnapshot(result.fingerprint,
    { ...state, publication: { ...publication, external_id: "g5:12:400:1" }, producerRun: { ...producerRun, id: 400 } })).toBe(false);
  expect(matchesScenarioCompletionEvidenceSnapshot(result.fingerprint,
    { ...state, producerRun: { ...producerRun, conclusion: "failure" } })).toBe(false);
  expect(matchesScenarioCompletionEvidenceSnapshot(result.fingerprint,
    { ...state, publication: { ...publication, conclusion: "failure" } })).toBe(false);
});

it("refuses an evidence snapshot whose publication summary was stale even with the same check identity", () => {
  const { input, check: publication, producerRun } = fixture(true);
  const result = evaluateScenarioCompletion(input);
  const current = { localRun: input.localRun, producerRun,
    publication: { ...publication, output: { summary: `Tested backend and frontend merge: ${"a".repeat(40)}` } } };
  expect(matchesScenarioCompletionEvidenceSnapshot(result.fingerprint, current)).toBe(false);
});

it("matches a local-only evidence snapshot without depending on unrelated browser sources", () => {
  const { input, check: publication, producerRun } = fixture();
  const result = evaluateScenarioCompletion(input);
  expect(matchesScenarioCompletionEvidenceSnapshot(result.fingerprint,
    { localRun: input.localRun, publication, producerRun: { ...producerRun, status: "in_progress", conclusion: null } })).toBe(true);
});

it.each([undefined, "not json", "null", "{}", '{"localRun":null,"publication":null,"producerRun":null}'])
  ("refuses an invalid evidence snapshot (%#)", fingerprint => {
    expect(matchesScenarioCompletionEvidenceSnapshot(fingerprint,
      { localRun: { id: 200, run_attempt: 2 }, publication: null, producerRun: null })).toBe(false);
  });

it("refuses a partial protected evidence snapshot instead of treating it as local-only", () => {
  const { input, check: publication, producerRun } = fixture(true);
  const result = evaluateScenarioCompletion(input);
  const value = JSON.parse(result.fingerprint!);
  const state = { localRun: input.localRun, publication, producerRun };
  expect(matchesScenarioCompletionEvidenceSnapshot(JSON.stringify({ ...value, publication: null }), state)).toBe(false);
  expect(matchesScenarioCompletionEvidenceSnapshot(JSON.stringify({ ...value, producerRun: null }), state)).toBe(false);
  expect(matchesScenarioCompletionEvidenceSnapshot(result.fingerprint, { ...state, producerRun: null })).toBe(false);
});
