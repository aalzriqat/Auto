/**
 * Claude Code PreToolUse hook. Blocks git commit / git push / PR creation
 * (and the GitHub MCP write tools) unless the skills the README table requires
 * for the files involved were invoked earlier in this session.
 *
 * Reads the hook JSON on stdin. Evidence is the session transcript: a `Skill`
 * tool call, or a typed /skill command. Deny = JSON permissionDecision on
 * stdout. Any crash exits non-zero and settings.json sets onFailure: block, so
 * a broken gate fails closed.
 *
 * This proves a skill was invoked, not that it was followed. The PR check
 * (checkPrSkillEvidence.mjs) is the backstop for the second half, and it runs
 * from the base branch so a PR cannot weaken its own check. A hook an agent can
 * edit is a guard on mistakes, not a boundary.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPaths, invokedSkills, requiredSkills } from "./policy.mjs";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";

const UNKNOWN_BASE = { sensitive: ["(changed files unknown)"], gate: [], code: ["(unknown)"] };
const EXTRA_GIT_PATHS = ["/usr/local/bin/git", "/opt/homebrew/bin/git", "/usr/bin/git", "/bin/git"];

/** Absolute git path, never PATH-resolved. Null when none is found (callers treat the change as unknown). */
export function gitExecutable(exists = existsSync, resolve = resolveTrustedGitExecutable) {
  try {
    return resolve();
  } catch {
    return EXTRA_GIT_PATHS.find((p) => exists(p)) ?? null;
  }
}

