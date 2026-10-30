import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { accountingRehearsalPathGate } from "./accountingRehearsalPathGate.mjs";
import { resolveGit } from "./contractSkew/gitExecutable.mjs";

/** Fetched commits are data. No checkout, candidate imports, hooks or diff drivers.
 * Git plumbing avoids the compare API's 300-file and PR-files API's 3000-file caps.
 * @param {{baseSha: string, headSha: string, cwd?: string}} input
 */
export function readBackendChangeDecision({ baseSha, headSha, cwd }) {
  let paths;
  let complete = false;
  try {
    if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha)) {
      throw new Error("Exact commits unavailable");
    }
    // An absolute git path, never a PATH lookup (Sonar S4036). Not found RUNS.
    const git = resolveGit();
    if (!git) throw new Error("Git unavailable");
    const output = execFileSync(git, [
      "diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z",
      `${baseSha}...${headSha}`, "--",
    ], { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const names = new TextDecoder("utf-8", { fatal: true }).decode(output);
    // A partial record must never certify a complete diff.
    complete = names.endsWith("\0");
    paths = complete ? names.slice(0, -1).split("\0") : [];
  } catch {
    // Missing objects, timeouts, oversized output and invalid encoding RUN.
    // Raw Git diagnostics and candidate filenames never enter public logs.
  }
  return { ...accountingRehearsalPathGate({ paths, complete }), baseSha, headSha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const decision = readBackendChangeDecision({
    baseSha: process.env.BASE_SHA ?? "", headSha: process.env.HEAD_SHA ?? "",
  });
  writeFileSync("backend-input-evidence.json", JSON.stringify(decision, null, 2) + "\n");
  appendFileSync(process.env.GITHUB_OUTPUT, `run_rehearsal=${decision.run}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `${decision.reason}. Base: ${decision.baseSha}. Head: ${decision.headSha}.\n`);
}
