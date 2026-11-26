// @vitest-environment node
// SCRUM-1011: the new-code line ranges that scope sonar-lint findings, parsed from `git diff -U0`.
// Format relied on: https://git-scm.com/docs/diff-format ("diff --git" header, then "---"/"+++", then "@@" hunks).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveGit } from "../contractSkew/gitExecutable.mjs";
import { makeGit } from "./preflight.mjs";
import { changedLineRanges, newCodeDiffArgs } from "./sonarSteps.mjs";

const entries = (text: string): Array<[string, Array<[number, number]>]> => [...changedLineRanges(text)];

const header = (file: string, oldFile = file) => `diff --git a/${oldFile} b/${file}\nindex 1111111..2222222 100644\n--- a/${oldFile}\n+++ b/${file}\n`;

describe("changedLineRanges: hunk bodies are never read as headers", () => {
  it("an added line whose text starts with '++ b/' (rendered '+++ b/...') inside a hunk does not start a new file", () => {
    const diff = header("a.mjs") + "@@ -1,0 +2,2 @@\n+++ b/other.mjs\n+const x = [3, 1].sort();\n@@ -9 +11 @@\n-old\n+new\n";
    expect(entries(diff)).toEqual([["a.mjs", [[2, 3], [11, 11]]]]);
  });

  it("a removed '-- a/x' line and an added '++ b/x' line (rendered '--- a/x' / '+++ b/x') are body text", () => {
    const diff = header("a.mjs") + "@@ -5 +5 @@\n--- a/x\n+++ b/x\n";
    expect(entries(diff)).toEqual([["a.mjs", [[5, 5]]]]);
  });

  it("a removed line that looks like a header between two hunks does not hide the second hunk", () => {
    const diff = header("a.mjs") + "@@ -3,2 +3,0 @@\n--- a/y\n-z\n@@ -20,0 +21,2 @@\n+one\n+two\n";
    expect(entries(diff)).toEqual([["a.mjs", [[21, 22]]]]);
  });

  it("a real next file after a hunk is a new entry, with both files' ranges kept", () => {
    const diff = header("a.mjs") + "@@ -1 +1 @@\n-a\n+b\n" + header("b/c.ts") + "@@ -4,0 +5,3 @@\n+x\n+y\n+z\n";
    expect(entries(diff)).toEqual([["a.mjs", [[1, 1]]], ["b/c.ts", [[5, 7]]]]);
  });

  it("'\\ No newline at end of file' markers are skipped without being counted as body lines", () => {
    const diff = header("a.mjs") + "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n" + header("n.mjs") + "@@ -0,0 +1 @@\n+z\n";
    expect(entries(diff)).toEqual([["a.mjs", [[1, 1]]], ["n.mjs", [[1, 1]]]]);
  });

  it("a deleted file ('+++ /dev/null') has no entry and a created file ('--- /dev/null') is read from its '+++ b/' line", () => {
    const deleted = "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
    const created = "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n";
    expect(entries(deleted + created)).toEqual([["new.ts", [[1, 3]]]]);
  });

  it("a pure deletion hunk adds no range", () => {
    expect(entries(header("a.mjs") + "@@ -4,2 +3,0 @@\n-a\n-b\n")).toEqual([["a.mjs", []]]);
  });
});

// The invariant: input the parser does not fully understand for a file leaves that file with NO entry (so every line of it is
// judged), and a file in that state lets no later line create or change an entry for any path until the next `diff --git`.
describe("changedLineRanges: anything not understood for a file removes its entry (the parser never guesses)", () => {
  const good = (file: string) => header(file) + "@@ -1 +1 @@\n-a\n+b\n";

  it("a context line inside a counted hunk (GIT_DIFF_OPTS, diff.interHunkContext) poisons the file; the header-looking lines after it create nothing", () => {
    const probe = header("a.mjs") + "@@ -1,4 +1,5 @@\n one\n--- a/q\n+++ b/zzz.mjs\n+bad\n three\n@@ -20,0 +21,1 @@\n+late\n";
    expect(entries(probe)).toEqual([]);
  });

  it("a combined-diff '@@@' hunk header gives no entry (not an empty list)", () => {
    expect(entries(header("a.mjs") + "@@@ -1,2 -1,2 +1,3 @@@\n  x\n++y\n")).toEqual([]);
  });

  it("a truncated last hunk (fewer body lines than its counts) gives no entry", () => {
    expect(entries(header("a.mjs") + "@@ -1,0 +1,3 @@\n+a\n+b\n")).toEqual([]);
  });

  it("an over-long hunk (more added or removed lines than counted) gives no entry", () => {
    expect(entries(header("a.mjs") + "@@ -1 +1 @@\n-a\n+b\n+c\n")).toEqual([]);
    expect(entries(header("a.mjs") + "@@ -1 +1 @@\n-a\n-c\n+b\n")).toEqual([]);
  });

  it("a '+++' that does not follow a '---' gives no entry, and its hunk creates none", () => {
    expect(entries("diff --git a/a.mjs b/a.mjs\n+++ b/a.mjs\n@@ -1 +1 @@\n-a\n+b\n")).toEqual([]);
  });

  it("a hunk header before any '+++' gives no entry", () => {
    expect(entries("diff --git a/a.mjs b/a.mjs\n--- a/a.mjs\n@@ -1 +1 @@\n-a\n+b\n")).toEqual([]);
  });

  it("a second header block for a path already seen removes that path's entry for good", () => {
    expect(entries(good("a.mjs") + good("a.mjs"))).toEqual([]);
    expect(entries(good("a.mjs") + good("a.mjs") + good("a.mjs"))).toEqual([]);
  });

  it("a non-hunk line after the header block (an unexpected context line between hunks) gives no entry", () => {
    expect(entries(header("a.mjs") + "@@ -1 +1 @@\n-a\n+b\n stray\n@@ -9 +9 @@\n-c\n+d\n")).toEqual([]);
  });

  it("a clean file after a poisoned one still parses, and one before it keeps its ranges", () => {
    const poisoned = header("p.mjs") + "@@ -1,2 +1,2 @@\n ctx\n-a\n+b\n";
    expect(entries(good("first.mjs") + poisoned + good("after.mjs"))).toEqual([["first.mjs", [[1, 1]]], ["after.mjs", [[1, 1]]]]);
  });
});

