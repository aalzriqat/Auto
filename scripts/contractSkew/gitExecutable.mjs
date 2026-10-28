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
import { execFileSync } from "node:child_process";
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

/**
 * A revision typed on a command line is untrusted input to git. Git reads an argument that starts with `-` as an
 * option (argument injection: `--output=<file>`, `--upload-pack=<cmd>`; CWE-88, Sonar jssecurity:S8705), so a
 * revision is accepted only when it is a plain ref name, abbreviated or full commit id, or `~`/`^` ancestry of one:
 * it must start with a letter, digit or underscore and use only `[A-Za-z0-9_./@^~-]`. That refuses a leading `-`,
 * whitespace, `:`, `{}` (so `@{u}` and `rev^{tree}` forms), `..` ranges and control characters. The command also
 * passes `--end-of-options` so git itself stops option parsing, which is the documented defence in depth
 * (git-rev-parse(1), gitcli(7)); the allow-list is what makes the value safe for the commands that lack it.
 */
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9_./@^~-]{0,254}$/;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * @param {unknown} revision
 * @param {string} [role]
 * @returns {string} the same revision, once it is known to be a plain revision name
 */
export function assertSafeRevision(revision, role = "revision") {
  if (typeof revision !== "string" || !REVISION.test(revision) || revision.includes("..")) {
    throw new Error(`${role} ${JSON.stringify(String(revision).slice(0, 80))} is not a plain revision name or commit id (a leading "-", whitespace, ":" "{}" or ".." is refused)`);
  }
  return revision;
}

/** A git argument is a string without a NUL byte (which would end the C string early inside git). */
function assertGitArguments(args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new Error("git arguments must be strings without NUL bytes");
  }
}

/** Upper bound for one git call made by the author tools (relocation, renewal). */
export const GIT_TIMEOUT_MS = 10_000;

/**
 * Run git by absolute path with an explicit timeout and return its stdout as UTF-8 text. Text and bytes are
 * separate functions, not one function with an optional `encoding`, so each has one return type
 * (`execFileSync` returns `string | Buffer` for a non-literal encoding, which no caller can use).
 *
 * @param {string} git  from `resolveGit()`
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number }} [options]
 * @returns {string}
 */
export function runGitText(git, args, { cwd, maxBuffer = 16 * 1024 * 1024 } = {}) {
  assertGitArguments(args);
  return execFileSync(git, args, { cwd, encoding: "utf8", maxBuffer, timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Same as `runGitText` but returns the raw bytes, for a caller that must decode strictly.
 *
 * @param {string} git
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number }} [options]
 * @returns {Buffer}
 */
export function runGitBytes(git, args, { cwd, maxBuffer = 16 * 1024 * 1024 } = {}) {
  assertGitArguments(args);
  return execFileSync(git, args, { cwd, maxBuffer, timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The full commit id a revision names. `--end-of-options` stops a revision that starts with `-`
 * being read as a flag (git-rev-parse documents it for `--verify`).
 *
 * @param {string} git
 * @param {string} rev
 * @param {string} [cwd]
 */
export function resolveCommit(git, rev, cwd) {
  assertSafeRevision(rev);
  const commit = runGitText(git, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], { cwd }).trim();
  if (!COMMIT_ID.test(commit)) throw new Error(`git did not return a full commit id for ${rev}`);
  return commit;
}

/**
 * Whether `ancestor` is an ancestor of (or equal to) `descendant`. Both are validated revisions.
 *
 * @param {string} git
 * @param {string} ancestor
 * @param {string} descendant
 * @param {string} [cwd]
 */
export function isAncestor(git, ancestor, descendant, cwd) {
  assertSafeRevision(ancestor, "ancestor");
  assertSafeRevision(descendant, "descendant");
  try {
    runGitText(git, ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}