const ARG = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const GIT_STEP = new RegExp(
  String.raw`\bgit\b((?:\s+(?:-[Cc]\s+${ARG}|--?[\w-]+(?:=\S+)?))*)\s+(commit|push)\b`,
  "g",
);
// A match is skipped only when git is an argument to one of these, as in
// `echo git commit` or `grep 'git push' notes`. Anything else counts: do, then,
// else, timeout, nice, !, sudo -u x, env, command and bash -c all reach git.
const TEXT_COMMANDS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg"]);
const SEGMENT_BREAK = /[;&|\n(){`]|\$\(/;
const isTextArgument = (command, index) =>
  TEXT_COMMANDS.has(command.slice(0, index).split(SEGMENT_BREAK).pop().trim().split(/\s+/)[0]);

// Commands the scan cannot read: text piped into a shell, a command word held in
// a variable, eval. They are gated as an unknown commit and push, whatever
// produces the text, rather than skipped.
const SHELL_PIPE = new RegExp(
  String.raw`\|&?\s*(?:(?:sudo|env|exec|command|xargs)\s+(?:-\S+\s+)*)?(?:[\w./~-]*/)?(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)\b`,
);
const UNPARSEABLE = [SHELL_PIPE, /\beval\b/, /\$\{?\w+\}?\s+(?:commit|push)\b/];
const REPO_ENV = /\b(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE)=/;
const CD = /(?:^|[;&|(\n{])\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|()]+)/g;
const DIR_OPTION = new RegExp(String.raw`(?:^|\s)-C\s+(${ARG})`, "g");
const OPAQUE_REPO_OPTION = /(?:^|\s)--(?:git-dir|work-tree)\b/;
const DYNAMIC = /[$`~]/;
const unquote = (a) => a.replace(/^(["'])(.*)\1$/, "$2");

// `git commit` options that take a value in the next word.
const VALUE_LONG = new Set([
  "--message", "--file", "--reuse-message", "--reedit-message", "--author", "--date",
  "--template", "--fixup", "--squash", "--cleanup", "--trailer",
]);
const VALUE_SHORT = new Set(["m", "F", "C", "c", "t"]);
const ATTACHED_SHORT = new Set(["S", "u"]);

/**
 * Words of a command's arguments up to the first unquoted separator, unquoted.
 * Null when a quote is not closed. A word with `$`, a backtick or `~` is dynamic.
 */
function splitArgs(tail) {
  const words = [];
  let word = null;
  let quote = null;
  let dynamic = false;
  let openedAt = -1;
  const push = () => {
    if (word !== null) words.push({ text: word, dynamic });
    word = null;
    dynamic = false;
  };
  for (const [at, ch] of [...tail].entries()) {
    if (quote) {
      if (ch === quote) quote = null;
      else {
        word += ch;
        if (quote === '"' && DYNAMIC.test(ch)) dynamic = true;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      openedAt = at;
      word ??= "";
    } else if (/[;&|\n)]/.test(ch)) {
      break;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      word = (word ?? "") + ch;
      if (DYNAMIC.test(ch)) dynamic = true;
    }
  }
  // A quote opened by the last character is the closing quote of a wrapper such
  // as `bash -c 'git commit -m x'`; any other open quote is unreadable.
  if (quote && openedAt !== tail.trimEnd().length - 1) return null;
  push();
  return words;
}

/** Pathspecs, -a/--all and whether the options cannot be read, for the words after `git commit`. */
function commitArgs(tail) {
  const words = splitArgs(tail);
  const out = { all: false, paths: [], unknown: words === null };
  if (words === null) return out;
  let afterDashes = false;
  if (words.some((w) => w.dynamic)) out.unknown = true;
  for (let i = 0; i < words.length; i++) {
    const { text } = words[i];
    if (afterDashes) out.paths.push(text);
    else if (text === "--") afterDashes = true;
    else if (text.startsWith("--")) {
      const name = text.split("=")[0];
      if (name === "--all") out.all = true;
      if (["--patch", "--interactive", "--pathspec-from-file"].includes(name)) out.unknown = true;
      if (VALUE_LONG.has(name) && !text.includes("=")) i++;
    } else if (text.startsWith("-") && text.length > 1) {
      for (let k = 1; k < text.length; k++) {
        const ch = text[k];
        if (ch === "a") out.all = true;
        if (ch === "p") out.unknown = true;
        if (VALUE_SHORT.has(ch)) {
          if (k === text.length - 1) i++;
          break;
        }
        if (ATTACHED_SHORT.has(ch)) break;
      }
    } else out.paths.push(text);
  }
  if (out.unknown) out.paths = [];
  return out;
}

const unknownStep = (step) => ({ step, all: false, dirs: [], opaque: false, paths: [], unknown: true });

/**
 * Commit, push and PR steps named in a shell command. Each has -a/--all, the
 * directories git runs in (`-C <dir>` and any earlier `cd <dir>`), whether the
 * repository is redirected (--git-dir, --work-tree, GIT_DIR=), the pathspecs a
 * commit names, and whether the arguments could not be read (then the files are
 * unknown and the change is treated as money). The scan is over the raw text,
 * so it sees `bash -c 'git commit'`, `env git push` and `$(git commit)`.
 * `echo git commit` and `grep 'git push'` are not steps, but text piped into a
 * shell, eval and a command word in a variable are gated as unknown steps.
 * Residual bypass: a git alias, or a script or program that runs git itself.
 */
export function gitSteps(command) {
  const steps = [];
  for (const m of command.matchAll(GIT_STEP)) {
    if (isTextArgument(command, m.index)) continue;
    const before = command.slice(0, m.index);
    const step = m[2];
    const args = step === "commit" ? commitArgs(command.slice(m.index + m[0].length)) : { all: false, paths: [], unknown: false };
    const cdAll = [...before.matchAll(CD)].map((d) => unquote(d[1]));
    const cdDirs = cdAll.filter((d) => !DYNAMIC.test(d));
    steps.push({
      step,
      all: args.all,
      dirs: [...cdDirs, ...[...m[1].matchAll(DIR_OPTION)].map((d) => unquote(d[1]))],
      opaque: OPAQUE_REPO_OPTION.test(m[1]) || REPO_ENV.test(before) || cdAll.length > cdDirs.length,
      paths: args.paths,
      unknown: args.unknown,
    });
  }
  if (/\bgh\s+pr\s+create\b/.test(command)) steps.push({ ...unknownStep("pr"), unknown: false });
  if (UNPARSEABLE.some((re) => re.test(command))) steps.push(unknownStep("commit"), unknownStep("push"));
  return steps;
}

function makeGit(cwd, exe) {
  return (args, timeout) =>
    execFileSync(exe, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout })
      .split("\n")
      .filter(Boolean);
}

/** Files this branch changes: since its upstream if it has one, else since main. Null if unknown. */
function branchFiles(git, preferUpstream) {
  try {
    // A stale origin/main makes the diff list other people's merged files.
    git(["fetch", "-q", "origin", "main"], 15000);
  } catch {
    /* offline: fall back to the refs we have */
  }
  const bases = preferUpstream ? ["@{upstream}", "origin/main", "main"] : ["origin/main", "main"];
  for (const base of bases) {
    try {
      const mb = git(["merge-base", base, "HEAD"])[0];
      if (mb) return git(["diff", "--name-only", `${mb}...HEAD`]);
    } catch {
      /* try next base */
    }
  }
  return null;
}

function bashStep({ step, all, dirs, opaque, paths, unknown }, cwd, exe) {
  if (unknown || opaque || !exe) return { step, files: null };
  const git = makeGit(dirs.reduce((dir, d) => path.resolve(dir, d), cwd), exe);
  try {
    if (step === "commit") {
      const staged = git(["diff", "--cached", "--name-only"]);
      const unstaged = all ? git(["diff", "--name-only"]) : [];
      // `git commit <paths>` commits those paths whatever is staged; git expands
      // directories and globs, and refuses paths outside the repository (unknown).
      const named = paths.length ? git(["ls-files", "--full-name", "--", ...paths]) : [];
      return { step, files: [...staged, ...unstaged, ...named] };
    }
    const files = branchFiles(git, step === "push");
    return { step, files: files && step === "push" ? files.concat(git(["diff", "--cached", "--name-only"])) : files };
  } catch {
    return { step, files: null };
  }
}

/** A push in the same command as a commit also carries what that commit will record. */
function carryCommits(results) {
  const commits = results.filter((r) => r.step === "commit");
  return results.map((r) => {
    if (r.step !== "push" || commits.length === 0) return r;
    if (!r.files || commits.some((c) => !c.files)) return { ...r, files: null };
    return { ...r, files: r.files.concat(...commits.map((c) => c.files)) };
  });
}

export function stepsFor(input, exe = gitExecutable()) {
  const { tool_name: tool, tool_input: ti = {}, cwd = process.cwd() } = input;
  const git = exe ? makeGit(cwd, exe) : null;
  if (tool === "Bash") return carryCommits(gitSteps(String(ti.command ?? "")).map((s) => bashStep(s, cwd, exe)));
  if (tool === "mcp__github__create_pull_request") return [{ step: "pr", files: git ? branchFiles(git, false) : null }];
  if (tool === "mcp__github__push_files") {
    return [{ step: "push", files: (ti.files ?? []).map((f) => f.path).filter(Boolean) }];
  }
  if (tool === "mcp__github__create_or_update_file" || tool === "mcp__github__delete_file") {
    return [{ step: "push", files: [ti.path].filter(Boolean) }];
  }
  return [];
}

export function decide(input, transcriptText, exe) {
  const steps = stepsFor(input, exe);
  if (steps.length === 0) return null;
  const have = invokedSkills(transcriptText);
  const problems = [];
  for (const { step, files } of steps) {
    const classes = files ? classifyPaths(files) : UNKNOWN_BASE;
    for (const { skill, why } of requiredSkills(step, classes)) {
      if (!have.has(skill)) problems.push(`  - ${skill} (${why}) before ${step}`);
    }
  }
  if (problems.length === 0) return null;
  return [
    "Blocked by the skill gate (.claude/skills/README.md, scripts/skillEnforcement).",
    "Invoke these skills with the Skill tool in this session, apply them, then retry:",
    ...new Set(problems),
    "Money and permission fixes also need a red run of the new test before the fix. The PR check verifies the evidence section.",
  ].join("\n");
}

/** Hook entry: JSON in, JSON out. Exported so tests drive it without a process. */
export function run(rawInput, readTranscript = (p) => readFileSync(p, "utf8"), exe) {
  const input = JSON.parse(rawInput);
  let transcript = "";
  try {
    transcript = readTranscript(input.transcript_path);
  } catch {
    // No readable transcript means no proof of invocation: the gate still applies.
  }
  const reason = decide(input, transcript, exe);
  if (!reason) return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(run(readFileSync(0, "utf8")));
}
