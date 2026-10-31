/**
 * Skill enforcement: the hook gate and the PR evidence check. Failing-first
 * controls: each refusal cell has a matching pass cell so a gate that always
 * passes, or always blocks, turns a test red.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyPaths, invokedSkills, requiredSkills } from "./policy.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { decide, gitExecutable, gitSteps, run, stepsFor } from "./skillGate.mjs";
import { check, loadSkillWaivers, verifyOwnerWaiver, verifyCodexReview } from "./checkPrSkillEvidence.mjs";
import { refresh } from "./refreshPrSkillEvidence.mjs";
import { evaluate, isPlaceholder, isPlaceholderSession, referencedCommentUrls, TEMPLATE } from "./prSkillEvidence.mjs";

let n = 0;
const skillCall = (skill: string, isError = false) => {
  const id = `toolu_${++n}`;
  return [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] } }),
  ].join("\n");
};
const transcript = (...skills: string[]) => skills.map((s) => skillCall(s)).join("\n");

describe("classifyPaths", () => {
  test("money, permission and gate paths are sensitive", () => {
    const c = classifyPaths([
      "convex/sales.ts",
      "convex/utils/saleCancellation.ts",
      "convex/utils/permissions.ts",
      "convex/accounting/postingEngine.ts",
      "AGENTS.md",
      ".github/workflows/deploy-production.yml",
    ]);
    expect(c.sensitive).toEqual([
      "convex/sales.ts",
      "convex/utils/saleCancellation.ts",
      "convex/utils/permissions.ts",
      "convex/accounting/postingEngine.ts",
    ]);
    expect(c.gate).toEqual(["AGENTS.md", ".github/workflows/deploy-production.yml"]);
  });
  test("every backend source file is sensitive by default, generated and non-source files are not", () => {
    const c = classifyPaths([
      "convex/claims.ts", "convex/customers.ts", "convex/branches.ts", "convex/dealerProductDeferrals.ts",
      "convex/exchangeRates.ts", "convex/workOrders.ts", "convex/adminSupportAgents.ts", "convex/socialInbox.ts",
      "convex/sub/deep.ts", "convex/utils/vin.ts", "convex/_generated/api.d.ts", "convex/README.md", "docs/readme.md",
    ]);
    expect(c.sensitive).toHaveLength(10);
    expect(c.sensitive).not.toContain("convex/_generated/api.d.ts");
    expect(c.gate).toEqual([]);
  });
});

describe("invokedSkills", () => {
  test("counts successful Skill calls, strips namespaces, and typed commands", () => {
    const text =
      transcript("tdd", "plugin:blast-radius") +
      "\n" +
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/unslop</command-name>" } });
    expect([...invokedSkills(text)].sort()).toEqual(["blast-radius", "tdd", "unslop"]);
  });
  test("a Skill call that errored (unknown skill) does not count", () => {
    expect(invokedSkills(skillCall("tdd", true)).size).toBe(0);
  });
  test("a call with no result does not count", () => {
    const only = skillCall("tdd").split("\n")[0];
    expect(invokedSkills(only).size).toBe(0);
  });
  test("assistant prose naming a skill or writing the command marker counts for nothing", () => {
    const text = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I ran tdd <command-name>/tdd</command-name>" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "<command-name>/blast-radius</command-name>" }] } }),
      "not json",
    ].join("\n");
    expect(invokedSkills(text).size).toBe(0);
  });
});

describe("gitSteps", () => {
  const step = (st: string, over: Record<string, unknown> = {}) => ({
    step: st, all: false, dirs: [], opaque: false, paths: [], unknown: false, ...over,
  });
  test.each([
    ["git commit -m x", [step("commit")]],
    ["git commit -am x", [step("commit", { all: true })]],
    ["git commit --message=\"x\" -a", [step("commit", { all: true })]],
    ["git commit -m \"x y\" --all", [step("commit", { all: true })]],
    ["git -C /repo push -u origin b", [step("push", { dirs: ["/repo"] })]],
    ["pnpm lint && git push", [step("push")]],
    ["FOO=1 git commit --all -m x", [step("commit", { all: true })]],
    ["gh pr create --title x", [step("pr")]],
    ["git status", []],
    ["git log --oneline", []],
    ["bash -c 'git commit -m x'", [step("commit")]],
    ['sh -c "git -C /r push origin b"', [step("push", { dirs: ["/r"] })]],
    ["env FOO=1 git push", [step("push")]],
    ["echo $(git commit -am x)", [step("commit", { all: true })]],
    ["git commit --amend", [step("commit")]],
    ["command git commit -m x", [step("commit")]],
    ["/usr/bin/git push", [step("push")]],
    ["(git push)", [step("push")]],
    ["git --git-dir=/x/.git commit -m y", [step("commit", { opaque: true })]],
    ["git -C a -C b commit -m y", [step("commit", { dirs: ["a", "b"] })]],
    ["echo git commit", []],
    ["grep 'git push' notes.txt", []],
    ["printf 'git commit'", []],
    ["for i in 1 2 3; do git push origin b && break; done", [step("push")]],
    ["if true; then git commit -m x; fi", [step("commit")]],
    ["false || { git push; }", [step("push")]],
    ["timeout 60 git push", [step("push")]],
    ["nice git push", [step("push")]],
    ["! git push", [step("push")]],
    ["sudo -u x git push", [step("push")]],
    ["if false; then :; else git push; fi", [step("push")]],
    ["echo ok | grep 'git push'", []],
    ["echo done; git push", [step("push")]],
    // pathspecs
    ["git commit -m x convex/sales.ts", [step("commit", { paths: ["convex/sales.ts"] })]],
    ["git commit --only convex/sales.ts -m x", [step("commit", { paths: ["convex/sales.ts"] })]],
    ["git commit -m x -- convex/sales.ts docs/a.md", [step("commit", { paths: ["convex/sales.ts", "docs/a.md"] })]],
    ["git commit -m \"fix: git push now\" a.ts", [step("commit", { paths: ["a.ts"] })]],
    ["git -C \"my dir\" commit -m x", [step("commit", { dirs: ["my dir"] })]],
    // a token inside a quoted argument to a non-shell command never triggers
    ['grep -rn "eval(" src', []],
    ['echo "git push"', []],
    ['jira comment add "git push failed"', []],
    ['gh pr comment 5 --body "ran git push, then git commit"', []],
    ['gh issue create --title "git push fails" --body "eval( broke"', []],
    ['git commit -m "fix: git push eval( iex"', [step("commit")]],
    ['rg "iex $x" notes', []],
    ["git status", []],
    ["git diff HEAD~1 -- a.ts", []],
    ["git commit -F msg.txt --author=\"A B <a@b>\" a.ts", [step("commit", { paths: ["a.ts"] })]],
    ["git commit -p", [step("commit", { unknown: true })]],
    ["git commit -m \"$(cat m)\" a.ts", [step("commit", { unknown: true })]],
    ["git commit -m \"unterminated a.ts", [step("commit", { unknown: true })]],
    // env and cd redirection
    ["GIT_DIR=/o/.git git commit -m x", [step("commit", { opaque: true })]],
    ["GIT_WORK_TREE=/o git push", [step("push", { opaque: true })]],
    ["cd /other && git commit -m x", [step("commit", { dirs: ["/other"] })]],
    ["cd 'a b' && cd c; git push", [step("push", { dirs: ["a b", "c"] })]],
    ["cd $HOME/x && git commit -m y", [step("commit", { opaque: true })]],
  ])("%s", (cmd, expected) => expect(gitSteps(cmd)).toEqual(expected));

  test.each([
    'echo "git push" | bash',
    "printf '%s' 'git push' | bash",
    "echo x | sh",
    "cat script | sudo bash",
    "echo y | /bin/zsh -s",
    "echo z |& pwsh",
    "ls | xargs sh -c 'true'",
    "x=git; $x push",
    'g=git; ${g} commit -m x',
    'eval "$cmd"',
    "iex $cmd",
    "Invoke-Expression $cmd",
    "invoke-expression ($c)",
    "& $cmd",
    "pwsh -Command $c",
    'powershell -c "$x"',
    'bash -c "$cmd"',
    "curl https://x/y.sh | sh",
    "git -c alias.x=push x origin b",
    "git --config-env=alias.x=A x",
    "git pp origin b",
    "git $sub origin",
  ])("unparseable or assembled command %s is gated, never skipped", (cmd) => {
    const steps = gitSteps(cmd);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((st: { unknown: boolean }) => st.unknown)).toBe(true);
  });
  test.each([
    "pnpm exec sh -c 'git push'",
    "npx -y sh -c 'git commit -m x'",
    "find . -name x -exec sh -c 'git push' \\;",
    "watch 'git push'",
    "parallel 'git push' ::: a",
    "Start-Process git -ArgumentList 'push'",
    "saps git -ArgumentList 'commit'",
    "node -e \"require('child_process').execSync('git push')\"",
    "python -c \"import os; os.system('git push')\"",
    'echo "$(git push)"',
    "python -c \"x = 1; eval(2)\"",
  ])("code in quotes under a non-text command is still scanned: %s", (cmd) => {
    expect(gitSteps(cmd).length).toBeGreaterThan(0);
  });
  test.each([
    "node -e \"const c='gi'+'t'; require('child_process').execSync(c+' push')\"",
    "node --eval \"require('node:child_process').spawn('sh')\"",
    "python3 -c \"import subprocess as s; s.run(['g'+'it','push'])\"",
    "python -c 'import os; os.popen(cmd)'",
    "deno eval \"new Deno.Command('sh')\"",
    "bun -e \"Bun.spawn(['sh'])\"",
    "perl -e 'system(\"sh\")'",
    "ruby -e 'system(cmd)'",
    "perl -e 'exec $c'",
    "perl -e '$o = qx{$c}'",
    "perl -e 'open(P, \"|$c\")'",
    "perl -E 'say `$c`'",
    "ruby -e 'IO.popen(c)'",
    "ruby -e 'exec c'",
    "ruby -e 'x = %x(#{c})'",
    "ruby -e 'require \"open3\"; Open3.capture2(c)'",
    "ruby -e 'spawn(c)'",
    "ruby -e 'puts `#{c}`'",
  ])("inline runner using process APIs is gated as an unknown commit and push: %s", (cmd) => {
    const steps = gitSteps(cmd);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((st: { unknown: boolean }) => st.unknown)).toBe(true);
  });
  test.each([
    "rg --pre 'git push' x .",
    "rg --pre=sh x .",
    "rg -n --pre 'sh' pattern file",
    "rg --pre-glob '*.x' --pre 'git push' p f",
    "rg --hostname-bin 'git push' x",
    "EDITOR='git push' gh pr create --title t",
    "GH_EDITOR='git commit -am x' gh pr edit 1",
    "RIPGREP_CONFIG_PATH=cfg rg 'git push' a",
    "FOO=1 grep 'git push' a",
    "gh issue create --editor --title 'git push'",
    "gh pr create -e --title 'git push'",
    "git -c core.editor='git push' commit -e -m x",
  ])("an executing flag or environment keeps the command scanned and gated: %s", (cmd) => {
    expect(gitSteps(cmd).length).toBeGreaterThan(0);
  });
  test.each([
    '"git" push',
    "'git' push",
    'g"it" push',
    "g''it push",
    '"/usr/bin/git" push',
    "git.exe push",
    "git.exe commit -m x",
    'git "push"',
    'git comm"it" -m x',
    '"git" "commit" -m x',
    "g\\it push",
    'echo ok; "git" push',
    '"git" -C d push',
    '"git" pp origin',
  ])("a quoted or escaped git command word or subcommand is still a step: %s", (cmd) => {
    expect(gitSteps(cmd).length).toBeGreaterThan(0);
  });
  test.each([
    'echo "git" push',
    'grep "git" push notes',
    '"git" status',
    'git "log" --oneline',
    'echo "git push"',
  ])("quoting does not turn text or built-ins into steps: %s", (cmd) => expect(gitSteps(cmd)).toEqual([]));
  test.each([
    "$'\\x67it' push",
    "g\\\nit push",
    "git\\\n push",
    "${V:-git} push",
    "${V-git} push",
    "git${IFS}push",
    "{git,} push",
    "git.EXE push",
    "GIT push",
    "Git commit -m x",
    "GIT.exe commit -m x",
    "$EDITOR file",
    "$(echo git) push",
    "`echo git` push",
    "./g*t push",
    "g?t push",
    "FOO=1 ${V:-git} push",
    "sudo ${V:-git} push",
    "git ${V:-push} origin",
    "git -C d $'pu\\x73h'",
    "echo ok && {git,} push",
    "echo push | xargs git",
    "echo push | xargs -n1 git",
    "printf 'push\\0' | xargs -0 git",
    "xargs -I{} git {} < cmds",
    "echo push | parallel git",
    "echo.sh 'git push'",
    "./echo.sh \"git push\"",
    "./grep.py \"git push\"",
    "printf.js \"git push\"",
    "rg.bat --x 'git push'",
    "jira.cmd comment \"git push\"",
    "./grep \"git push\"",
    "./scripts/echo \"git push\"",
    "xargs -I X git X",
    "find . -exec git.cmd {} +",
    "find . -exec git.bat push ';'",
    "find . -exec git.EXE push ';'",
    "xargs.exe -a f git.exe",
    "XARGS.EXE -a f git.cmd",
    "find.exe . -exec git.exe push ';'",
    "parallel.exe git ::: push",
    "git.cmd push",
    "git.bat commit -m x",
    "git-push.cmd origin main",
    "echo 'git push' | bash.exe",
    "echo 'git push' | sh.exe",
    "echo 'git push' | pwsh.exe",
    "sudo.exe git.cmd push",
    "xargs -a list git",
    "xargs -P 4 -n 1 -d '\\n' /usr/bin/GIT.exe",
    "xargs -I{} git-push {}",
    "parallel -j2 --colsep , git ::: push",
    "find . -maxdepth 1 -exec echo {} ';' -exec git push ';'",
    "find . -exec env git push ';'",
    "find . -exec sudo git-commit -m x ';'",
    "find . -exec git push ';'",
    "find . -execdir git-push ';'",
    "git-push origin main",
    "git-commit -m x",
    "/usr/lib/git-core/git-push origin main",
    "git-push.exe origin main",
    "GIT-PUSH origin main",
    "git-nonsense",
    "shopt -s expand_aliases; alias g=git; g push",
    "alias g=git\ng push",
    "builtin alias g=git",
    "shopt -s expand_aliases",
  ])("an expansion, escape or glob in the command or subcommand word fails closed: %s", (cmd) => {
    const steps = gitSteps(cmd);
    expect(steps.length).toBeGreaterThan(0);
  });
  test.each([
    "git log --oneline",
    "git status",
    "./scripts/x.sh --flag",
    "pnpm test",
    'rg "x" a',
    "grep -rn 'a' b",
    "[ -f x ] && echo ok",
    "if [[ -f x ]]; then echo hi; fi",
    "cat > f <<'EOF'\n* bullet {x} $y\nEOF",
    "cat > f <<EOF\n{\"a\": 1}\nEOF\nls",
    "FOO=$(date) pnpm test",
    "cd $HOME/x && ls",
    "export A=1",
    "echo $HOME ${USER}",
    "for i in $(seq 3); do echo $i; done",
    'node "$CLAUDE_PROJECT_DIR/x.mjs"',
    "ls ./*.ts",
    'git -C "$d" status',
    "git -c k=v log",
    "2>&1 echo hi",
    "echo hi >out.txt",
    "ls &>/dev/null",
    "git-status",
    "find . -name '*.ts' -exec grep -l x {} ';'",
    "echo a | xargs echo",
    "unalias g",
    "echo.exe 'git push'",
    "ECHO.EXE 'git push'",
    "jira comment add 'git push failed'",
  ])("ordinary shell is not gated by the class rule: %s", (cmd) => expect(gitSteps(cmd)).toEqual([]));
  test.each([
    'rg "--pre" git x push',
    "rg '--pre=sh' x .",
    'rg "--hostname-bin" "git push" x',
    "rg \"--pre\" 'sh' p f",
    "rg --pr\"e\" sh x .",
    '"rg" --pre sh x .',
    "gh issue create \"--editor\" --title 'git push'",
    "gh pr create '-e' --title 'git push'",
    "git \"-c\" alias.p=push p origin",
    "\"git\" -c alias.p=push p origin",
    "git '--config-env=alias.p=A' p",
    "r\"g\" --pre 'git push' x",
    "\"sh\" -c 'git push'",
  ])("a quoted executing flag or command word is still found: %s", (cmd) => {
    expect(gitSteps(cmd).length).toBeGreaterThan(0);
  });
  test.each([
    ['rg "-n" "git push" src', []],
    ['git -C d commit -m "x git push"', [expect.objectContaining({ step: "commit" })]],
    ['rg -C 2 "git push" src', []],
  ])("a quoted harmless flag does not disable blanking: %s", (cmd, expected) => {
    expect(gitSteps(cmd)).toEqual(expected);
  });
  test.each([
    'rg -n "git push" src',
    "rg --pre-glob '*.pdf' foo docs",
    'rg -i --glob "*.ts" "git commit" .',
    'grep -rn "git push" docs',
  ])("a search for the words is still not a command: %s", (cmd) => expect(gitSteps(cmd)).toEqual([]));
  test.each([
    'node -e "console.log(1)"',
    "python3 -c 'print(2)'",
    "node script.js --eval",
    "bun -e \"console.log(Date.now())\"",
    "perl -e 'print 1'",
    "perl -e 'open(F, \"<x\"); print <F>'",
    "ruby -e 'puts 1'",
    "ruby -e 'puts [1, 2].sum'",
  ])("a plain inline runner stays ungated: %s", (cmd) => expect(gitSteps(cmd)).toEqual([]));
  test.each(["ls | shasum", "echo hi | grep sh", "cat a | wc -l"])("%s is not a shell pipe", (cmd) =>
    expect(gitSteps(cmd)).toEqual([]),
  );
});

describe("decide (hook)", () => {
  const push = (path: string) => ({
    tool_name: "mcp__github__create_or_update_file",
    tool_input: { path },
  });
  test("blocks a money push without tdd and blast-radius, naming both", () => {
    const msg = decide(push("convex/sales.ts"), transcript());
    expect(msg).toContain("tdd");
    expect(msg).toContain("blast-radius");
  });
  test("passes once the skills ran", () => {
    expect(
      decide(push("convex/sales.ts"), transcript("tdd", "blast-radius")),
    ).toBeNull();
  });
  test("a gate-only change needs blast-radius but not tdd", () => {
    expect(decide(push(".github/workflows/x.yml"), transcript())).toContain("blast-radius");
    expect(decide(push(".github/workflows/x.yml"), transcript("blast-radius"))).toBeNull();
  });
  test("unrelated file passes with an empty transcript", () => {
    expect(decide(push("docs/notes.md"), "")).toBeNull();
  });
  test("PR creation on a money branch also needs two-axis-review", () => {
    const need = requiredSkills("pr", classifyPaths(["convex/deposits.ts"])).map((s) => s.skill);
    expect(need).toEqual(
      expect.arrayContaining(["two-axis-review", "engineering-principles", "technical-writing", "unslop"]),
    );
  });
});

const fill = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    "Skills run": "tdd, blast-radius, two-axis-review, engineering-principles, technical-writing, unslop",
    "Seat 1 session": "https://claude.ai/code/session_SEAT1abc",
    "Seat 1 model": "claude-opus-5-5",
    "Seat 1 SHA": "abc1234",
    "Seat 2 model": "gpt-6-sol",
    "Seat 2 effort": "medium",
    "Seat 2 SHA": "abc1234",
    ...over,
  };
  const modeLine = base["Seat 2 mode"] ? `- Seat 2 mode: ${base["Seat 2 mode"]}\n` : "";
  return `intro\nhttps://claude.ai/code/session_IMPL999\n\n## Skill evidence
- Skills run: ${base["Skills run"]}
- Red run:
\`\`\`
FAIL convex/sales.test.ts > refuses X
AssertionError: expected 5 to be 0
\`\`\`
- /simplify output:
\`\`\`
Reviewed abc1234 for reuse, simplification and efficiency: no changes needed
\`\`\`
- Seat 1 session: ${base["Seat 1 session"]}
- Seat 1 model: ${base["Seat 1 model"]}
- Seat 1 SHA: ${base["Seat 1 SHA"]}
- Seat 2 model: ${base["Seat 2 model"]}
${modeLine}- Seat 2 effort: ${base["Seat 2 effort"]}
- Seat 2 SHA: ${base["Seat 2 SHA"]}
`;
};
const money = ["convex/sales.ts", "convex/sales.test.ts"];
const testsOnly = ["convex/sales.test.ts", "docs/notes.md"];

describe("verified local Claude evidence (SCRUM-760)", () => {
  test("local review revocation is an explicit workflow event", () => {
    const directory = path.join(__dirname, "../../.github/workflows");
    const workflows = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))
      .map((name) => parse(readFileSync(path.join(directory, name), "utf8")));
    expect(workflows.some((workflow) => workflow.on?.issue_comment?.types?.includes("edited") &&
      workflow.on.issue_comment.types.includes("deleted"))).toBe(true);
  });
  test("an unrelated comment cannot cancel a pending revocation check", () => {
    const workflow = parse(readFileSync(path.join(__dirname, "../../.github/workflows/skill-evidence-refresh.yml"), "utf8"));
    const group = (commentId: number) => workflow.concurrency.group
      .replaceAll("${{ github.event.issue.number }}", "7")
      .replaceAll("${{ github.event.comment.id }}", String(commentId));
    // Actions cancels before our script can decide whether a comment matters.
    // A revocation followed by an unrelated comment must remain in separate groups.
    expect(group(123)).not.toBe(group(124));
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
  });
  const sha = "a".repeat(40);
  const session = "df7e4a61-cb22-4774-9ed8-3c191d397ed2";
  const implementer = "b79c7aa3-b8f7-4025-8d9f-87ce2e6abef6";
  const reviewUrl = "https://github.com/o/r/pull/7#issuecomment-123";
  const body = () => fill({ "Seat 1 session": `local:${session}`, "Seat 1 SHA": sha }) +
    `- Implementer session: ${implementer}\n- Seat 1 review: ${reviewUrl}\n`;
  const report = () => `Independent review of the complete change: no blocking findings.\n` +
    `Local Claude session: ${session}\nLocal Claude model: claude-opus-5-5\n` +
    `Local Claude effort: high\nLocal Claude SHA: ${sha}\n` +
    `Local Claude verdict: CERTIFY\nSigned: Claude Seat 1\n`;
  const api = (options: { body?: string; report?: string; association?: string; issue?: string; status?: number; head?: string } = {}) =>
    (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/issues/comments/123")) return {
        ok: !options.status, status: options.status ?? 200,
        json: async () => ({ html_url: reviewUrl, issue_url: options.issue ?? "https://api.github.com/repos/o/r/issues/7",
          author_association: options.association ?? "OWNER", body: options.report ?? report() }),
      } as Response;
      const json = u.includes("/files") ? money.map((filename) => ({ filename })) :
        u.includes("/commits") ? [{ sha }, { sha: "b".repeat(40) }, { sha: "abc1234ffff" }] :
          { state: "open", body: options.body ?? body(), head: { sha: options.head ?? sha } };
      return { ok: true, status: 200, json: async () => json } as Response;
    }) as typeof fetch;
  const env = { REPO: "o/r", PR_NUMBER: "7", GH_TOKEN: "test" };

  test.each(["../..", "o/..", "./r"])("refresh refuses repository traversal %s before any I/O", async (repo) => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ state: "closed" }) } as Response));
    await expect(refresh({ ...env, REPO: repo, COMMENT_ID: "123" }, fetchImpl)).rejects.toThrow("Invalid refresh environment");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("accepts a separate local session whose trusted same-PR signed report certifies the head", async () => {
    expect((await check(env, api())).exitCode).toBe(0);
  });
  test.each([
    ["implementer session", () => ({ body: body().replace(`local:${session}`, `local:${implementer}`) })],
    ["missing implementer", () => ({ body: body().replace(`- Implementer session: ${implementer}\n`, "") })],
    ["wrong PR link", () => ({ body: body().replace("/pull/7#", "/pull/8#") })],
    ["redirected comment", () => ({ issue: "https://api.github.com/repos/o/r/issues/8" })],
    ["untrusted author", () => ({ association: "NONE" })],
    ["wrong model", () => ({ report: report().replace("claude-opus-5-5", "claude-sonnet-5-5") })],
    ["wrong session", () => ({ report: report().replace(session, implementer) })],
    ["stale SHA", () => ({ report: report().replace(sha, "b".repeat(40)) })],
    ["older PR commit", () => ({ body: body().replace(`Seat 1 SHA: ${sha}`, `Seat 1 SHA: ${"b".repeat(40)}`), report: report().replace(sha, "b".repeat(40)) })],
    ["BLOCK verdict", () => ({ report: report().replace("CERTIFY", "BLOCK") })],
    ["unsigned report", () => ({ report: report().replace("Signed: Claude Seat 1", "") })],
    ["duplicate verdict", () => ({ report: report() + "Local Claude verdict: BLOCK\n" })],
    ["hidden attestation", () => ({ report: "BLOCK\n<!--\n" + report() + "-->" })],
    ["partial SHA", () => ({ body: body().replace(`Seat 1 SHA: ${sha}`, "Seat 1 SHA: aaaaaaa") })],
  ])("refuses %s", async (_name, options) => {
    expect((await check(env, api(options()))).exitCode).toBe(1);
  });
  test("an unreadable review is unavailable, not accepted", async () => {
    await expect(check(env, api({ status: 403 }))).rejects.toThrow("403");
  });
  test("a consistent self-review fails only the separate-session rule", async () => {
    const result = await check(env, api({ body: body().replace(`local:${session}`, `local:${implementer}`),
      report: report().replace(session, implementer) }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.filter((text) => text.startsWith("- "))).toEqual([
      "- Seat 1 session is the implementing session. Seat 1 must be a separate session.",
    ]);
  });
  test("a consistent older own-PR review fails only the current-head rule", async () => {
    const prior = "b".repeat(40);
    const result = await check(env, api({ body: body().replace(`Seat 1 SHA: ${sha}`, `Seat 1 SHA: ${prior}`),
      report: report().replace(sha, prior) }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.filter((text) => text.startsWith("- "))).toEqual([
      "- Local review must certify the full current PR head SHA.",
    ]);
  });
  test.each(["BLOCK", "deleted"])("revoking a green report to %s publishes a failing check on that PR head", async (revocation) => {
    const options: { report?: string; status?: number } = {};
    const writes: Array<Record<string, unknown>> = [];
    const read = api(options);
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method) {
        const payload = JSON.parse(String(init.body));
        writes.push(payload);
        return { ok: true, json: async () => ({ id: 100 + writes.length }) } as Response;
      }
      return read(url);
    }) as typeof fetch;
    const refreshEnv = { ...env, COMMENT_ID: "123" };
    expect(await refresh(refreshEnv, fetchImpl)).toEqual({ refreshed: true, head: sha, conclusion: "success" });
    if (revocation === "deleted") options.status = 404;
    else options.report = report().replace("CERTIFY", "BLOCK");
    expect(await refresh(refreshEnv, fetchImpl)).toEqual({ refreshed: true, head: sha, conclusion: "failure" });
    expect(writes[0]).toMatchObject({ name: "skill-evidence", head_sha: sha, status: "in_progress" });
    expect(writes[2]).toMatchObject({ name: "skill-evidence", head_sha: sha, status: "in_progress" });
    expect(writes[3]).toMatchObject({ status: "completed", conclusion: "failure" });
  });
  test("an unrelated comment does not replace the head's evidence result", async () => {
    expect(await refresh({ ...env, COMMENT_ID: "124" }, api())).toEqual({ refreshed: false });
  });
  test("a successful check of a newer head cannot approve the earlier head", async () => {
    const newer = "b".repeat(40);
    const readNewer = api({ head: newer, body: body().replace(`Seat 1 SHA: ${sha}`, `Seat 1 SHA: ${newer}`),
      report: report().replace(sha, newer) });
    let prReads = 0;
    const writes: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method) {
        writes.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ id: 100 }) } as Response;
      }
      if (String(url).endsWith("/pulls/7") && ++prReads === 1) return api()(url);
      return readNewer(url);
    }) as typeof fetch;
    expect(await refresh({ ...env, COMMENT_ID: "123" }, fetchImpl))
      .toEqual({ refreshed: true, head: sha, conclusion: "failure" });
    expect(writes[0]).toMatchObject({ head_sha: sha });
    expect(writes[1]).toMatchObject({ conclusion: "failure" });
  });
});

describe("evaluate (PR check)", () => {
  test("not required when no sensitive path is touched", async () => {
    expect(await evaluate({ body: "", files: ["docs/a.md"] })).toEqual({ required: false, ok: true, problems: [] });
  });
  test("missing section fails; the template itself fails (placeholders)", async () => {
    expect((await evaluate({ body: "x", files: money })).ok).toBe(false);
    expect((await evaluate({ body: TEMPLATE, files: money })).ok).toBe(false);
  });
  test("a complete section passes", async () => {
    const r = await evaluate({ body: fill(), files: money, isPrCommit: async () => true });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
  test.each([
    ["Seat 1 is the implementer session", { "Seat 1 session": "https://claude.ai/code/session_IMPL999" }, "separate session"],
    ["Seat 1 not Opus 5.5", { "Seat 1 model": "claude-sonnet-5-5" }, "Opus 5.5"],
    ["Seat 2 high effort", { "Seat 2 effort": "high" }, "low or medium"],
    ["Seat 2 wrong model", { "Seat 2 model": "gpt-5" }, "gpt-6-sol or gpt-6.1-sol"],
    ["skill missing", { "Skills run": "tdd" }, "blast-radius"],
  ])("rejects: %s", async (_n, over, frag) => {
    const r = await evaluate({ body: fill(over), files: money });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain(frag);
  });
  test("evaluate refuses unasserted Seat 2 effort for ordinary CLI models", async () => {
    const r = await evaluate({ body: fill({ "Seat 2 effort": "unasserted" }), files: money });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain(
      '"Seat 2 effort" must be low or medium for CLI execution; unasserted effort is only permitted for authorized primary-chat execution with explicit "Seat 2 mode: chat".',
    );
  });

  test("evaluate refuses unasserted Seat 2 effort in chat mode when review comment is missing", async () => {
    const r = await evaluate({
      body: fill({ "Seat 2 mode": "chat", "Seat 2 effort": "unasserted (chat review)" }),
      files: money,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain(
      "Seat 2 primary-chat execution with unasserted effort requires an independent current-head review comment on this PR.",
    );
  });

  test("evaluate refuses unasserted Seat 2 effort in chat mode when review certificate callback is missing", async () => {
    const body =
      fill({ "Seat 2 mode": "chat", "Seat 2 effort": "unasserted (chat review)" }) +
      "- Seat 2 review: https://github.com/o/r/pull/7#issuecomment-222\n";
    const r = await evaluate({
      body,
      files: money,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain(
      "Seat 2 primary-chat execution with unasserted effort requires an independent current-head review certificate.",
    );
  });
  test("red run that shows no failure is rejected", async () => {
    const body = fill().replace(/FAIL convex[\s\S]*?to be 0/, "all good");
    const r = await evaluate({ body, files: money });
    expect(r.problems.join("\n")).toContain("does not show a failure");
  });
  test("SHA outside the PR history is rejected", async () => {
    const r = await evaluate({ body: fill(), files: money, isPrCommit: async () => false });
    expect(r.problems.join("\n")).toContain("PR head or a commit");
  });
  test("real output with generics or the word pending is not a placeholder", async () => {
    const body = fill().replace(/Reviewed abc1234[^\n]*/, "Reuse check: Promise<void> stays as is; 2 tests pending, nothing to simplify");
    const r = await evaluate({ body, files: money, isPrCommit: async () => true });
    expect(r.problems).toEqual([]);
  });
  test.each(["<real output>", "TODO", "pending", "n/a", ""])("placeholder /simplify block %j is rejected", async (blk) => {
    const body = fill().replace(/Reviewed abc1234[^\n]*/, blk);
    const r = await evaluate({ body, files: money });
    expect(r.problems.join("\n")).toContain("/simplify output");
  });
  test.each([
    ["zero failures", "Tests  0 failed | 12 passed"],
    ["prose with no failure sign", "no error seen, all expected"],
  ])("red run with %s is rejected", async (_n, out) => {
    const body = fill().replace(/FAIL convex[\s\S]*?to be 0/g, out);
    expect((await evaluate({ body, files: money })).problems.join("\n")).toContain("does not show a failure");
  });
  test("a failure count or AssertionError is accepted", async () => {
    const body = fill().replace(/FAIL convex[\s\S]*?to be 0/g, "convex/sales.test.ts  Tests  1 failed | 11 passed");
    expect((await evaluate({ body, files: money, isPrCommit: async () => true })).ok).toBe(true);
  });
  test("a fence under another label is not the red run's", async () => {
    const body = fill().replace(/- Red run:\n```\n[\s\S]*?\n```\n/, "- Red run: none\n");
    const r = await evaluate({ body, files: money });
    expect(r.problems.join("\n")).toContain("Red run");
  });
  test.each([
    ["Seat 1 model", "not-opus-5.5"],
    ["Seat 1 model", "opus-5.5-mini"],
    ["Seat 2 effort", "medium-high"],
    ["Seat 2 model", "gpt-6-sol-pro"],
    ["Seat 2 model", "gpt-6.1-sol-pro"],
    ["Seat 2 model", "gpt-6.2-sol"],
    ["Seat 2 model", "gpt-6.10-sol"],
    ["Seat 2 model", "gpt-6.1sol"],
    ["Seat 2 model", "gpt-61-sol"],
    ["Seat 2 model", "gpt-6x1-sol"],
  ])("%s %j is rejected", async (label, value) => {
    expect((await evaluate({ body: fill({ [label]: value }), files: money })).ok).toBe(false);
  });
  test("model with a parenthesised note is accepted", async () => {
    const r = await evaluate({
      body: fill({ "Seat 1 model": "Opus 5.5 (claude-opus-5-5)", "Seat 2 model": "gpt-6-sol (Codex)" }),
      files: money,
      isPrCommit: async () => true,
    });
    expect(r.problems).toEqual([]);
  });
  test.each(["gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-sol (Codex)"])("Seat 2 model %j is accepted", async (model) => {
    const r = await evaluate({ body: fill({ "Seat 2 model": model }), files: money, isPrCommit: async () => true });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
  test("Seat 1 link equal to the implementer's link in a footer or a commit message is rejected", async () => {
    const same = "https://claude.ai/code/session_IMPL999";
    const inFooter = fill({ "Seat 1 session": same });
    expect((await evaluate({ body: inFooter, files: money })).problems.join("\n")).toContain("separate session");
    const viaCommit = await evaluate({
      body: fill().replace("intro\nhttps://claude.ai/code/session_IMPL999\n", "intro\n"),
      files: money,
      isPrCommit: async () => true,
      commitText: "fix\n\nClaude-Session: https://claude.ai/code/session_SEAT1abc",
    });
    expect(viaCommit.problems.join("\n")).toContain("separate session");
  });
  describe("no behaviour change form", () => {
    const noChange = (over: Record<string, string> = {}) =>
      fill({ "Seat 1 SHA": "abc1234 no behaviour change", "Seat 2 SHA": "abc1234 no behaviour change", ...over }).replace(
        /- Red run:\n```\n[\s\S]*?\n```\n/,
        "- Red run: No behaviour change: comment and rename only, nothing observable differs\n",
      );
    test("is accepted when both seats confirm it and only test files and docs changed", async () => {
      const r = await evaluate({ body: noChange(), files: testsOnly, isPrCommit: async () => true });
      expect(r.problems).toEqual([]);
    });
    test("is refused for any changed money or permission source file, even with both seat lines", async () => {
      const r = await evaluate({ body: noChange(), files: ["convex/sales.ts", "convex/sales.test.ts"], isPrCommit: async () => true });
      expect(r.ok).toBe(false);
      expect(r.problems.join("\n")).toContain("Red run");
    });
    test.each([
      ["Seat 1 does not confirm", { "Seat 1 SHA": "abc1234" }],
      ["Seat 2 does not confirm", { "Seat 2 SHA": "abc1234" }],
    ])("is refused when %s", async (_n, over) => {
      const r = await evaluate({ body: noChange(over), files: testsOnly, isPrCommit: async () => true });
      expect(r.problems.join("\n")).toContain("Red run");
    });
    test("is refused without a reason", async () => {
      const body = noChange().replace(/No behaviour change: .*/, "No behaviour change");
      expect((await evaluate({ body, files: testsOnly, isPrCommit: async () => true })).problems.join("\n")).toContain("Red run");
    });
    test("a plain red-run line without the phrase still needs a fence", async () => {
      const body = noChange().replace("No behaviour change: comment", "Skipped: comment");
      expect((await evaluate({ body, files: testsOnly, isPrCommit: async () => true })).problems.join("\n")).toContain("Red run");
    });
  });
  describe("red run substance", () => {
    test("must name a test file that is in the PR diff", async () => {
      const body = fill().replace("convex/sales.test.ts", "convex/other.test.ts");
      const r = await evaluate({ body, files: money });
      expect(r.problems.join("\n")).toContain("test file in this PR");
    });
    test("naming no test file is rejected even with a failure", async () => {
      const body = fill().replace("FAIL convex/sales.test.ts > refuses X", "FAIL > refuses X");
      expect((await evaluate({ body, files: money })).problems.join("\n")).toContain("test file in this PR");
    });
    test("a basename of a changed test file is accepted", async () => {
      const body = fill().replace("convex/sales.test.ts", "sales.test.ts");
      expect((await evaluate({ body, files: money, isPrCommit: async () => true })).problems).toEqual([]);
    });
  });
  describe("/simplify minimum structure", () => {
    test.each([
      ["too short", "ok done"],
      ["long but names no review axis", "x".repeat(60)],
    ])("%s is rejected", async (_n, text) => {
      const body = fill().replace(/Reviewed abc1234[^\n]*/, text);
      expect((await evaluate({ body, files: money })).problems.join("\n")).toContain("/simplify output");
    });
    test("a real summary naming an axis is accepted", async () => {
      const body = fill().replace(/Reviewed abc1234[^\n]*/, "Seat 1 review at abc1234: no findings in reuse or altitude");
      expect((await evaluate({ body, files: money, isPrCommit: async () => true })).problems).toEqual([]);
    });
  });
  test("gate-only change needs no red run", async () => {
    const r = await evaluate({ body: fill().replace(/- Red run:\n```\n[\s\S]*?\n```\n/, ""), files: [".github/x.yml"] });
    expect(r.problems.join("\n")).not.toContain("Red run");
  });
});

