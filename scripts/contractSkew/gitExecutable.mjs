/**
 * Locate `git` WITHOUT a PATH lookup.
 *
 * `execFileSync("git", ...)` resolves the program through `PATH`, so whatever
 * directory is first on `PATH` that holds a `git` wins — including a writable one
 * (Sonar S4036). This control decides whether production is behind `main`; the
 * program it shells out to should not be chosen by the environment's search path.
 *
 * Node's own binary has `process.execPath`, but git has no equivalent, so this
 * probes the fixed install locations and takes the first that exists. It
 * deliberately does NOT fall back to a bare `git`: that would reinstate the PATH
 * lookup behind the caller's back. When nothing is found it returns `undefined`,
 * and the caller treats "could not ask" as UNKNOWN, which the classifier already
 * fails closed on (it alarms rather than reading as "nothing changed").
 *
 * `CONTRACT_SKEW_GIT` names an absolute path explicitly, for a git installed
 * somewhere unusual. A relative value is ignored, because a relative path is a
 * lookup relative to the working directory — the same trust problem.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function gitCandidates(platform, env) {
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")];
    return roots.filter(Boolean).map((root) => path.win32.join(/** @type {string} */ (root), "Git", "cmd", "git.exe"));
  }
  return ["/usr/bin/git", "/usr/local/bin/git", "/bin/git", "/opt/homebrew/bin/git"];
}

/**
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, exists?: (p: string) => boolean }} [deps]
 * @returns {string | undefined} an absolute path, or undefined when git cannot be located.
 */
export function resolveGit({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const explicit = env.CONTRACT_SKEW_GIT;
  if (explicit && pathApi.isAbsolute(explicit)) return exists(explicit) ? explicit : undefined;
  return gitCandidates(platform, env).find((candidate) => exists(candidate));
}
