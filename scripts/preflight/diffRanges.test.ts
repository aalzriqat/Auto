// @vitest-environment node
// SCRUM-1011: the new-code line ranges that scope sonar-lint findings, parsed from `git diff -U0`.
// Format relied on: https://git-scm.com/docs/diff-format ("diff --git" header, then "---"/"+++", then "@@" hunks).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveGit } from "../contractSkew/gitExecutable.mjs";
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
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const g = (...args: string[]): string => {
    if (!git) throw new Error("git not found in its standard install locations");
    return execFileSync(git, ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  };

  it("keeps every file's ranges, including a crafted '++ b/' line, spaces, non-ASCII paths and hostile user config", () => {
    g("init", "-q");
    // A user's own settings must not change the prefixes or the quoting the parser relies on.
    g("config", "diff.noprefix", "true");
    g("config", "diff.mnemonicPrefix", "true");
    g("config", "core.quotePath", "true");
    g("config", "core.autocrlf", "false");
    const files = ["a.mjs", "with space/f.ts", "ünï/ö.ts"];
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "one\ntwo\nthree\nfour\n");
    }
    g("add", "--", ...files);
    g("commit", "-q", "-m", "base");
    fs.writeFileSync(path.join(dir, "a.mjs"), "one\n++ b/other.mjs\nconst x = [3, 1].sort();\nthree\nfour\n");
    fs.writeFileSync(path.join(dir, "with space/f.ts"), "one\ntwo\nthree\nFOUR\n");
    fs.writeFileSync(path.join(dir, "ünï/ö.ts"), "ONE\ntwo\nthree\nfour\n");

    const ranges = changedLineRanges(g(...newCodeDiffArgs("HEAD", files)));

    expect(ranges.get("a.mjs")).toEqual([[2, 3]]);
    expect(ranges.get("with space/f.ts")).toEqual([[4, 4]]);
    expect(ranges.get("ünï/ö.ts")).toEqual([[1, 1]]);
    expect([...ranges.keys()].sort((a, b) => a.localeCompare(b))).toEqual(["a.mjs", "with space/f.ts", "ünï/ö.ts"].sort((a, b) => a.localeCompare(b)));
  }, 60_000);
});