describe("isPlaceholder", () => {
  test.each(["", "TODO", "tbd.", "n/a", "<real output>", "  pending  "])("%j is a placeholder", (b) =>
    expect(isPlaceholder(b)).toBe(true),
  );
  test.each(["Promise<void> ok", "2 tests pending", "<a>\n<b>", "no changes needed"])("%j is real", (b) =>
    expect(isPlaceholder(b)).toBe(false),
  );
});

describe("classifyPaths edge cases", () => {
  test("test files and docs are sensitive for the hook but carry no source behaviour", () => {
    const c = classifyPaths(["convex/sales.test.ts", "convex/utils/x.spec.ts", "convex/sales.ts", "convex/data.sql", "docs/a.md"]);
    expect(c.sensitive).toEqual(["convex/sales.test.ts", "convex/utils/x.spec.ts", "convex/sales.ts", "convex/data.sql"]);
    expect(c.behaviour).toEqual(["convex/sales.ts", "convex/data.sql"]);
  });
  test("convex default deny covers any extension except known non-source", () => {
    const c = classifyPaths(["convex/x.tsx", "convex/x.sql", "convex/Makefile", "convex/notes.md", "convex/logo.png"]);
    expect(c.sensitive).toEqual(["convex/x.tsx", "convex/x.sql", "convex/Makefile"]);
  });
  test("gate scripts and plain code", () => {
    const c = classifyPaths(["scripts/assertReleaseChecks.mjs", "lib/format.tsx", "./convex/sales.ts"]);
    expect(c.gate).toEqual(["scripts/assertReleaseChecks.mjs"]);
    expect(c.sensitive).toEqual(["convex/sales.ts"]);
    expect(c.code).toContain("lib/format.tsx");
  });
});

