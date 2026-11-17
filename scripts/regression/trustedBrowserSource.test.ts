// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { createGitHubReceiptTransport, loadPublishedBrowserReceipt, readProtectedReplayDiff } from "./trustedBrowserSource.mjs";

const candidate = {
  repositoryId: 12, prNumber: 825, baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40),
};

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
