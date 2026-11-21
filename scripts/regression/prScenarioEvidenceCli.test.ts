// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { selectForPr } from "./prRunner.mjs";
import { createLocalScenarioEvidence, scenarioEvidenceDigest } from "./prScenarioEvidence.mjs";
import { aggregateScenarioEvidence, readScenarioRegistry } from "./prScenarioEvidenceCli.mjs";
import { buildBrowserReplayManifest } from "./trustedBrowserManifest.mjs";

const record = { id: "ordinary-ledger", level: "backend", domain: "money", status: "active",
  fingerprint: "d".repeat(64), impl: { file: "ledger.test.ts", testName: "keeps the total" } };
const name = "regression/scenarios/ordinary-ledger.scenario.json";
const parent = tmpdir();
let root: string | undefined;

function git(...args: string[]) {
  return execFileSync(resolveTrustedGitExecutable(), args, { cwd: root, encoding: "utf8",
    timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  root = mkdtempSync(path.join(parent, "autoflow-scenario-git-"));
  git("init", "-q");
  git("config", "user.name", "Scenario fixture");
  git("config", "user.email", "fixture@example.test");
  mkdirSync(path.join(root, "regression/scenarios"), { recursive: true });
  writeFileSync(path.join(root, name), JSON.stringify(record));
  writeFileSync(path.join(root, "regression/rulings.json"), "[]");
  git("add", "regression");
  git("commit", "-qm", "base fixture");
  return { checkout: root, baseSha: git("rev-parse", "HEAD") };
}

afterEach(() => {
  if (root && path.dirname(root) === parent && path.basename(root).startsWith("autoflow-scenario-git-")) {
    rmSync(root, { recursive: true, force: true });
  }
  root = undefined;
});

it("aggregates an exact merge from the base checkout using the committed scenario objects", () => {
  const { checkout, baseSha } = fixture();
  git("checkout", "-qb", "candidate");
  writeFileSync(path.join(checkout, "notes.txt"), "candidate documentation");
  git("add", "notes.txt");
  git("commit", "-qm", "candidate fixture");
  const headSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", baseSha);
  git("merge", "-q", "--no-ff", "--no-edit", headSha);
  const testedSha = git("rev-parse", "HEAD");
  git("update-ref", "refs/autoflow/scenario-merge", testedSha);
  git("checkout", "-q", "--detach", baseSha);
  const candidate = { repositoryId: 42, prNumber: 12, workflowRunId: 200, workflowAttempt: 2, baseSha, headSha, testedSha };
  const selection = selectForPr([record], ["notes.txt"]);
  const localRaw = createLocalScenarioEvidence(candidate, { selection, issues: [],
    verdicts: [{ id: record.id, code: "PASS" }], browserVerdicts: [] });
  const input = { checkout, candidate, localRaw, localDigest: scenarioEvidenceDigest(localRaw),
    browserRaw: JSON.stringify(buildBrowserReplayManifest(candidate, [], [])) };
  expect(aggregateScenarioEvidence(input)).toMatchObject({ verdict: "PASS", selected: 1, passed: 1 });
  expect(() => aggregateScenarioEvidence({ ...input, candidate: { ...candidate, testedSha: headSha } }))
    .toThrow("Fetched replay candidate is no longer current.");
});

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
