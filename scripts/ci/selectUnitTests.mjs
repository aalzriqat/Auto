/**
 * SCRUM-1025 CLI for the Tests workflow's `unit-plan` job.
 *
 *   node scripts/ci/selectUnitTests.mjs --event <name> --out <selection.json>
 *
 * Writes the decision (mode full | docs-only, a reason, and for docs-only the
 * base commit and run whose coverage is re-used) to --out and to $GITHUB_OUTPUT. It exits 0 with
 * mode=full on every error: an undecidable change is the full suite, never a
 * skip.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { classifyChange, parseNameStatus } from "./unitTestSelection.mjs";

/** @typedef {import("./unitTestSelection.mjs").Decision} Decision */
/** @typedef {{ id: number, head_sha: string, head_branch: string, conclusion: string }} WorkflowRun */
/** @typedef {{ name: string, expired: boolean }} RunArtifact */
/** @typedef {{ workflow_runs?: WorkflowRun[], artifacts?: RunArtifact[] }} GhResponse */
/** @typedef {(args: string[]) => GhResponse | Promise<GhResponse>} GhFn  GitHub REST GET (path in args[0]) as parsed JSON */

/**
 * The newest successful push run of the Tests workflow on `sha` that still has
 * an unexpired `coverage-report` artifact, or null. `gh(args)` returns parsed JSON.
 */
/**
 * @param {{ repo: string, sha: string, gh: GhFn }} input
 * @returns {Promise<string | null>}
 */
export async function findBaseCoverageRun({ repo, sha, gh }) {
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const runs = await gh([
    `repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&event=push&status=success&per_page=5`,
  ]);
  for (const run of runs?.workflow_runs ?? []) {
    if (run.head_sha !== sha || run.head_branch !== "main" || run.conclusion !== "success") continue;
    const artifacts = await gh([`repos/${repo}/actions/runs/${run.id}/artifacts?name=coverage-report&per_page=5`]);
    const live = (artifacts?.artifacts ?? []).some((a) => a.name === "coverage-report" && a.expired === false);
    if (live) return String(run.id);
  }
  return null;
}

const git = (root, args) => execFileSync(resolveTrustedGitExecutable(), args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * GitHub REST GET through `fetch`, authenticated with the job's token, so no
 * program is resolved through PATH (Sonar S4036). A non-2xx answer or a missing
 * token throws, and `decide` turns any throw into the full suite.
 * @type {GhFn}
 */
export async function ghJson([requestPath]) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is not set");
  const response = await fetch(`https://api.github.com/${requestPath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub GET ${requestPath.split("?")[0]} answered ${response.status}`);
  return response.json();
}

/**
 * @param {{ root: string, event: string | undefined, repo: string, gh?: GhFn }} input
 * @returns {Promise<Decision>}
 */
export async function decide({ root, event, repo, gh = ghJson }) {
  if (event !== "pull_request") return { mode: "full", reason: `event '${event}' always runs the full suite` };
  // The checkout is the PR merge commit: first parent = the base it was merged
  // into, second = the head. Anything else is not understood, so it is full.
  const parents = git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1);
  if (parents.length !== 2) return { mode: "full", reason: "HEAD is not a two-parent merge commit" };
  const [baseSha] = parents;
  const changed = parseNameStatus(git(root, ["diff", "--name-status", "--no-renames", baseSha, "HEAD"]));

  const first = classifyChange({ event, changed, baseCoverageAvailable: true });
  if (first.mode !== "docs-only") return first;
  let baseRunId = null;
  try {
    baseRunId = await findBaseCoverageRun({ repo, sha: baseSha, gh });
  } catch {
    baseRunId = null;
  }
  const final = classifyChange({ event, changed, baseCoverageAvailable: baseRunId !== null });
  return final.mode === "docs-only" ? { ...final, baseRunId, baseSha } : final;
}
/**
 * Decide, write the decision to `--out` and to `$GITHUB_OUTPUT`. Never throws
 * for an undecidable change: that is mode=full.
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 * @returns {Promise<Decision>}
 */
export async function main(args, env, cwd) {
  const arg = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const out = arg("--out");
  if (!out) throw new Error("--out is required");
  /** @type {Decision} */
  let decision;
  try {
    decision = await decide({ root: cwd, event: arg("--event"), repo: env.GITHUB_REPOSITORY ?? "" });
  } catch (error) {
    decision = { mode: "full", reason: `selection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  writeFileSync(path.resolve(cwd, out), `${JSON.stringify(decision, null, 2)}\n`);
  const oneLine = String(decision.reason).replace(/[\r\n]+/g, " ").slice(0, 300);
  console.log(`unit test selection: mode=${decision.mode} (${oneLine})`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `mode=${decision.mode}\nreason=${oneLine}\nbase_run_id=${decision.baseRunId ?? ""}\nbase_sha=${decision.baseSha ?? ""}\n`,
    );
  }
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2), process.env, process.cwd());
}