// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { createGitHubReceiptTransport, loadPublishedBrowserReceipt, readProtectedReplayDiff, readPublishedRoleSummaries } from "./trustedBrowserSource.mjs";
import { ROLE_AUDIT_ROLES } from "../intelligence/trustedBrowserReplayPolicy.mjs";

const candidate = {
  repositoryId: 12, prNumber: 825, baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40),
};

it("does not read role artifacts unless every exact worker passed its post-audit tripwire", () => {
  const expected = { runId: 10, attempt: 2 };
  const steps = ["Audit exact candidate role and tenant authority", "Verify the local backend was not changed during the run",
    "Upload verified candidate role summary"].map(name => ({ name, status: "completed", conclusion: "success" }));
  const jobs = ROLE_AUDIT_ROLES.map(role => ({ name: `candidate-role-audit-${role}`, run_id: 10, run_attempt: 2,
    status: "completed", conclusion: "success", steps }));
  jobs[jobs.length - 1].steps = steps.map(step => step.name.startsWith("Verify") ? { ...step, conclusion: "failure" } : step);
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
