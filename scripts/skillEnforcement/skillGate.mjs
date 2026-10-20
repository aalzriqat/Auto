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

// Commands the scan cannot read: text piped into a shell, eval and its
// PowerShell forms (iex, Invoke-Expression, `& $cmd`, -Command), a shell -c with
// a dynamic argument, a command word held in a variable, and git aliases. They
// are gated as an unknown commit and push, whatever produces the text, rather
// than skipped. Quoted text that is an argument to a non-shell command is not
// code, so it is blanked out before these patterns run (see blankQuotedText).
const SHELL_PIPE = new RegExp(
  String.raw`\|&?\s*(?:(?:sudo|env|exec|command|xargs)\s+(?:-\S+\s+)*)?(?:[\w./~-]*/)?(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)\b`,
);
const COMMAND_POSITION = String.raw`(?:^|[;&|(\n{!\`]|\$\(|\b(?:do|then|else|sudo|env|exec|command|xargs|time|nice|nohup)\s)\s*`;
const EVAL_LIKE = new RegExp(`${COMMAND_POSITION}(?:eval|iex|invoke-expression)\\b`, "i");
// An inline interpreter (node -e, python -c, deno eval, ...) whose code reaches a process API can run git.
const INLINE_RUNNER = String.raw`\b(?:node(?:js)?|bun|deno|python[\d.]*|perl|ruby|php)\b[^\n]*?(?:\s-(?:e|c|E|pe)\b|\s--eval\b|\seval\s)`;
const PROCESS_API = String.raw`child_process|execSync|execFileSync|execFile|spawn|subprocess|os\.system|os\.popen|Deno\.Command`;
// perl and ruby reach a shell through language syntax too: system, exec, qx, backticks, %x, a piped open, IO.popen, Open3.
const PERL_RUBY_RUNNER = String.raw`\b(?:perl|ruby)\b[^\n]*?\s-(?:e|E|pe)\b`;
const PERL_RUBY_SHELL = String.raw`\b(?:system|exec|qx|popen|open3|spawn)\b|\bopen\b[^\n]*\||\`|%x`;
const UNPARSEABLE = [
  // ripgrep runs the --pre and --hostname-bin programs it is given.
  /\brg\b[^|;&\n]*\s--(?:pre|hostname-bin)(?=[\s=]|$)/,
  new RegExp(`${INLINE_RUNNER}[^\\n]*?(?:${PROCESS_API})`, "i"),
  new RegExp(`${PERL_RUBY_RUNNER}[^\\n]*?(?:${PERL_RUBY_SHELL})`, "i"),
  SHELL_PIPE,
  EVAL_LIKE,
  /(?<!&)&\s*\$\{?\w+/,
  /\b(?:pwsh|powershell)(?:\.exe)?\b[^|;&\n]*\s-(?:c|command|ec|encodedcommand)\b/i,
  /\b(?:ba|z|da|k)?sh\s+-\w*c\s+["']?\$/,
  /\$\{?\w+\}?\s+(?:commit|push)\b/,
  /\b(?:start-process|saps)\b[^;&|\n]*\bgit\b/i,
];

// Allowlist. Quoted text is blanked only in a segment whose command is known to
// treat it as text and nothing else. Everything else (pnpm exec, npx, find -exec,
// watch, parallel, node -e, python -c, Start-Process, ...) keeps its quotes
// scanned and fails closed.
const TEXT_ONLY_COMMANDS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "jira"]);
const SKIPPED_WORDS = new Set(["!", "do", "then", "else", "{", "(", "&&", "||"]);
// Flags and words that make a command run its arguments as code. They are looked
// for on the dequoted words of the segment, so `rg "--pre" …` and `"sh" -c …` count.
const RUNS_CODE_SHORT_FLAG = /^-(?:c|e|E)$/;
const RUNS_CODE_FLAG = /^(?:-(?:ec|command|encodedcommand|argumentlist|exec|execute)$|--(?:pre|pre-glob|hostname-bin|editor)(?:=|$))/i;
const RUNS_CODE_WORD = new RegExp(
  String.raw`^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|eval|iex|invoke-expression|node|python\d*|ruby|perl|php|xargs|parallel|watch|find|start-process|saps|npx|pnpm|npm|yarn|env|sudo|exec|timeout|nice|nohup|time|ssh|su)$`,
  "i",
);
const EXECUTES_QUOTED = /\$\(|`/;

function commandWord(segment) {
  const word = segment.trim().split(/\s+/).find((w) => w && !/^\w+=/.test(w) && !SKIPPED_WORDS.has(w)) ?? "";
  return word.split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
}

function isTextOnlySegment(text) {
  // A leading VAR=value can redirect what the tool runs (EDITOR, GH_EDITOR, RIPGREP_CONFIG_PATH, GIT_SSH_COMMAND, ...).
  if (/^\s*\w+=/.test(text)) return false;
  const word = commandWord(text);
  const known =
    TEXT_ONLY_COMMANDS.has(word) ||
    (word === "git" && /\bcommit\b/.test(text)) ||
    (word === "gh" && /^\s*gh\s+(?:pr|issue)\b/.test(text));
  if (!known) return false;
  const words = splitArgs(text);
  if (words === null) return false;
  const code = words.slice(1).some(({ text: w }) => {
    const base = w.split(/[\\/]/).pop().replace(/\.exe$/i, "");
    return RUNS_CODE_SHORT_FLAG.test(w) || RUNS_CODE_FLAG.test(w) || RUNS_CODE_WORD.test(base);
  });
  return !code && !/[<>]\(/.test(text.replace(/"[^"]*"|'[^']*'/g, " "));
}

/**
 * The command with quoted text replaced by spaces (same length), only inside a
 * segment that isTextOnlySegment accepts, and never inside a quote that
 * executes (`"$(…)"`, backticks). `grep -rn "eval(" src`, `echo "git push"` and
 * `jira comment add "git push failed"` hold text; `pnpm exec sh -c '…'` holds code.
 */
function blankQuotedText(command) {
  const out = [...command];
  const spans = []; // [start, end) of each quote-aware segment
  let start = 0;
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/[;&|\n(){`]/.test(ch)) {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  spans.push([start, command.length]);
  for (const [from, to] of spans) {
    const text = command.slice(from, to);
    if (!isTextOnlySegment(text)) continue;
    for (let i = from; i < to; i++) {
      const ch = command[i];
      if (ch !== '"' && ch !== "'") continue;
      const close = command.indexOf(ch, i + 1);
      if (close < 0 || close >= to) break;
      if (!EXECUTES_QUOTED.test(command.slice(i + 1, close))) {
        for (let k = i + 1; k < close; k++) out[k] = " ";
      }
      i = close;
    }
  }
  return out.join("");
}

