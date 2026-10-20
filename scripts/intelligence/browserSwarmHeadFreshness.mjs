import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SCRUM-777 — a stale swarm must never act on, or certify, a superseded PR head.
 *
 * Reads the PR's live head and merge refs and compares them with the head and
 * merge commit this swarm run was planned against. Anything but an exact match
 * is not fresh, including an unreadable ref: cannot-verify is a failure, never
 * a pass. The refs are read with git, as the verdict job does, so the job needs
 * no permission beyond `contents: read`.
 */

const SHA = /^[0-9a-f]{40}$/i;

/** @param {string} stdout `git ls-remote` output @returns {Map<string, string>} */
export function parseLsRemoteRefs(stdout) {
  const refs = new Map();
  for (const line of String(stdout).split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref && SHA.test(sha) && /^refs\/pull\/\d+\/(head|merge)$/.test(ref)) {
      refs.set(ref, sha.toLowerCase());
    }
  }
  return refs;
}

/**
 * @param {{ prNumber: string, expectedHeadSha: string, expectedTestedSha: string, refs: Map<string, string> }} input
 * @returns {{ fresh: boolean, reason: string }}
 */
export function evaluateHeadFreshness({ prNumber, expectedHeadSha, expectedTestedSha, refs }) {
  if (!/^\d+$/.test(prNumber) || !SHA.test(expectedHeadSha) || !SHA.test(expectedTestedSha)) {
    return { fresh: false, reason: "PR number, head SHA and tested SHA must be exact." };
  }
  const head = refs.get("refs/pull/" + prNumber + "/head");
  const merge = refs.get("refs/pull/" + prNumber + "/merge");
  if (!head || !merge) {
    return { fresh: false, reason: "The live PR head or merge ref could not be read." };
  }
  if (head !== expectedHeadSha.toLowerCase()) {
    return { fresh: false, reason: "The PR head moved to " + head + "; this run tested " + expectedHeadSha + "." };
  }
  if (merge !== expectedTestedSha.toLowerCase()) {
    return { fresh: false, reason: "The PR merge commit moved to " + merge + "; this run tested " + expectedTestedSha + "." };
  }
  return { fresh: true, reason: "PR head and merge are the tested ones." };
}

/**
 * Throws unless the live PR head and merge are the ones this run was planned
 * against. The token travels in a git header, never in the URL or an error.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(file: string, args: string[], options: object) => string} [runGit]
 */
export function assertSwarmHeadFresh(env = process.env, runGit = execFileSync) {
  const token = env.GITHUB_TOKEN ?? "";
  const repository = env.GITHUB_REPOSITORY ?? "";
  const prNumber = env.PR_NUMBER ?? "";
  if (!token || !repository || !/^\d+$/.test(prNumber)) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and a numeric PR_NUMBER are required.");
  }
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const header = "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + token).toString("base64");

  let stdout;
  try {
    stdout = runGit(
      "git",
      [
        "-c",
        "http.extraheader=" + header,
        "ls-remote",
        server + "/" + repository + ".git",
        "refs/pull/" + prNumber + "/head",
        "refs/pull/" + prNumber + "/merge",
      ],
      { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    // git's own message can echo the remote; the token must stay out of the log.
    throw new Error("Could not read the live PR refs; refusing to treat this run as current.");
  }

  const result = evaluateHeadFreshness({
    prNumber,
    expectedHeadSha: env.EXPECTED_HEAD_SHA ?? "",
    expectedTestedSha: env.EXPECTED_TESTED_SHA ?? "",
    refs: parseLsRemoteRefs(stdout),
  });
  if (!result.fresh) {
    throw new Error("Stale swarm run refused: " + result.reason);
  }
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(assertSwarmHeadFresh().reason + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
