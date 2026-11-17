// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { collectHostedBrowserReplays, createGitHubReceiptTransport, loadPublishedBrowserReceipt, readProtectedReplayDiff, readPublishedRoleSummaries } from "./trustedBrowserSource.mjs";
import { ROLE_AUDIT_ROLES } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import openingOwner from "../../regression/scenarios/screen/opening-owner-ui-native-post.scenario.json";

const candidate = {
  repositoryId: 12, prNumber: 825, baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40),
};

it("refuses missing GitHub receipt context before polling for a selected proof", () => {
  expect(() => collectHostedBrowserReplays({
    root: process.cwd(), candidate, selected: [openingOwner], env: { GITHUB_REPOSITORY: "aalzriqat/Auto" },
  })).toThrow("GitHub receipt context is unavailable.");
});

it.each([
  "Prove browser egress containment before authenticated traffic",
  "Verify the local backend was not changed during the run",
])("does not read role artifacts when an exact worker failed %s", (requiredStep) => {
  const expected = { runId: 10, attempt: 2 };
  const steps = ["Prove browser egress containment before authenticated traffic",
    "Audit exact candidate role and tenant authority", "Verify the local backend was not changed during the run",
    "Upload verified candidate role summary"].map(name => ({ name, status: "completed", conclusion: "success" }));
  const jobs = ROLE_AUDIT_ROLES.map(role => ({ name: `candidate-role-audit-${role}`, run_id: 10, run_attempt: 2,
    status: "completed", conclusion: "success", steps }));
  jobs[jobs.length - 1].steps = steps.map(step => step.name === requiredStep ? { ...step, conclusion: "failure" } : step);
  expect(readPublishedRoleSummaries({ receipt: { expected, jobs },
    api: () => { throw new Error("An incomplete role census must refuse before artifact lookup."); },
    downloadZip: () => { throw new Error("An incomplete role census must refuse before archive read."); },
  })).toEqual([]);
});

it("refuses duplicate current publications even when both advertise a successful producer", () => {
  const check = {
    name: "authenticated-pr-e2e", app: { slug: "github-actions" }, head_sha: candidate.headSha,
    status: "completed", conclusion: "success", external_id: `g5:${candidate.prNumber}:123:1`,
  };
  expect(loadPublishedBrowserReceipt({
    candidate,
    api: (route: string) => {
      if (!route.includes("/check-runs?")) throw new Error("An ambiguous publication must refuse before reading its producer.");
      return { total_count: 2, check_runs: [check, check] };
    },
    downloadZip: () => { throw new Error("An ambiguous publication must refuse before reading its archive."); },
  })).toBeNull();
});

it("refuses a partial check inventory that omits other possible publications", () => {
  expect(loadPublishedBrowserReceipt({
    candidate, api: () => ({ total_count: 101, check_runs: [] }),
    downloadZip: () => { throw new Error("A partial inventory cannot authorize an archive download."); },
  })).toBeNull();
});

it.each([
  ["completed", candidate.testedSha, true],
  ["in_progress", candidate.testedSha, false],
  ["completed", "d".repeat(40), false],
] as const)("stops waiting only for an exact terminal producer refusal, status %s and tested SHA %s", (status, testedSha, terminal) => {
  const onTerminalRefusal = vi.fn();
  const check = {
    name: "authenticated-pr-e2e", head_sha: candidate.headSha, app: { slug: "github-actions" },
    status: "completed", conclusion: "failure", external_id: "g5:825:123:1",
    output: { summary: `Tested backend and frontend merge: ${testedSha}\nThe trusted suite refused this candidate.` },
  };
  const run = {
    id: 123, run_attempt: 1, workflow_id: 20, path: ".github/workflows/browser-attack-swarm.yml",
    event: "workflow_run", repository: { id: 12 }, head_repository: { id: 12 },
    head_branch: "main", head_sha: candidate.baseSha, status, conclusion: "failure",
  };
  const api = (route: string) => {
    if (route.includes("/check-runs?")) return { total_count: 1, check_runs: [check] };
    if (route === "/actions/workflows/browser-attack-swarm.yml") return { id: 20 };
    if (route === "/actions/runs/123") return run;
    throw new Error(`Unexpected receipt lookup ${route}`);
  };
  expect(loadPublishedBrowserReceipt({
    candidate, api, onTerminalRefusal,
    downloadZip: () => { throw new Error("A refused producer cannot authorize an archive download."); },
  })).toBeNull();
  expect(onTerminalRefusal).toHaveBeenCalledTimes(terminal ? 1 : 0);
});