// Git subcommands that are not aliases. Anything else after `git` (or any
// `-c alias.*`/`--config-env`) may be an alias for push or commit.
const GIT_BUILTINS = new Set([
  "add", "am", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "checkout", "cherry",
  "cherry-pick", "clean", "clone", "commit", "commit-tree", "config", "count-objects", "credential", "describe",
  "diff", "difftool", "fetch", "for-each-ref", "format-patch", "fsck", "gc", "grep", "hash-object", "help",
  "init", "log", "ls-files", "ls-remote", "ls-tree", "maintenance", "merge", "merge-base", "mergetool", "mv",
  "name-rev", "notes", "pack-refs", "prune", "pull", "push", "range-diff", "rebase", "reflog", "remote",
  "repack", "replace", "request-pull", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog",
  "show", "show-ref", "sparse-checkout", "stash", "status", "submodule", "switch", "symbolic-ref", "tag",
  "update-index", "update-ref", "verify-commit", "verify-tag", "version", "whatchanged", "worktree", "write-tree",
]);
const GIT_COMMAND = new RegExp(
  String.raw`${COMMAND_POSITION}(?:[\w./~-]*/)?git\b((?:\s+(?:-[Cc]\s+${ARG}|--?[\w-]+(?:=\S+)?))*)\s+([^\s;&|()]+)`,
  "gi",
);
// The same, once quotes are removed (`git "-c" alias.p=push p`); only the config options are read there.
const ALIAS_CONFIG = /\bgit\b[^|;&\n]*\s(?:-c\s+alias\.|--config-env)/i;
const mayBeAlias = (text) =>
  [...text.matchAll(GIT_COMMAND)].some(
    (m) => /-c\s+alias\.|--config-env/i.test(m[1]) || !GIT_BUILTINS.has(m[2].toLowerCase()),
  );
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
 * `echo git commit` and `grep 'git push'` are not steps, and quoted text that is
 * an argument to a non-shell command is never scanned. Text piped into a shell,
 * eval and its PowerShell forms, a dynamic `sh -c`, a command word in a variable
 * and a git alias (`-c alias.*`, or a subcommand that is not a built-in) are
 * gated as unknown steps. Residual bypass: a script or program that runs git itself.
 */
export function gitSteps(command) {
  const steps = [];
  const scan = blankQuotedText(command);
  for (const found of scan.matchAll(GIT_STEP)) {
    if (isTextArgument(scan, found.index)) continue;
    // Options are read from the original text: a blanked `-C "my dir"` would lose its path.
    const m = new RegExp(GIT_STEP.source).exec(command.slice(found.index, found.index + found[0].length)) ?? found;
    m.index = found.index;
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
  // Quotes do not hide a word from the shell: `rg "--pre" sh` and `"sh" -c` are the same commands.
  const dequoted = scan.replace(/["']/g, "");
  if (UNPARSEABLE.some((re) => re.test(scan) || re.test(dequoted)) || mayBeAlias(scan) || ALIAS_CONFIG.test(dequoted)) {
    steps.push(unknownStep("commit"), unknownStep("push"));
  }
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
