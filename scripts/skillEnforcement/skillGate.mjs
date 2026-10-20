#!/usr/bin/env node
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
  String.raw`\bgit\b((?:\s+(?:-[Cc]\s+${ARG}|--?[\w-]+(?:=\S+)?))*)\s+(commit|push)\b([^;&|\n'")]*)`,
  "g",
);
const ALL_FLAG = /(?:^|\s)(?:--all|-[a-zA-Z]*a[a-zA-Z]*)(?=\s|$)/;

/**
 * Commit, push and PR steps named anywhere in a shell command, with whether
 * -a/--all was passed. The scan is over the raw text on purpose: it also sees
 * `bash -c 'git commit'`, `env git push`, `$(git commit)` and `xargs git push`.
 * It over-matches (`echo git commit` counts), which only costs a skill check.
 * Residual bypass: a command built at run time (`g=git; $g commit`), a git
 * alias, or a script or other program that runs git itself.
 */
export function gitSteps(command) {
  const steps = [];
  for (const m of command.matchAll(GIT_STEP)) {
    steps.push({ step: m[2], all: ALL_FLAG.test(m[3]) });
  }
  if (/\bgh\s+pr\s+create\b/.test(command)) steps.push({ step: "pr", all: false });
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

function bashStep({ step, all }, git) {
  if (!git) return { step, files: null };
  try {
    if (step === "commit") {
      const staged = git(["diff", "--cached", "--name-only"]);
      return { step, files: all ? [...staged, ...git(["diff", "--name-only"])] : staged };
    }
    const files = branchFiles(git, step === "push");
    // `git commit … && git push` in one command: the commit is not made yet.
    return { step, files: files && step === "push" ? files.concat(git(["diff", "--cached", "--name-only"])) : files };
  } catch {
    return { step, files: null };
  }
}

export function stepsFor(input, exe = gitExecutable()) {
  const { tool_name: tool, tool_input: ti = {}, cwd = process.cwd() } = input;
  const git = exe ? makeGit(cwd, exe) : null;
  if (tool === "Bash") return gitSteps(String(ti.command ?? "")).map((s) => bashStep(s, git));
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
