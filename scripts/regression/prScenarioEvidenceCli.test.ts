// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { selectForPr } from "./prRunner.mjs";
import { createLocalScenarioEvidence, scenarioEvidenceDigest } from "./prScenarioEvidence.mjs";
import { aggregateScenarioEvidence, readScenarioRegistry, verifyPublishedScenarioEvidence } from "./scenarioRegistrySource.mjs";
import { runScenarioWorkflow } from "./scenarioWorkflowRunner.mjs";
import { buildBrowserReplayManifest } from "./trustedBrowserManifest.mjs";

const record = { id: "ordinary-ledger", level: "backend", domain: "money", status: "active",
  fingerprint: "d".repeat(64), impl: { file: "ledger.test.ts", testName: "keeps the total" } };
const name = "regression/scenarios/ordinary-ledger.scenario.json";
const parent = tmpdir();
let root: string | undefined;
let scratch: string | undefined;

function git(...args: string[]) {
  if (!root || !scratch) throw new Error("Git fixture has no root");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^GIT_/i.test(name)) delete env[name];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = path.join(scratch, "empty.gitconfig");
  return execFileSync(resolveTrustedGitExecutable(), args, { cwd: root, env, encoding: "utf8",
    timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  root = mkdtempSync(path.join(parent, "autoflow-scenario-git-"));
  scratch = mkdtempSync(path.join(parent, "autoflow-scenario-evidence-"));
  writeFileSync(path.join(scratch, "empty.gitconfig"), "");
  git("init", "-q", "--template=");
  git("config", "user.name", "Scenario fixture");
  git("config", "user.email", "fixture@example.test");
  mkdirSync(path.join(root, "regression/scenarios"), { recursive: true });
  writeFileSync(path.join(root, name), JSON.stringify(record));
  writeFileSync(path.join(root, "regression/rulings.json"), "[]");
  git("add", "regression");
  git("commit", "-qm", "base fixture");
  return { checkout: root, evidenceDirectory: scratch, baseSha: git("rev-parse", "HEAD") };
}

function mergeFixture() {
  const { checkout, baseSha, evidenceDirectory } = fixture();
  git("checkout", "-qb", "candidate");
  writeFileSync(path.join(checkout, "notes.txt"), "candidate documentation");
  git("add", "notes.txt");
  git("commit", "-qm", "candidate fixture");
  const headSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", baseSha);
  git("merge", "-q", "--no-ff", "--no-edit", headSha);
  const testedSha = git("rev-parse", "HEAD");
  git("update-ref", "refs/autoflow/scenario-merge", testedSha);
  return { checkout, evidenceDirectory, candidate: { repositoryId: 42, prNumber: 12, workflowRunId: 200,
    workflowAttempt: 2, baseSha, headSha, testedSha } };
}

afterEach(() => {
  for (const directory of [root, scratch]) {
    if (directory && path.dirname(directory) === parent && path.basename(directory).startsWith("autoflow-scenario-")) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  root = undefined;
  scratch = undefined;
});

it("runs the CLI admission check and fails when the workflow identity is absent", () => {
  const program = fileURLToPath(new URL("./prScenarioEvidenceCli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [program, "aggregate"], {
    env: { ...process.env, GITHUB_ACTIONS: "false" }, encoding: "utf8", timeout: 5_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("SCENARIO_CONTEXT_INVALID");
});

it("uses only the fixture index even when the parent sets a Git index override", () => {
  const { checkout } = fixture();
  const outsideIndex = path.join(checkout, "inherited.index");
  vi.stubEnv("GIT_INDEX_FILE", outsideIndex);
  try {
    writeFileSync(path.join(checkout, "notes.txt"), "fixture documentation");
    git("add", "--", "notes.txt");
    expect(git("diff", "--cached", "--name-only")).toBe("notes.txt");
    expect(existsSync(outsideIndex)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("aggregates an exact merge from the base checkout using the committed scenario objects", () => {
  const { checkout, candidate, evidenceDirectory } = mergeFixture();
  const { baseSha, headSha, testedSha } = candidate;
  git("checkout", "-q", "--detach", baseSha);
  const selection = selectForPr([record], ["notes.txt"]);
  const localRaw = createLocalScenarioEvidence(candidate, { selection, issues: [],
    verdicts: [{ id: record.id, code: "PASS" }], browserVerdicts: [] });
  const input = { checkout, candidate, localRaw, localDigest: scenarioEvidenceDigest(localRaw),
    browserRaw: JSON.stringify(buildBrowserReplayManifest(candidate, [], [])) };
  expect(aggregateScenarioEvidence(input)).toMatchObject({ verdict: "PASS", selected: 1, passed: 1 });
  expect(() => aggregateScenarioEvidence({ ...input, candidate: { ...candidate, testedSha: headSha } }))
    .toThrow("Fetched replay candidate is no longer current.");

  const entry = "scenario-evidence-1.json";
  const archive = path.join(evidenceDirectory, "evidence.zip");
  writeFileSync(path.join(evidenceDirectory, entry), localRaw);
  const zip = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "/usr/bin/zip";
  execFileSync(zip, [process.platform === "win32" ? "-acf" : "-q", archive, entry], { cwd: evidenceDirectory, timeout: 5_000 });
  const bytes = readFileSync(archive);
  const archiveDigest = createHash("sha256").update(bytes).digest("hex");
  const artifact = { id: 99, name: "pr-local-scenarios-200-2", expired: false, digest: `sha256:${archiveDigest}`,
    size_in_bytes: bytes.length, workflow_run: { id: 200, repository_id: 42, head_repository_id: 42, head_sha: headSha } };
  const downloadZip = vi.fn(() => bytes);
  const api = vi.fn((route: string) => route.startsWith("/git/ref/") ? { object: { sha: testedSha } }
    : route.startsWith("/actions/runs/") ? { total_count: 1, artifacts: [artifact] } : artifact);
  const published = { checkout, candidate, artifactId: artifact.id, archiveDigest, localDigest: input.localDigest,
    browserRaw: input.browserRaw, transport: { api, downloadZip } };
  expect(verifyPublishedScenarioEvidence(published)).toMatchObject({ verdict: "PASS", selected: 1, passed: 1 });

  api.mockClear();
  downloadZip.mockClear();
  api.mockReturnValueOnce({ object: { sha: testedSha } })
    .mockReturnValueOnce({ total_count: 1, artifacts: [artifact] }).mockReturnValueOnce(artifact)
    .mockReturnValueOnce({ object: { sha: baseSha } });
  expect(() => verifyPublishedScenarioEvidence(published)).toThrow("SCENARIO_AGGREGATION_CONTEXT_STALE");
  expect(downloadZip).toHaveBeenCalledExactlyOnceWith(artifact.id);
  expect(api).toHaveBeenNthCalledWith(4, `/git/ref/pull/${candidate.prNumber}/merge`);

  api.mockClear();
  api.mockReturnValueOnce({ object: { sha: testedSha } })
    .mockReturnValueOnce({ total_count: 1, artifacts: [artifact] }).mockReturnValueOnce(artifact)
    .mockReturnValueOnce({ object: { sha: baseSha } });
  expect(() => verifyPublishedScenarioEvidence({ ...published, localDigest: "0".repeat(64) }))
    .toThrow("LOCAL_SCENARIO_EVIDENCE_INVALID");
  expect(api).toHaveBeenCalledTimes(3);
});

it("joins native local execution, both static reports and the admitted shadow evidence through the workflow entry", () => {
  const { checkout, candidate, evidenceDirectory } = mergeFixture();
  const event = path.join(evidenceDirectory, "pull-request.json");
  writeFileSync(event, JSON.stringify({ repository: { id: candidate.repositoryId }, pull_request: {
    number: candidate.prNumber,
    base: { sha: candidate.baseSha, repo: { id: candidate.repositoryId } },
    head: { sha: candidate.headSha, repo: { id: candidate.repositoryId } },
  } }));
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event,
    GITHUB_REF: `refs/pull/${candidate.prNumber}/merge`, GITHUB_SHA: candidate.testedSha,
    GITHUB_REPOSITORY_ID: String(candidate.repositoryId), GITHUB_RUN_ID: String(candidate.workflowRunId),
    GITHUB_RUN_ATTEMPT: String(candidate.workflowAttempt), BASE_SHA: candidate.baseSha,
    GITHUB_OUTPUT: path.join(evidenceDirectory, "workflow-output"),
  };
  const host = { root: checkout, env, log: vi.fn<(value: string) => void>(), error: vi.fn<(value: string) => void>() };
  writeFileSync(path.join(checkout, "vitest.config.mjs"), "export default {test:{globals:true,include:['*.test.ts']}};\n");
  writeFileSync(path.join(checkout, record.impl.file), `test(${JSON.stringify(record.impl.testName)}, () => expect(1).toBe(1));\n`);
  const reports = path.join(checkout, "regression-reports");
  mkdirSync(reports);
  expect(runScenarioWorkflow({ ...host, args: ["local"] })).toBe(1);
  expect(existsSync(env.GITHUB_OUTPUT)).toBe(false);
  expect(host.log.mock.lastCall?.[0]).toContain("PLAYWRIGHT_REQUIRED_REPORT_MISSING_OR_DUPLICATED");

  const require = createRequire(import.meta.url);
  const playwright = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  const visualFixture = path.join(checkout, "visual-fixture");
  mkdirSync(visualFixture);
  writeFileSync(path.join(visualFixture, "screen.spec.cjs"),
    `const {test}=require(${JSON.stringify(require.resolve("@playwright/test"))}); test('shows the total',()=>{});\n`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) if (name.startsWith("PLAYWRIGHT_JSON_")) delete childEnv[name];
  for (const [label, config] of [["visual", "playwright.visual.config.ts"], ["opening-visual", "playwright.opening.visual.config.ts"]]) {
    writeFileSync(path.join(checkout, config), "module.exports={testDir:'visual-fixture',projects:[{name:'chromium'}]};\n");
    const actual = execFileSync(process.execPath, [playwright, "test", "-c", config, "--workers=1", "--reporter=json"],
      { cwd: checkout, env: childEnv, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(path.join(reports, `${label}.json`), actual);
  }

  expect(runScenarioWorkflow({ ...host, args: ["local"] })).toBe(0);
  const raw = readFileSync(path.join(reports, "scenario-evidence-1.json"), "utf8");
  const digest = scenarioEvidenceDigest(raw);
  expect(readFileSync(env.GITHUB_OUTPUT, "utf8").trim()).toBe(`evidence_digest=${digest}`);
  expect(runScenarioWorkflow({ ...host, args: ["benchmark", "1"] })).toBe(0);
  expect(JSON.parse(host.log.mock.lastCall![0])).toMatchObject({ workers: 1, selected: 1, passed: 1 });
  expect(runScenarioWorkflow({ ...host, args: ["static-census", "visual"] })).toBe(0);
  expect(JSON.parse(host.log.mock.lastCall![0])).toMatchObject({ staticConfig: "visual", passed: 1 });

  git("worktree", "add", "--detach", path.join(evidenceDirectory, "trusted"), candidate.baseSha);
  const shadowDir = path.join(evidenceDirectory, "scenario-shadow");
  mkdirSync(shadowDir);
  writeFileSync(path.join(shadowDir, "scenario-evidence-1.json"), raw);
  const shadow = { ...env, GITHUB_WORKSPACE: evidenceDirectory, RUNNER_TEMP: evidenceDirectory,
    LOCAL_EVIDENCE_DIGEST: digest, AUTOFLOW_VERIFIED_BROWSER_REPLAYS: JSON.stringify(buildBrowserReplayManifest(candidate, [], [])) };
  expect(runScenarioWorkflow({ ...host, env: shadow, args: ["shadow"] })).toBe(0);
  expect(JSON.parse(host.log.mock.lastCall![0])).toMatchObject({ verdict: "PASS", selected: 1, passed: 1 });
  expect(runScenarioWorkflow({ ...host, env: { ...shadow, LOCAL_EVIDENCE_DIGEST: "0".repeat(64) }, args: ["shadow"] })).toBe(1);
  expect(host.error).toHaveBeenLastCalledWith("LOCAL_SCENARIO_EVIDENCE_INVALID");
  expect(runScenarioWorkflow({ ...host, args: ["benchmark", "3"] })).toBe(1);
  expect(host.error).toHaveBeenLastCalledWith("SCENARIO_MODE_INVALID");
}, 30_000);

it.each(["invalid json", "", "x".repeat(1_000_000)])("rejects malformed or unbounded scenario blobs (%#)", (content) => {
  const { checkout } = fixture();
  writeFileSync(path.join(checkout, name), content);
  git("add", "--", name);
  git("commit", "-qm", "invalid fixture");
  expect(() => readScenarioRegistry(checkout, git("rev-parse", "HEAD"))).toThrow(/^SCENARIO_/u);
});

it.each(["120000", "160000"])("refuses a link entry rather than reading its target (%s)", (mode) => {
  const { checkout, baseSha } = fixture();
  const object = mode === "160000" ? baseSha : git("hash-object", "-w", "--", name);
  git("update-index", "--cacheinfo", `${mode},${object},${name}`);
  git("commit", "-qm", "non-regular fixture");
  expect(() => readScenarioRegistry(checkout, git("rev-parse", "HEAD"))).toThrow("SCENARIO_OBJECT_INVALID");
});