describe("gitExecutable", () => {
  test("falls back to a fixed list, then to null", () => {
    const boom = () => {
      throw new Error("none");
    };
    expect(gitExecutable((p) => p === "/opt/homebrew/bin/git", boom)).toBe("/opt/homebrew/bin/git");
    expect(gitExecutable(() => false, boom)).toBeNull();
    expect(gitExecutable(() => false, () => "/usr/bin/git")).toBe("/usr/bin/git");
  });
});

describe("hook against a real git repository", () => {
  const exe = gitExecutable();
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync(exe!, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const made: string[] = [];
  // Every test gets its own repository, so no test depends on another's staged files or run order.
  const makeRepo = (tracked: Record<string, string> = {}) => {
    const dir = mkdtempSync(path.join(tmpdir(), "gate-"));
    made.push(dir);
    sh(dir, "init", "-q", "-b", "main");
    mkdirSync(path.join(dir, "convex"));
    writeFileSync(path.join(dir, "README.md"), "x");
    for (const [f, c] of Object.entries(tracked)) writeFileSync(path.join(dir, f), c);
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "base");
    return dir;
  };
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const bash = (dir: string, command: string) => ({ tool_name: "Bash", tool_input: { command }, cwd: dir });
  const stage = (dir: string, f: string) => {
    writeFileSync(path.join(dir, f), "export {};");
    sh(dir, "add", f);
  };

  test("a staged money file blocks commit without skills and passes with them", () => {
    const dir = makeRepo();
    stage(dir, "convex/sales.ts");
    const denied = run(JSON.stringify(bash(dir, "git commit -m x")), () => "", exe!);
    expect(JSON.parse(denied).hookSpecificOutput.permissionDecision).toBe("deny");
    const t = transcript("tdd", "blast-radius");
    expect(run(JSON.stringify(bash(dir, "git commit -m x")), () => t, exe!)).toBe("");
  });
  test("a non-git command is ignored and an unreadable transcript still gates", () => {
    const dir = makeRepo();
    stage(dir, "convex/sales.ts");
    expect(run(JSON.stringify(bash(dir, "ls")), () => { throw new Error("x"); }, exe!)).toBe("");
    const out = run(JSON.stringify(bash(dir, "git commit -am x")), () => { throw new Error("x"); }, exe!);
    expect(out).toContain("tdd");
  });
  test("push uses the branch diff plus what the same command commits", () => {
    const dir = makeRepo();
    stage(dir, "convex/sales.ts");
    const steps = stepsFor(bash(dir, "git commit -m y && git push"), exe!);
    expect(steps.map((s: { step: string }) => s.step)).toEqual(["commit", "push"]);
    expect(steps[1].files).toContain("convex/sales.ts");
  });
  test("-C targets the other repository's staged files, not the cwd's", () => {
    const dir = makeRepo();
    const other = makeRepo();
    stage(other, "convex/claims.ts");
    expect(stepsFor(bash(dir, `git -C ${other} commit -m x`), exe!)[0].files).toEqual(["convex/claims.ts"]);
    expect(stepsFor(bash(dir, "git --git-dir=/nope commit -m x"), exe!)[0].files).toBeNull();
    expect(stepsFor(bash(dir, "git -C /does/not/exist commit -m x"), exe!)[0].files).toBeNull();
  });
  test("cd into another repository is followed; GIT_DIR makes the files unknown", () => {
    const dir = makeRepo();
    const other = makeRepo();
    stage(other, "convex/claims.ts");
    expect(stepsFor(bash(dir, `cd ${other} && git commit -m x`), exe!)[0].files).toEqual(["convex/claims.ts"]);
    expect(stepsFor(bash(dir, `GIT_DIR=${other}/.git git commit -m x`), exe!)[0].files).toBeNull();
  });
  test("commit pathspecs count even when nothing is staged", () => {
    const dir = makeRepo({ "convex/sales.ts": "export const a = 1;" });
    writeFileSync(path.join(dir, "convex/sales.ts"), "export const a = 2;");
    for (const cmd of [
      "git commit -m x convex/sales.ts",
      "git commit --only convex/sales.ts -m x",
      "git commit -m x -- convex/sales.ts",
    ]) {
      expect(stepsFor(bash(dir, cmd), exe!)[0].files).toContain("convex/sales.ts");
      expect(decide(bash(dir, cmd), "", exe!)).toContain("tdd");
    }
  });
  test("a directory or glob pathspec expands to the tracked files it names", () => {
    const dir = makeRepo({ "convex/sales.ts": "export const a = 1;" });
    for (const cmd of ["git commit -m x convex/", "git commit -m x 'convex/*.ts'", "git commit -m x ."]) {
      expect(stepsFor(bash(dir, cmd), exe!)[0].files).toContain("convex/sales.ts");
    }
  });
  test("a pathspec outside the repository, or interactive options, make the files unknown, so it is gated as money", () => {
    const dir = makeRepo();
    for (const cmd of ["git commit -m x ../elsewhere.ts", "git commit -p"]) {
      expect(stepsFor(bash(dir, cmd), exe!)[0].files).toBeNull();
    }
  });
  test("-a after a quoted message includes unstaged tracked changes", () => {
    const dir = makeRepo({ "convex/sales.ts": "export const a = 1;" });
    writeFileSync(path.join(dir, "convex/sales.ts"), "export const a = 2;");
    expect(stepsFor(bash(dir, 'git commit --message="x" -a'), exe!)[0].files).toContain("convex/sales.ts");
  });
  test("a commit followed by a push in one command carries the commit's pathspecs into the push", () => {
    const dir = makeRepo({ "convex/sales.ts": "export const a = 1;" });
    writeFileSync(path.join(dir, "convex/sales.ts"), "export const a = 2;");
    const steps = stepsFor(bash(dir, "git commit -m x convex/sales.ts && git push"), exe!);
    expect(steps[1].files).toContain("convex/sales.ts");
    const unknownCommit = stepsFor(bash(dir, "git commit -p && git push"), exe!);
    expect(unknownCommit[1].files).toBeNull();
  });
  test("a pipe into a shell is gated whatever produces it", () => {
    const dir = makeRepo();
    for (const cmd of ['echo "git push" | bash', "printf '%s' 'git push' | bash", "x=git; $x push"]) {
      expect(decide(bash(dir, cmd), "", exe!)).toContain("tdd");
    }
  });
  test("echo of a git command is not gated", () => {
    const dir = makeRepo();
    expect(run(JSON.stringify(bash(dir, "echo git commit")), () => "", exe!)).toBe("");
  });
  test("no git executable makes the change unknown and therefore gated", () => {
    expect(decide(bash(".", "git push"), "", null as unknown as string)).toContain("tdd");
  });
  test("PR creation tool reads the branch files", () => {
    const dir = makeRepo();
    const steps = stepsFor({ tool_name: "mcp__github__create_pull_request", tool_input: {}, cwd: dir }, exe!);
    expect(steps[0].step).toBe("pr");
  });
  test("push_files and delete tools read their own paths", () => {
    expect(stepsFor({ tool_name: "mcp__github__push_files", tool_input: { files: [{ path: "a.ts" }, {}] } }, exe!)[0].files).toEqual(["a.ts"]);
    expect(stepsFor({ tool_name: "mcp__github__delete_file", tool_input: { path: "b.ts" } }, exe!)[0].files).toEqual(["b.ts"]);
    expect(stepsFor({ tool_name: "Read", tool_input: {} }, exe!)).toEqual([]);
  });
});

