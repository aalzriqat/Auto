/**
 * Skill enforcement: the hook gate and the PR evidence check. Failing-first
 * controls: each refusal cell has a matching pass cell so a gate that always
 * passes, or always blocks, turns a test red.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { classifyPaths, invokedSkills, requiredSkills } from "./policy.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decide, gitExecutable, gitSteps, run, stepsFor } from "./skillGate.mjs";
import { check } from "./checkPrSkillEvidence.mjs";
import { evaluate, isPlaceholder, TEMPLATE } from "./prSkillEvidence.mjs";

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
  const step = (st: string, all = false, dirs: string[] = [], opaque = false) => ({ step: st, all, dirs, opaque });
  test.each([
    ["git commit -m x", [step("commit")]],
    ["git commit -am x", [step("commit", true)]],
    ["git -C /repo push -u origin b", [step("push", false, ["/repo"])]],
    ["pnpm lint && git push", [step("push")]],
    ["FOO=1 git commit --all -m x", [step("commit", true)]],
    ["gh pr create --title x", [step("pr")]],
    ["git status", []],
    ["git log --oneline", []],
    ["bash -c 'git commit -m x'", [step("commit")]],
    ['sh -c "git -C /r push origin b"', [step("push", false, ["/r"])]],
    ["env FOO=1 git push", [step("push")]],
    ["echo $(git commit -am x)", [step("commit", true)]],
    ["git commit --amend", [step("commit")]],
    ["command git commit -m x", [step("commit")]],
    ["/usr/bin/git push", [step("push")]],
    ["(git push)", [step("push")]],
    ["git --git-dir=/x/.git commit -m y", [step("commit", false, [], true)]],
    ["git -C a -C b commit -m y", [step("commit", false, ["a", "b"])]],
    ["echo git commit", []],
    ["grep 'git push' notes.txt", []],
    ["printf 'git commit'", []],
  ])("%s", (cmd, expected) => expect(gitSteps(cmd)).toEqual(expected));
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
  return `intro\nhttps://claude.ai/code/session_IMPL999\n\n## Skill evidence
- Skills run: ${base["Skills run"]}
- Red run:
\`\`\`
FAIL sales.test.ts > refuses X
AssertionError: expected 5 to be 0
\`\`\`
- /simplify output:
\`\`\`
no changes needed
\`\`\`
- Seat 1 session: ${base["Seat 1 session"]}
- Seat 1 model: ${base["Seat 1 model"]}
- Seat 1 SHA: ${base["Seat 1 SHA"]}
- Seat 2 model: ${base["Seat 2 model"]}
- Seat 2 effort: ${base["Seat 2 effort"]}
- Seat 2 SHA: ${base["Seat 2 SHA"]}
`;
};
const money = ["convex/sales.ts"];

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
    ["Seat 2 wrong model", { "Seat 2 model": "gpt-5" }, "gpt-6-sol"],
    ["skill missing", { "Skills run": "tdd" }, "blast-radius"],
  ])("rejects: %s", async (_n, over, frag) => {
    const r = await evaluate({ body: fill(over), files: money });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain(frag);
  });
  test("red run that shows no failure is rejected", async () => {
    const body = fill().replace(/FAIL[\s\S]*?7 to be 0|FAIL sales[\s\S]*?to be 0/, "all good");
    const r = await evaluate({ body, files: money });
    expect(r.problems.join("\n")).toContain("does not show a failure");
  });
  test("SHA outside the PR history is rejected", async () => {
    const r = await evaluate({ body: fill(), files: money, isPrCommit: async () => false });
    expect(r.problems.join("\n")).toContain("PR head or a commit");
  });
  test("real output with generics or the word pending is not a placeholder", async () => {
    const body = fill().replace("no changes needed", "Promise<void> stays; 2 tests pending");
    const r = await evaluate({ body, files: money, isPrCommit: async () => true });
    expect(r.problems).toEqual([]);
  });
  test.each(["<real output>", "TODO", "pending", "n/a", ""])("placeholder /simplify block %j is rejected", async (blk) => {
    const body = fill().replace("no changes needed", blk);
    const r = await evaluate({ body, files: money });
    expect(r.problems.join("\n")).toContain("/simplify output");
  });
  test.each([
    ["zero failures", "Tests  0 failed | 12 passed"],
    ["prose with no failure sign", "no error seen, all expected"],
  ])("red run with %s is rejected", async (_n, out) => {
    const body = fill().replace(/FAIL sales[\s\S]*?to be 0/, out);
    expect((await evaluate({ body, files: money })).problems.join("\n")).toContain("does not show a failure");
  });
  test("a failure count or AssertionError is accepted", async () => {
    const body = fill().replace(/FAIL sales[\s\S]*?to be 0/, "Tests  1 failed | 11 passed");
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
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "gate-"));
    sh(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "README.md"), "x");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "base");
    mkdirSync(path.join(dir, "convex"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command }, cwd: dir });

  test("a staged money file blocks commit without skills and passes with them", () => {
    writeFileSync(path.join(dir, "convex/sales.ts"), "export {};");
    sh(dir, "add", "convex/sales.ts");
    const denied = run(JSON.stringify(bash("git commit -m x")), () => "", exe!);
    expect(JSON.parse(denied).hookSpecificOutput.permissionDecision).toBe("deny");
    const t = transcript("tdd", "blast-radius");
    expect(run(JSON.stringify(bash("git commit -m x")), () => t, exe!)).toBe("");
  });
  test("a non-git command is ignored and an unreadable transcript still gates", () => {
    expect(run(JSON.stringify(bash("ls")), () => { throw new Error("x"); }, exe!)).toBe("");
    const out = run(JSON.stringify(bash("git commit -am x")), () => { throw new Error("x"); }, exe!);
    expect(out).toContain("tdd");
  });
  test("push uses the branch diff; with no main to compare it treats the change as money", () => {
    const steps = stepsFor(bash("git commit -m y && git push"), exe!);
    expect(steps.map((s: { step: string }) => s.step)).toEqual(["commit", "push"]);
    expect(steps[1].files).toContain("convex/sales.ts");
  });
  test("-C targets the other repository's staged files, not the cwd's", () => {
    const other = mkdtempSync(path.join(tmpdir(), "gate-other-"));
    try {
      sh(other, "init", "-q", "-b", "main");
      mkdirSync(path.join(other, "convex"));
      writeFileSync(path.join(other, "convex/claims.ts"), "export {};");
      sh(other, "add", ".");
      const steps = stepsFor(bash(`git -C ${other} commit -m x`), exe!);
      expect(steps[0].files).toEqual(["convex/claims.ts"]);
      expect(stepsFor(bash("git --git-dir=/nope commit -m x"), exe!)[0].files).toBeNull();
      expect(stepsFor(bash("git -C /does/not/exist commit -m x"), exe!)[0].files).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
  test("echo of a git command is not gated", () => {
    expect(run(JSON.stringify(bash("echo git commit")), () => "", exe!)).toBe("");
  });
  test("no git executable makes the change unknown and therefore gated", () => {
    expect(decide(bash("git push"), "", null as unknown as string)).toContain("tdd");
  });
  test("PR creation tool reads the branch files", () => {
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
    const r = await check(env, api(fill(), ["convex/sales.ts"], ["abc1234ffff"]) as typeof fetch);
    expect(r.lines).toEqual(["skill-evidence: section present and consistent."]);
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
