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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyPaths, invokedSkills, requiredSkills } from "./policy.mjs";

const UNKNOWN_BASE = { sensitive: ["(changed files unknown)"], gate: [], code: ["(unknown)"] };

const ARG = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const GIT_STEP = new RegExp(
  String.raw`\bgit\b((?:\s+(?:-[Cc]\s+${ARG}|--?[\w-]+(?:=\S+)?))*)\s+(commit|push)\b([^;&|\n'")]*)`,
  "g",
);

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
    const all = /(^|\s)(--all|-[a-zA-Z]*a[a-zA-Z]*)(?=\s|$)/.test(m[3]);
    steps.push({ step: m[2], all });
  }
  if (/\bgh\s+pr\s+create\b/.test(command)) steps.push({ step: "pr", all: false });
  return steps;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\n")
    .filter(Boolean);
}

let fetched = false;
function freshenMain(cwd) {
  if (fetched) return;
  fetched = true;
  try {
    // A stale origin/main makes the diff list other people's merged files.
    execFileSync("git", ["fetch", "-q", "origin", "main"], { cwd, stdio: "ignore", timeout: 15000 });
  } catch {
    /* offline: fall back to the refs we have */
  }
}

/** Files this branch changes: since its upstream if it has one, else since main. */
function branchFiles(cwd, preferUpstream) {
  const bases = preferUpstream ? ["@{upstream}", "origin/main", "main"] : ["origin/main", "main"];
  freshenMain(cwd);
  for (const base of bases) {
    try {
      const mb = git(cwd, ["merge-base", base, "HEAD"])[0];
      if (mb) return git(cwd, ["diff", "--name-only", `${mb}...HEAD`]);
    } catch {
      /* try next base */
    }
  }
  return null;
}

export function stepsFor(input) {
  const { tool_name: tool, tool_input: ti = {}, cwd = process.cwd() } = input;
  if (tool === "Bash") {
    return gitSteps(String(ti.command ?? "")).map((s) => {
      let files;
      try {
        if (s.step === "commit") {
          files = git(cwd, ["diff", "--cached", "--name-only"]);
          if (s.all) files = [...files, ...git(cwd, ["diff", "--name-only"])];
        } else {
          files = branchFiles(cwd, s.step === "push");
          // `git commit … && git push` in one command: the commit is not made yet.
          if (files && s.step === "push") files = [...files, ...git(cwd, ["diff", "--cached", "--name-only"])];
        }
      } catch {
        files = null;
      }
      return { step: s.step, files };
    });
  }
  if (tool === "mcp__github__create_pull_request") return [{ step: "pr", files: branchFiles(cwd, false) }];
  if (tool === "mcp__github__push_files") {
    return [{ step: "push", files: (ti.files ?? []).map((f) => f.path).filter(Boolean) }];
  }
  if (tool === "mcp__github__create_or_update_file" || tool === "mcp__github__delete_file") {
    return [{ step: "push", files: [ti.path].filter(Boolean) }];
  }
  return [];
}

export function decide(input, transcriptText) {
  const have = invokedSkills(transcriptText);
  const problems = [];
  for (const { step, files } of stepsFor(input)) {
    const classes = files ? classifyPaths(files) : UNKNOWN_BASE;
    for (const { skill, why } of requiredSkills(step, classes)) {
      if (!have.has(skill)) problems.push(`  - ${skill} (${why}) before ${step}`);
    }
  }
  if (problems.length === 0) return null;
  return [
    "Blocked by the skill gate (.claude/skills/README.md, scripts/skillEnforcement).",
    "Invoke these skills with the Skill tool in this session, apply them, then retry:",
    ...[...new Set(problems)],
    "Money and permission fixes also need a red run of the new test before the fix. The PR check verifies the evidence section.",
  ].join("\n");
}

function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  let transcript = "";
  try {
    transcript = readFileSync(input.transcript_path, "utf8");
  } catch {
    // No readable transcript means no proof of invocation: gate still applies.
  }
  const reason = decide(input, transcript);
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