describe("check (CI entry)", () => {
  const env = { REPO: "o/r", PR_NUMBER: "7", GH_TOKEN: "t" };
  const api = (body: string, files: string[], commits: string[]) => async (url: string) => {
    const u = String(url);
    const json = u.includes("/files")
      ? files.map((filename) => ({ filename }))
      : u.includes("/commits")
        ? commits.map((sha) => ({ sha }))
        : { body, head: { sha: "abc1234567890" } };
    return { ok: true, status: 200, json: async () => json } as Response;
  };
  test("rejects bad environment", async () => {
    await expect(check({ REPO: "x", PR_NUMBER: "1", GH_TOKEN: "t" })).rejects.toThrow("required");
  });
  test("not required for a docs-only PR", async () => {
    const r = await check(env, api("", ["docs/a.md"], []) as typeof fetch);
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain("not required");
  });
  test("fails with the template when evidence is missing", async () => {
    const r = await check(env, api("nothing", ["convex/sales.ts"], []) as typeof fetch);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("## Skill evidence");
  });
  test("passes with a filled section whose SHAs belong to the PR", async () => {
    const r = await check(env, api(fill(), money, ["abc1234ffff"]) as typeof fetch);
    expect(r.lines[0]).toBe("skill-evidence: section present and consistent.");
  });
  test("success and failure output say plainly that only form is verified", async () => {
    const ok = await check(env, api(fill(), ["convex/sales.ts", "convex/sales.test.ts"], ["abc1234ffff"]) as typeof fetch);
    expect(ok.lines.join("\n")).toMatch(/verifies form only/);
    expect(ok.lines.join("\n")).toMatch(/signed PR comments/);
    const bad = await check(env, api("nothing", ["convex/sales.ts"], []) as typeof fetch);
    expect(bad.lines.join("\n")).toMatch(/verifies form only/);
  });
  test("exactly 3000 files is read in full; one more is an error", async () => {
    const paged = (total: number) => (async (url: string) => {
      const u = String(url);
      const page = Number(new URL(u).searchParams.get("page") ?? 1);
      const rows = Math.max(0, Math.min(100, total - (page - 1) * 100));
      const json = u.includes("/files") ? Array.from({ length: rows }, (_, i) => ({ filename: `d${page}-${i}.md` })) : u.includes("/commits") ? [] : { body: "", head: { sha: "abc1234" } };
      return { ok: true, status: 200, json: async () => json };
    }) as unknown as typeof fetch;
    expect((await check(env, paged(3000))).exitCode).toBe(0);
    await expect(check(env, paged(3001))).rejects.toThrow("3000");
  });
  test("a PR with more than 3000 files is an error, not a silent pass", async () => {
    const big = (async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("/files") ? Array.from({ length: 100 }, (_, i) => ({ filename: `a${i}.md` })) : { body: "", head: { sha: "abc1234" } }),
    })) as unknown as typeof fetch;
    await expect(check(env, big)).rejects.toThrow("3000");
  });
  test("surfaces an API error", async () => {
    const bad = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(check(env, bad)).rejects.toThrow("403");
  });
});

