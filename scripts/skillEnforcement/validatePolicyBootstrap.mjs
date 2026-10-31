#!/usr/bin/env node
/**
 * SCRUM-760: One-time computed policy validation mechanism for PR #734 bootstrap.
 *
 * Runs only when explicitly dispatched via an approved workflow run on the policy
 * branch with the exact confirmation phrase `VALIDATE POLICY PR 734`.
 *
 * Never forces success or bypasses evaluation: executes the actual computed
 * check (`checkPrSkillEvidence.mjs`) on the candidate PR head commit, verifying:
 * - Real red run present in PR body
 * - Real /simplify output present in PR body
 * - Runtime implementer session present and valid
 * - Authorized Seat 1 waiver ruling (`SCRUM-760 c24127`) and valid owner waiver comment
 * - Independent Seat 2 Codex certification (`Verdict: CERTIFY`, distinct session, exact head, chat mode)
 *
 * If and only if all policy rules pass, publishes the computed check-run to
 * GitHub Checks API under context `skill-evidence` via ephemeral GITHUB_TOKEN.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { check } from "./checkPrSkillEvidence.mjs";

const execFileAsync = promisify(execFile);

/**
 * Publishes the computed check result to GitHub Checks API.
 */
export async function writeSkillEvidenceCheck(fetchImpl, token, repo, headSha, conclusion, lines) {
  const repositoryPath = repo.split("/").map(encodeURIComponent).join("/");
  const response = await fetchImpl(`https://api.github.com/repos/${repositoryPath}/check-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "autoflow-policy-bootstrap",
    },
    body: JSON.stringify({
      name: "skill-evidence",
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title: `Skill Evidence: ${conclusion} (bootstrap computed validation)`,
        summary: lines.join("\n"),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub checks API failed with HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Executes one-time computed policy validation for PR #734.
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} [fetchImpl]
 * @param {((cmd: string) => Promise<string>) | null} [execGit]
 */
export async function validatePolicyBootstrap(env, fetchImpl = fetch, execGit = null) {
  const {
    REPO,
    GH_TOKEN,
    INPUT_SHA,
    INPUT_CONFIRM,
    GITHUB_REF,
  } = env;

  if (INPUT_CONFIRM !== "VALIDATE POLICY PR 734") {
    throw new Error(`Refusing policy validation: confirm input must be 'VALIDATE POLICY PR 734', got '${INPUT_CONFIRM}'.`);
  }

  if (!/^[0-9a-f]{40}$/i.test(INPUT_SHA ?? "")) {
    throw new Error(`Refusing policy validation: invalid input SHA '${INPUT_SHA}'.`);
  }

  const expectedRef = "refs/heads/gemini/scrum760-waiver-policy";
  if (GITHUB_REF !== expectedRef) {
    throw new Error(`Refusing policy validation: workflow must run on '${expectedRef}', dispatched on '${GITHUB_REF}'.`);
  }

  if (!REPO || !GH_TOKEN) {
    throw new Error("Missing REPO or GH_TOKEN environment variables.");
  }

  const normalizedInputSha = INPUT_SHA.toLowerCase();

  // Verify checked out HEAD commit matches INPUT_SHA if git runner is provided
  if (execGit) {
    const headCommit = (await execGit("rev-parse HEAD")).trim().toLowerCase();
    if (headCommit !== normalizedInputSha) {
      throw new Error(`Local checked out HEAD '${headCommit}' does not match input SHA '${normalizedInputSha}'.`);
    }
  }

  // Fetch PR 734 from GitHub API to verify head
  const repositoryPath = REPO.split("/").map(encodeURIComponent).join("/");
  const prRes = await fetchImpl(`https://api.github.com/repos/${repositoryPath}/pulls/734`, {
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "autoflow-policy-bootstrap",
    },
  });
  if (!prRes.ok) {
    throw new Error(`Could not fetch PR 734 from GitHub API (HTTP ${prRes.status}).`);
  }
  const pr = await prRes.json();
  if (pr.state !== "open") {
    throw new Error(`PR 734 is not open (state: ${pr.state}).`);
  }

  const prHeadSha = String(pr.head?.sha ?? "").toLowerCase();
  if (prHeadSha !== normalizedInputSha) {
    throw new Error(`PR 734 head SHA '${prHeadSha}' does not match input SHA '${normalizedInputSha}'.`);
  }

  // Execute the real computed policy judge
  const result = await check({ REPO, PR_NUMBER: "734", GH_TOKEN }, fetchImpl);

  const conclusion = result.exitCode === 0 ? "success" : "failure";
  await writeSkillEvidenceCheck(fetchImpl, GH_TOKEN, REPO, normalizedInputSha, conclusion, result.lines);

  if (conclusion !== "success") {
    throw new Error(`Computed policy validation failed:\n${result.lines.join("\n")}`);
  }

  return { success: true, headSha: normalizedInputSha, lines: result.lines };
}

async function defaultGit(args) {
  const { stdout } = await execFileAsync("git", args.split(" "));
  return stdout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const res = await validatePolicyBootstrap(process.env, fetch, defaultGit);
    console.log(`Policy validation succeeded for ${res.headSha}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