describe("changedLineRanges: paths", () => {
  it("strips the trailing tab git appends to a path with a space", () => {
    const diff = "diff --git a/with space/f.ts b/with space/f.ts\nindex 1..2 100644\n--- a/with space/f.ts\t\n+++ b/with space/f.ts\t\n@@ -1 +1 @@\n-a\n+b\n";
    expect(entries(diff)).toEqual([["with space/f.ts", [[1, 1]]]]);
  });

  it("keeps a non-ASCII path as written (core.quotePath=false)", () => {
    expect(entries(header("ünï/ö.ts") + "@@ -2 +2 @@\n-a\n+b\n")).toEqual([["ünï/ö.ts", [[2, 2]]]]);
  });
});

describe("changedLineRanges on the output of the real git, in a temporary repository", () => {
  const git = resolveGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-diff-"));
  const emptyConfig = path.join(dir, "..", `${path.basename(dir)}-gitconfig`);
  const noHooks = path.join(dir, "..", `${path.basename(dir)}-nohooks`);
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyConfig, { force: true });
    fs.rmSync(noHooks, { recursive: true, force: true });
  });

  // Isolated from the machine: no global or system config, no hooks, no signing (https://git-scm.com/docs/git#_git_commits and
  // git-config: GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM).
  const isolatedEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" });

  const g = (...args: string[]): string => {
    if (!git) throw new Error("git not found in its standard install locations");
    const pinned = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${noHooks}`];
    return execFileSync(git, ["-C", dir, ...pinned, ...args], { encoding: "utf8", env: isolatedEnv() });
  };

  it("keeps every file's ranges, including crafted '-- a/q' / '++ b/zzz.mjs' lines, spaces, non-ASCII paths, hostile user config, GIT_DIFF_OPTS and diff.interHunkContext", () => {
    fs.writeFileSync(emptyConfig, "");
    fs.mkdirSync(noHooks, { recursive: true });
    g("init", "-q");
    // A user's own settings must not change the prefixes, the quoting or the context the parser relies on.
    g("config", "diff.noprefix", "true");
    g("config", "diff.mnemonicPrefix", "true");
    g("config", "core.quotePath", "true");
    g("config", "core.autocrlf", "false");
    g("config", "diff.interHunkContext", "5");
    const files = ["a.mjs", "with space/f.ts", "ünï/ö.ts"];
    const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), f === "a.mjs" ? "one\n-- a/q\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n" : base);
    }
    g("add", "--", ...files);
    g("commit", "-q", "-m", "base");
    // a.mjs: removes "-- a/q" (diff line "--- a/q"), adds "++ b/zzz.mjs" (diff line "+++ b/zzz.mjs"), edits line 10 far below.
    fs.writeFileSync(path.join(dir, "a.mjs"), "one\nthree\n++ b/zzz.mjs\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
    fs.writeFileSync(path.join(dir, "with space/f.ts"), "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\nnine\nten\n");
    fs.writeFileSync(path.join(dir, "ünï/ö.ts"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");

    // The code under test builds its own git call; its child env asks for three lines of context, which -U0 alone would not beat.
    const run = makeGit({ root: dir, env: { ...isolatedEnv(), GIT_DIFF_OPTS: "-u3" } });
    const ranges = changedLineRanges(run(newCodeDiffArgs("HEAD", files)));

    expect(ranges.get("a.mjs")).toEqual([[3, 3], [10, 10]]);
    expect(ranges.get("with space/f.ts")).toEqual([[4, 4]]);
    expect(ranges.get("ünï/ö.ts")).toEqual([[1, 1]]);
    expect([...ranges.keys()].sort((a, b) => a.localeCompare(b))).toEqual(["a.mjs", "with space/f.ts", "ünï/ö.ts"].sort((a, b) => a.localeCompare(b)));
  }, 60_000);
});

describe("newCodeDiffArgs: a controlled diff", () => {
  it("turns off external diff drivers, textconv and inter-hunk context, besides the pinned config", () => {
    const args = newCodeDiffArgs("abc", ["x.mjs"]);
    expect(args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv", "--inter-hunk-context=0", "-U0", "--no-renames"]));
    expect(args.slice(-3)).toEqual(["abc", "--", "x.mjs"]);
  });
});