describe("owner-proxy waiver registry and negative controls (SCRUM-760)", () => {
  const sha = "a".repeat(40);
  const defaultImplementerSession = "b79c7aa3-b8f7-4025-8d9f-87ce2e6abef6";
  const codexReviewUrl = "https://github.com/o/r/pull/7#issuecomment-222";
  const waiverUrl = "https://github.com/o/r/pull/7#issuecomment-111";

  const validExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const codexComment = (over: Record<string, string> = {}) =>
    `[Codex Review]\n` +
    `Reviewer: ${over.reviewer ?? "Codex Seat 2"}\n` +
    (over.mode !== undefined ? (over.mode ? `Mode: ${over.mode}\n` : "") : "Mode: chat\n") +
    `Session: ${over.session ?? "01a18fe9-b92b-7ae0-aa13-faea3189ac57"}\n` +
    `Head SHA: ${over.sha ?? sha}\n` +
    `Verdict: ${over.verdict ?? "CERTIFY"}\n` +
    `Signed: ${over.signed ?? "Codex Seat 2"}\n`;

  const waiverComment = (over: Record<string, string> = {}) =>
    `Owner waiver: Seat 1\n` +
    `Ruling: ${over.ruling ?? "SCRUM-760 c24127"}\n` +
    `Head SHA: ${over.sha ?? sha}\n` +
    `Expires: ${over.expires ?? validExpiry}\n` +
    `Verdict: ${over.verdict ?? "WAIVED"}\n` +
    `Proxy: ${over.proxy ?? "owner-proxy"}\n` +
    `Reason: Owner ruling 2026-10-31 temporarily waives Opus seat; independent Codex review is sufficient.\n`;

  test.each([
    ["repeating hex characters", "https://claude.ai/code/session_1111111111111111", true],
    ["repeating local zeros", "local:00000000-0000-0000-0000-000000000000", true],
    ["repeating local ones", "local:11111111-1111-1111-1111-111111111111", true],
    ["mock prefix", "https://claude.ai/code/session_mock12345678", true],
    ["dummy prefix", "local:dummy000-0000-0000-0000-000000000000", true],
    ["valid session URL", "https://claude.ai/code/session_01928374abcdef", false],
    ["valid local UUID", "local:df7e4a61-cb22-4774-9ed8-3c191d397ed2", false],
  ])("isPlaceholderSession classifies %s as placeholder: %s", (_label, session, expected) => {
    expect(isPlaceholderSession(session)).toBe(expected);
  });

  test.each(["mock", "dummy", "fake"])("isPlaceholder recognizes %s", (word) => {
    expect(isPlaceholder(word)).toBe(true);
  });

  test("evaluate rejects placeholder session pattern session_1111111111111111", async () => {
    const r = await evaluate({
      body: fill({ "Seat 1 session": "https://claude.ai/code/session_1111111111111111" }),
      files: money,
      isPrCommit: async () => true,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain('"Seat 1 session" is an unverified placeholder session pattern.');
  });

  test("evaluate accepts waived Seat 1 with valid waiver comment and independent Codex certification", async () => {
    const body = fill({
      "Seat 1 model": "WAIVED",
    }) + `- Implementer session: ${defaultImplementerSession}\n- Seat 1 waiver ruling: SCRUM-760 c24127\n- Seat 1 waiver: ${waiverUrl}\n- Seat 2 review: ${codexReviewUrl}\n`;

    const r = await evaluate({
      body,
      files: money,
      isPrCommit: async () => true,
      headSha: sha,
      ownerWaiver: async () => [],
      codexReview: async () => [],
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.waivedSeats).toEqual(new Set(["Seat 1"]));
  });

  test("evaluate fails when Seat 1 is waived but Seat 1 waiver ruling is missing", async () => {
    const body = fill({
      "Seat 1 model": "WAIVED",
    }) + `- Seat 1 waiver: ${waiverUrl}\n- Seat 2 review: ${codexReviewUrl}\n`;

    const r = await evaluate({
      body,
      files: money,
      isPrCommit: async () => true,
      headSha: sha,
      ownerWaiver: async () => [],
      codexReview: async () => [],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain('Waived Seat 1 requires an explicit "Seat 1 waiver ruling"');
  });

  test("evaluate fails when Seat 1 is waived but Implementer session is missing or unparseable", async () => {
    const body = fill({
      "Seat 1 model": "WAIVED",
    }) + `- Seat 1 waiver ruling: SCRUM-760 c24127\n- Seat 1 waiver: ${waiverUrl}\n- Seat 2 review: ${codexReviewUrl}\n`;

    const r = await evaluate({
      body,
      files: money,
      isPrCommit: async () => true,
      headSha: sha,
      ownerWaiver: async () => [],
      codexReview: async () => [],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain('Waived Seat 1 requires a declared "Implementer session" UUID');
  });

  test("evaluate fails when Seat 1 is waived but Seat 2 review is missing", async () => {
    const body = fill({
      "Seat 1 model": "WAIVED",
    }) + `- Seat 1 waiver ruling: SCRUM-760 c24127\n- Seat 1 waiver: ${waiverUrl}\n`;

    const r = await evaluate({
      body,
      files: money,
      isPrCommit: async () => true,
      headSha: sha,
      ownerWaiver: async () => [],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain('When Seat 1 is waived, "Seat 2 review" must link to an independent Codex review comment on this PR.');
  });

  test("evaluate accepts waived Seat 1 from skill-waivers.json registry", async () => {
    const body = fill({
      "Seat 1 model": "WAIVED",
    }) + `- Implementer session: ${defaultImplementerSession}\n- Seat 1 waiver ruling: SCRUM-760 c24127\n- Seat 2 review: ${codexReviewUrl}\n`;

    const waivers = [{
      pr: 7,
      head: sha,
      seat: "Seat 1",
      ruling: "SCRUM-760 c24127",
      expires: validExpiry,
      authority: "owner-proxy",
      reason: "Owner ruling 2026-10-31",
    }];

    const r = await evaluate({
      body,
      files: money,
      isPrCommit: async () => true,
      prNumber: 7,
      headSha: sha,
      waivers,
      codexReview: async () => [],
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.waivedSeats).toEqual(new Set(["Seat 1"]));
  });

  test("evaluate fails closed when registry waiver is expired", async () => {
    const body = fill({
      "Seat 1 model": "WAIVED",
    }) + `- Implementer session: ${defaultImplementerSession}\n- Seat 1 waiver ruling: SCRUM-760 c24127\n- Seat 2 review: ${codexReviewUrl}\n`;

    const waivers = [{
      pr: 7,
      head: sha,
      seat: "Seat 1",
      ruling: "SCRUM-760 c24127",
      expires: "2020-01-01T00:00:00Z",
      authority: "owner-proxy",
      reason: "Old ruling",
    }];

    const r = await evaluate({
      body,
      files: money,
      isPrCommit: async () => true,
      prNumber: 7,
      headSha: sha,
      waivers,
      codexReview: async () => [],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("Seat 1 waiver for PR 7 expired on 2020-01-01T00:00:00Z.");
  });

  test("loadSkillWaivers parses valid JSON and throws on malformed schema", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "waivers-"));
    const filePath = path.join(tmp, "skill-waivers.json");
    try {
      writeFileSync(filePath, JSON.stringify({
        waivers: [{
          pr: 123,
          head: sha,
          seat: "Seat 1",
          ruling: "SCRUM-760 c24127",
          expires: validExpiry,
        }],
      }));
      expect(loadSkillWaivers(filePath)).toHaveLength(1);

      writeFileSync(filePath, JSON.stringify({ notWaivers: [] }));
      expect(() => loadSkillWaivers(filePath)).toThrow(TypeError);

      writeFileSync(filePath, JSON.stringify({ waivers: [{ pr: "not-a-number" }] }));
      expect(() => loadSkillWaivers(filePath)).toThrow(TypeError);

      writeFileSync(filePath, JSON.stringify({
        waivers: [{ pr: 7, head: sha, seat: "Seat 1", ruling: "r1", expires: "not-a-date" }],
      }));
      expect(() => loadSkillWaivers(filePath)).toThrow(TypeError);

      writeFileSync(filePath, JSON.stringify({
        waivers: [{ pr: 7, head: "not-40-chars", seat: "Seat 1", ruling: "r1", expires: validExpiry }],
      }));
      expect(() => loadSkillWaivers(filePath)).toThrow(TypeError);

      writeFileSync(filePath, JSON.stringify({
        waivers: [{ pr: -5, head: sha, seat: "Seat 1", ruling: "r1", expires: validExpiry }],
      }));
      expect(() => loadSkillWaivers(filePath)).toThrow(TypeError);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("evaluate fails closed when registry waiver has mismatched ruling or invalid expiry", async () => {
    const body = fill({
      "Seat 1 model": "WAIVED",
    }) + `- Implementer session: ${defaultImplementerSession}\n- Seat 1 waiver ruling: SCRUM-760 c24127\n- Seat 2 review: ${codexReviewUrl}\n`;

    const r1 = await evaluate({
      body,
      files: money,
      isPrCommit: async () => true,
      prNumber: 7,
      headSha: sha,
      waivers: [{
        pr: 7,
        head: sha,
        seat: "Seat 1",
        ruling: "unrelated ruling",
        expires: validExpiry,
      }],
      codexReview: async () => [],
    });
    expect(r1.ok).toBe(false);
    expect(r1.problems.join("\n")).toContain('Seat 1 waiver in skill-waivers.json specifies ruling "unrelated ruling", which does not match declared ruling "SCRUM-760 c24127".');

    const r2 = await evaluate({
      body,
      files: money,
      isPrCommit: async () => true,
      prNumber: 7,
      headSha: sha,
      waivers: [{
        pr: 7,
        head: sha,
        seat: "Seat 1",
        ruling: "SCRUM-760 c24127",
        expires: "not-a-date",
      }],
      codexReview: async () => [],
    });
    expect(r2.ok).toBe(false);
    expect(r2.problems.join("\n")).toContain("Seat 1 waiver for PR 7 expired on not-a-date.");
  });

  test("verifyOwnerWaiver checks author, expiration, ruling, and verdict", async () => {
    const context = { repo: "o/r", pr: "7", head: sha, token: "test" };
    const makeFetch = (commentData: Record<string, unknown>) => (async () => ({
      ok: true, status: 200, json: async () => commentData,
    })) as unknown as typeof fetch;

    const baseComment = {
      html_url: waiverUrl,
      issue_url: "https://api.github.com/repos/o/r/issues/7",
      author_association: "OWNER",
      body: waiverComment(),
    };

    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch(baseComment) })).toEqual([]);

    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, author_association: "NONE" }) }))
      .toEqual(["Seat 1 waiver must be published by the repository owner (author association OWNER)."]);

    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, author_association: "COLLABORATOR" }) }))
      .toEqual(["Seat 1 waiver must be published by the repository owner (author association OWNER)."]);

    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: waiverComment({ proxy: "none" }) }) }))
      .toEqual(["Seat 1 waiver comment must declare Proxy: owner-proxy."]);

    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: waiverComment({ verdict: "REJECT" }) }) }))
      .toEqual(["Seat 1 waiver verdict must be WAIVED."]);

    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: waiverComment({ expires: "2020-01-01T00:00:00Z" }) }) }))
      .toEqual(["Seat 1 waiver expired on 2020-01-01T00:00:00Z."]);

    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: waiverComment({ expires: "9999" }) }) }))
      .toEqual(["Seat 1 waiver has an invalid expiration date (must be canonical ISO-8601 UTC date or datetime)."]);

    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: waiverComment({ expires: "9999-01-01T00:00:00Z" }) }) }))
      .toEqual(["Seat 1 waiver expiration date 9999-01-01T00:00:00Z exceeds maximum policy horizon of 90 days."]);

    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "invented authority", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: waiverComment({ ruling: "invented authority" }) }) }))
      .toEqual(['Seat 1 waiver ruling "invented authority" is not an authorized ruling from the trusted base.']);

    const wrongSha = "b".repeat(40);
    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: waiverComment({ sha: wrongSha }) }) }))
      .toEqual([`Seat 1 waiver comment certifies ${wrongSha}, which does not match PR head ${sha}.`]);

    const commentMissingRuling = "Owner waiver: Seat 1\nHead SHA: " + sha + "\nExpires: " + validExpiry + "\nVerdict: WAIVED\nProxy: owner-proxy\n";
    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: commentMissingRuling }) }))
      .toEqual(["Seat 1 waiver comment must declare an authorized Ruling."]);

    const commentMissingSha = "Owner waiver: Seat 1\nRuling: SCRUM-760 c24127\nExpires: " + validExpiry + "\nVerdict: WAIVED\nProxy: owner-proxy\n";
    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: commentMissingSha }) }))
      .toEqual(["Seat 1 waiver comment must declare the full 40-character Head SHA."]);

    const commentPrefixSha = "Owner waiver: Seat 1\nRuling: SCRUM-760 c24127\nHead SHA: " + sha.slice(0, 7) + "\nExpires: " + validExpiry + "\nVerdict: WAIVED\nProxy: owner-proxy\n";
    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: commentPrefixSha }) }))
      .toEqual(["Seat 1 waiver comment must declare the full 40-character Head SHA."]);

    const commentSubstringRuling = "Owner waiver: Seat 1\nRuling: c24127\nHead SHA: " + sha + "\nExpires: " + validExpiry + "\nVerdict: WAIVED\nProxy: owner-proxy\n";
    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: commentSubstringRuling }) }))
      .toEqual(['Seat 1 waiver ruling "c24127" is not an authorized ruling from the trusted base.']);

    const commentInvalidExpires = "Owner waiver: Seat 1\nRuling: SCRUM-760 c24127\nHead SHA: " + sha + "\nExpires: not-a-date\nVerdict: WAIVED\nProxy: owner-proxy\n";
    expect(await verifyOwnerWaiver({ url: waiverUrl, ruling: "SCRUM-760 c24127", seat: "Seat 1", sha }, { ...context, fetchImpl: makeFetch({ ...baseComment, body: commentInvalidExpires }) }))
      .toEqual(["Seat 1 waiver has an invalid expiration date (must be canonical ISO-8601 UTC date or datetime)."]);
  });

  test("verifyCodexReview accepts CERTIFY and rejects review-evidence corrections and negated phrases", async () => {
    const context = { repo: "o/r", pr: "7", head: sha, token: "test" };
    const makeFetch = (commentData: Record<string, unknown>) => (async () => ({
      ok: true, status: 200, json: async () => commentData,
    })) as unknown as typeof fetch;

    const validComment = {
      html_url: codexReviewUrl,
      issue_url: "https://api.github.com/repos/o/r/issues/7",
      author_association: "OWNER",
      body: codexComment(),
    };

    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(validComment) })).toEqual([]);

    expect(await verifyCodexReview({ url: codexReviewUrl, sha }, { ...context, fetchImpl: makeFetch(validComment) }))
      .toEqual(["Seat 2 review independence cannot be verified: mandatory valid implementer session is absent or unparseable."]);

    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: "not-a-session" }, { ...context, fetchImpl: makeFetch(validComment) }))
      .toEqual(["Seat 2 review independence cannot be verified: mandatory valid implementer session is absent or unparseable."]);

    const shortSessionComment = {
      ...validComment,
      body: codexComment({ session: "abc" }),
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(shortSessionComment) }))
      .toEqual(["Seat 2 review comment must declare an actual reviewer Session."]);

    const inconsistentModeComment = {
      ...validComment,
      body: codexComment({ mode: "cli" }),
    };
    expect(
      await verifyCodexReview(
        { url: codexReviewUrl, sha, implementerSession: defaultImplementerSession, mode: "chat" },
        { ...context, fetchImpl: makeFetch(inconsistentModeComment) },
      ),
    ).toEqual(['Seat 2 review comment must certify primary-chat execution (e.g. "Mode: chat").']);

    const cliNotChatComment = {
      ...validComment,
      body: codexComment({ mode: "CLI-not-chat" }),
    };
    expect(
      await verifyCodexReview(
        { url: codexReviewUrl, sha, implementerSession: defaultImplementerSession, mode: "chat" },
        { ...context, fetchImpl: makeFetch(cliNotChatComment) },
      ),
    ).toEqual(['Seat 2 review comment must certify primary-chat execution (e.g. "Mode: chat").']);

    const negatedModeComment = {
      ...validComment,
      body: codexComment({ mode: "not-chat" }),
    };
    expect(
      await verifyCodexReview(
        { url: codexReviewUrl, sha, implementerSession: defaultImplementerSession, mode: "chat" },
        { ...context, fetchImpl: makeFetch(negatedModeComment) },
      ),
    ).toEqual(['Seat 2 review comment must certify primary-chat execution (e.g. "Mode: chat").']);

    const missingModeComment = {
      ...validComment,
      body: codexComment({ mode: "" }),
    };
    expect(
      await verifyCodexReview(
        { url: codexReviewUrl, sha, implementerSession: defaultImplementerSession, mode: "chat" },
        { ...context, fetchImpl: makeFetch(missingModeComment) },
      ),
    ).toEqual(['Seat 2 review comment must certify primary-chat execution (e.g. "Mode: chat").']);

    const validChatModeComment = {
      ...validComment,
      body: codexComment({ mode: "chat" }),
    };
    expect(
      await verifyCodexReview(
        { url: codexReviewUrl, sha, implementerSession: defaultImplementerSession, mode: "chat" },
        { ...context, fetchImpl: makeFetch(validChatModeComment) },
      ),
    ).toEqual([]);

    const validPrimaryChatComment = {
      ...validComment,
      body: codexComment({ mode: "primary-chat" }),
    };
    expect(
      await verifyCodexReview(
        { url: codexReviewUrl, sha, implementerSession: defaultImplementerSession, mode: "chat" },
        { ...context, fetchImpl: makeFetch(validPrimaryChatComment) },
      ),
    ).toEqual([]);

    const correctionComment = {
      ...validComment,
      body: "[Codex Review] Review-evidence correction, not a certification. The prior body supplied placeholder session... NOT certified.",
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(correctionComment) }))
      .toEqual(["Seat 2 review comment is a review correction/rejection, not a certification."]);

    const negatedComment = {
      ...validComment,
      body: `[Codex Review] Do not CERTIFY. Historical prefix ${sha.slice(0, 7)} only.`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(negatedComment) }))
      .toEqual(["Seat 2 review comment is a review correction/rejection, not a certification."]);

    const requestChangesComment = {
      ...validComment,
      body: `[Codex Review] REQUEST CHANGES at ${sha}. Missing fail-closed controls.`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(requestChangesComment) }))
      .toEqual(["Seat 2 review comment is a review correction/rejection, not a certification."]);

    const missingCertify = {
      ...validComment,
      body: "[Codex Review] In progress, looks promising so far.",
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(missingCertify) }))
      .toEqual(["Seat 2 review comment must declare Verdict: CERTIFY."]);

    const prefixOnlyComment = {
      ...validComment,
      body: codexComment({ sha: sha.slice(0, 7) }),
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(prefixOnlyComment) }))
      .toEqual([`Seat 2 review comment must certify full current PR head SHA ${sha}.`]);

    const wrongHeadComment = {
      ...validComment,
      body: codexComment({ sha: "b".repeat(40) }),
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(wrongHeadComment) }))
      .toEqual([`Seat 2 review comment must certify full current PR head SHA ${sha}.`]);

    const missingReviewerComment = {
      ...validComment,
      body: `Verdict: CERTIFY\nSession: 01a18fe9-b92b-7ae0-aa13-faea3189ac57\nHead SHA: ${sha}`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(missingReviewerComment) }))
      .toEqual(["Seat 2 review comment must declare explicit Reviewer or Signed attribution."]);

    const tagOnlyComment = {
      ...validComment,
      body: `[Codex Update]\nVerdict: CERTIFY\nHead SHA: ${sha}`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(tagOnlyComment) }))
      .toEqual(["Seat 2 review comment must declare explicit Reviewer or Signed attribution."]);

    const missingSessionComment = {
      ...validComment,
      body: `[Codex Review]\nReviewer: Codex Seat 2\nVerdict: CERTIFY\nHead SHA: ${sha}\nSigned: Codex Seat 2`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(missingSessionComment) }))
      .toEqual(["Seat 2 review comment must declare an actual reviewer Session."]);

    const implementerReviewerComment = {
      ...validComment,
      body: `[Codex Review]\nReviewer: implementer\nVerdict: CERTIFY\nSession: 01a18fe9-b92b-7ae0-aa13-faea3189ac57\nHead SHA: ${sha}`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(implementerReviewerComment) }))
      .toEqual(["Seat 2 review must be independent; implementer self-review is refused."]);

    const matchingSessionComment = {
      ...validComment,
      body: `[Codex Review]\nReviewer: Codex Seat 2\nVerdict: CERTIFY\nSession: ${defaultImplementerSession}\nHead SHA: ${sha}`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(matchingSessionComment) }))
      .toEqual(["Seat 2 reviewer session matches the implementer session; independent review is required."]);

    const normalizedMatchingComment = {
      ...validComment,
      body: `[Codex Review]\nReviewer: Codex Seat 2\nVerdict: CERTIFY\nSession: local:${defaultImplementerSession.toUpperCase()}\nHead SHA: ${sha}`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(normalizedMatchingComment) }))
      .toEqual(["Seat 2 reviewer session matches the implementer session; independent review is required."]);

    const certifyPendingComment = {
      ...validComment,
      body: `Reviewer: Codex Seat 2\nVerdict: CERTIFY pending review\nSession: 01a18fe9-b92b-7ae0-aa13-faea3189ac57\nHead SHA: ${sha}`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(certifyPendingComment) }))
      .toEqual(["Seat 2 review comment must declare Verdict: CERTIFY."]);

    const pendingReviewBodyComment = {
      ...validComment,
      body: `Reviewer: Codex Seat 2\nVerdict: CERTIFY\nSession: 01a18fe9-b92b-7ae0-aa13-faea3189ac57\nHead SHA: ${sha}\nStatus: pending review`,
    };
    expect(await verifyCodexReview({ url: codexReviewUrl, sha, implementerSession: defaultImplementerSession }, { ...context, fetchImpl: makeFetch(pendingReviewBodyComment) }))
      .toEqual(["Seat 2 review comment indicates review is pending, not completed."]);
  });

  test("referencedCommentUrls collects review and waiver URLs", () => {
    const s1Url = "https://github.com/o/r/pull/7#issuecomment-999";
    const body = `## Skill evidence\n- Seat 1 review: ${s1Url}\n- Seat 1 waiver: ${waiverUrl}\n- Seat 2 review: ${codexReviewUrl}\n`;
    expect(referencedCommentUrls(body)).toEqual([s1Url, waiverUrl, codexReviewUrl]);
  });

  test("check reports Seat 1: WAIVED and Seat 2: CERTIFIED explicitly", async () => {
    const bodyText = fill({
      "Seat 1 model": "WAIVED",
      "Seat 2 SHA": sha,
    }) + `- Implementer session: ${defaultImplementerSession}\n- Seat 1 waiver ruling: SCRUM-760 c24127\n- Seat 1 waiver: ${waiverUrl}\n- Seat 2 review: ${codexReviewUrl}\n`;

    const comments: Record<string, Record<string, unknown>> = {
      "111": { html_url: waiverUrl, issue_url: "https://api.github.com/repos/o/r/issues/7", author_association: "OWNER", body: waiverComment() },
      "222": { html_url: codexReviewUrl, issue_url: "https://api.github.com/repos/o/r/issues/7", author_association: "OWNER", body: codexComment() },
    };

    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/issues/comments/111")) return { ok: true, status: 200, json: async () => comments["111"] } as Response;
      if (u.includes("/issues/comments/222")) return { ok: true, status: 200, json: async () => comments["222"] } as Response;
      if (u.includes("/files")) return { ok: true, status: 200, json: async () => money.map((filename) => ({ filename })) } as Response;
      if (u.includes("/commits")) return { ok: true, status: 200, json: async () => [{ sha }] } as Response;
      return { ok: true, status: 200, json: async () => ({ state: "open", body: bodyText, head: { sha } }) } as Response;
    }) as typeof fetch;

    const result = await check({ REPO: "o/r", PR_NUMBER: "7", GH_TOKEN: "test" }, fetchImpl);
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toBe("skill-evidence: section present and consistent. Seat 1: WAIVED (owner-proxy ruling SCRUM-760 c24127). Seat 2: CERTIFIED.");
  });

  test("check reports Seat 1: WAIVED and Seat 2: CERTIFIED with chat mode and unasserted effort", async () => {
    const bodyText =
      fill({
        "Seat 1 model": "WAIVED",
        "Seat 2 mode": "chat",
        "Seat 2 effort": "unasserted (chat review)",
        "Seat 2 SHA": sha,
      }) +
      `- Implementer session: ${defaultImplementerSession}\n- Seat 1 waiver ruling: SCRUM-760 c24127\n- Seat 1 waiver: ${waiverUrl}\n- Seat 2 review: ${codexReviewUrl}\n`;

    const comments: Record<string, Record<string, unknown>> = {
      "111": { html_url: waiverUrl, issue_url: "https://api.github.com/repos/o/r/issues/7", author_association: "OWNER", body: waiverComment() },
      "222": { html_url: codexReviewUrl, issue_url: "https://api.github.com/repos/o/r/issues/7", author_association: "OWNER", body: codexComment({ mode: "chat" }) },
    };

    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/issues/comments/111")) return { ok: true, status: 200, json: async () => comments["111"] } as Response;
      if (u.includes("/issues/comments/222")) return { ok: true, status: 200, json: async () => comments["222"] } as Response;
      if (u.includes("/files")) return { ok: true, status: 200, json: async () => money.map((filename) => ({ filename })) } as Response;
      if (u.includes("/commits")) return { ok: true, status: 200, json: async () => [{ sha }] } as Response;
      return { ok: true, status: 200, json: async () => ({ state: "open", body: bodyText, head: { sha } }) } as Response;
    }) as typeof fetch;

    const result = await check({ REPO: "o/r", PR_NUMBER: "7", GH_TOKEN: "test" }, fetchImpl);
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toBe("skill-evidence: section present and consistent. Seat 1: WAIVED (owner-proxy ruling SCRUM-760 c24127). Seat 2: CERTIFIED.");
  });
});
