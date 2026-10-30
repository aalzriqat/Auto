import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { accountingRehearsalPathGate } from "./accountingRehearsalPathGate.mjs";
import { resolveGit } from "./contractSkew/gitExecutable.mjs";

/** Fetched commits are data. No checkout, candidate imports, hooks or diff drivers.
 * Git plumbing avoids the compare API's 300-file and PR-files API's 3000-file caps.
 * Classifies the union of the PR's own changes (base...head) and the staged test merge
 * against its first parent (base..tested). A merge can carry a PR edit into a path the
 * branch never touched (rename detection), so the head diff alone is not enough.
 * @param {{baseSha: string, headSha: string, testedSha: string, cwd?: string, findGit?: () => string | undefined}} input
 */
export function readBackendChangeDecision({ baseSha, headSha, testedSha, cwd, findGit = resolveGit }) {
  let paths;
  let complete = false;
  try {
    if (![baseSha, headSha, testedSha].every((sha) => /^[0-9a-f]{40}$/i.test(sha ?? ""))) {
      throw new Error("Exact commits unavailable");
    }
    // An absolute git path, never a PATH lookup (Sonar S4036). Not found RUNS.
    const git = findGit();
    if (!git) throw new Error("Git unavailable");
    const listed = [`${baseSha}...${headSha}`, `${baseSha}..${testedSha}`].map((range) => {
      const output = execFileSync(git, [
        "diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", range, "--",
      ], { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      return new TextDecoder("utf-8", { fatal: true }).decode(output);
    });
    // A partial or empty record must never certify a complete diff.
    complete = listed.every((names) => names.endsWith("\0"));
    paths = complete ? [...new Set(listed.flatMap((names) => names.slice(0, -1).split("\0")))] : [];
  } catch {
    // Missing objects, timeouts, oversized output and invalid encoding RUN.
    // Raw Git diagnostics and candidate filenames never enter public logs.
  }
  return { ...accountingRehearsalPathGate({ paths, complete }), baseSha, headSha, testedSha };
}

/**
 * The workflow step: decide, then write the evidence file, the step output and the summary.
 * @param {{env?: Record<string, string | undefined>, cwd?: string}} [options]
 */
export function runPathGateStep({ env = process.env, cwd = process.cwd() } = {}) {
  const decision = readBackendChangeDecision({
    baseSha: env.BASE_SHA ?? "", headSha: env.HEAD_SHA ?? "", testedSha: env.TESTED_SHA ?? "", cwd,
  });
  writeFileSync(path.join(cwd, "backend-input-evidence.json"), JSON.stringify(decision, null, 2) + "\n");
  appendFileSync(env.GITHUB_OUTPUT, `run_rehearsal=${decision.run}\n`);
  appendFileSync(env.GITHUB_STEP_SUMMARY,
    `${decision.reason}. Base: ${decision.baseSha}. Head: ${decision.headSha}. Tested merge: ${decision.testedSha}.\n`);
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPathGateStep();
}