it.each([true, false])("stops waiting for a corrupt archive only on an exact completed publication (%s)", (exact) => {
  const onTerminalRefusal = vi.fn();
  const testMerge = exact ? candidate.testedSha : "d".repeat(40);
  const check = {
    name: "authenticated-pr-e2e", head_sha: candidate.headSha, app: { slug: "github-actions" },
    status: "completed", conclusion: "success", external_id: "g5:825:123:1",
    output: { summary: `Tested backend and frontend merge: ${testMerge}` },
  };
  const run = {
    id: 123, run_attempt: 1, workflow_id: 20, path: ".github/workflows/browser-attack-swarm.yml",
    event: "workflow_run", repository: { id: 12 }, head_repository: { id: 12 },
    head_branch: "main", head_sha: candidate.baseSha, status: "completed", conclusion: "success",
  };
  const artifact = {
    id: 42, name: "trusted-g5-evidence-123-1", expired: false, size_in_bytes: 14,
    digest: `sha256:${"0".repeat(64)}`,
    workflow_run: { id: 123, repository_id: 12, head_repository_id: 12, head_branch: "main", head_sha: candidate.baseSha },
  };
  const responses = new Map<string, unknown>([
    [`/commits/${candidate.headSha}/check-runs?check_name=authenticated-pr-e2e&filter=all&per_page=100`, { total_count: 1, check_runs: [check] }],
    ["/actions/workflows/browser-attack-swarm.yml", { id: 20 }],
    ["/actions/runs/123", run],
    ["/actions/runs/123/artifacts?name=trusted-g5-evidence-123-1&per_page=100", { total_count: 1, artifacts: [artifact] }],
    ["/actions/artifacts/42", artifact],
    ["/actions/runs/123/attempts/1/jobs?per_page=100", { total_count: 0, jobs: [] }],
    ["/pulls/825", {}],
    ["/git/ref/pull/825/merge", {}],
    [`/git/commits/${candidate.testedSha}`, {}],
  ]);
  const api = (route: string) => {
    if (!responses.has(route)) throw new Error(`Unexpected receipt lookup ${route}`);
    return responses.get(route);
  };
  const downloadZip = vi.fn(() => Buffer.from("corrupt receipt"));
  expect(loadPublishedBrowserReceipt({ candidate, api, downloadZip, onTerminalRefusal })).toBeNull();
  expect(downloadZip).toHaveBeenCalledWith(42);
  expect(onTerminalRefusal).toHaveBeenCalledTimes(exact ? 1 : 0);

  onTerminalRefusal.mockClear();
  expect(loadPublishedBrowserReceipt({ candidate, api, onTerminalRefusal, downloadZip: () => Buffer.alloc(0) })).toBeNull();
  expect(onTerminalRefusal).toHaveBeenCalledTimes(exact ? 1 : 0);

  onTerminalRefusal.mockClear();
  expect(() => loadPublishedBrowserReceipt({
    candidate, api, onTerminalRefusal,
    downloadZip: () => { throw new Error("Receipt transport unavailable"); },
  })).toThrow("Receipt transport unavailable");
  expect(onTerminalRefusal).not.toHaveBeenCalled();

  const oversized = { ...artifact, size_in_bytes: 32 * 1024 * 1024 + 1 };
  responses.set("/actions/artifacts/42", oversized);
  downloadZip.mockClear();
  expect(loadPublishedBrowserReceipt({ candidate, api, onTerminalRefusal, downloadZip })).toBeNull();
  expect(downloadZip).not.toHaveBeenCalled();
  expect(onTerminalRefusal).toHaveBeenCalledTimes(exact ? 1 : 0);
});

it("refuses arbitrary authenticated GitHub routes", () => {
  const transport = createGitHubReceiptTransport({ repository: "aalzriqat/Auto", token: "fixture" });
  expect(() => transport.api("/actions/artifacts/12/../../releases")).toThrow("GitHub receipt route is unavailable.");
  expect(() => transport.downloadZip("12/../../secret")).toThrow("GitHub receipt route is unavailable.");
});

it("selects an exact fetched two-parent merge while leaving the trusted base checked out", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autoflow-replay-git-"));
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("autoflow-replay-git-")) {
    throw new Error("Unsafe fixture cleanup path");
  }
  const binary = resolveTrustedGitExecutable();
  const git = (...args: string[]) => execFileSync(binary, args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    const file = path.join(root, "screen.ts");
    git("init", "--initial-branch=main");
    git("config", "user.name", "Replay Fixture");
    git("config", "user.email", "replay@example.invalid");
    git("config", "core.autocrlf", "false");
    writeFileSync(file, "base\n");
    git("add", "screen.ts");
    git("commit", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    git("switch", "-c", "candidate");
    writeFileSync(file, "changed\n");
    git("commit", "-am", "candidate");
    const headSha = git("rev-parse", "HEAD");
    git("switch", "main");
    git("merge", "--no-ff", "--no-edit", "candidate");
    const testedSha = git("rev-parse", "HEAD");
    git("update-ref", "refs/autoflow/scenario-merge", testedSha);
    git("switch", "--detach", baseSha);

    expect(readProtectedReplayDiff(root, { baseSha, headSha, testedSha })).toEqual(["screen.ts"]);
    expect(readFileSync(file, "utf8")).toBe("base\n");
    expect(() => readProtectedReplayDiff(root, { baseSha, headSha: baseSha, testedSha })).toThrow("Fetched replay candidate is no longer current.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
