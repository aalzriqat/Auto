// @vitest-environment node
// SCRUM-1011: the new-code line ranges that scope sonar-lint findings, parsed from `git diff -U0` run for ONE requested file.
// Design: a file's identity is the file we asked git about, never a path read from the diff text. Anything the parser does not fully
// understand gives no ranges (undefined), so every line of that file is judged. Format: https://git-scm.com/docs/diff-format.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveGit } from "../contractSkew/gitExecutable.mjs";
import { hasEslintOnlyLineBreak, newCodeDiffArgs, newCodeLineRanges } from "./diffRanges.mjs";
import { makeGit } from "./preflight.mjs";

const header = (file: string, oldFile = file) => `diff --git a/${oldFile} b/${file}\nindex 1111111..2222222 100644\n--- a/${oldFile}\n+++ b/${file}\n`;
const ranges = (text: string, file = "a.mjs") => newCodeLineRanges(text, file);
const one = "@@ -1 +1 @@\n-a\n+b\n";

describe("newCodeLineRanges: control cases (a single, fully understood block)", () => {
  it("a normal change gives its exact new-side ranges", () => {
    expect(ranges(header("a.mjs") + "@@ -3,0 +4,3 @@ context\n+x\n+y\n+z\n@@ -20 +30 @@\n-old\n+new\n")).toEqual([[4, 6], [30, 30]]);
  });

  it("a deletions-only file is [] (git reported it with zero new lines)", () => {
    expect(ranges(header("a.mjs") + "@@ -4,2 +3,0 @@\n-a\n-b\n")).toEqual([]);
  });

  it("no output at all (unchanged, untracked or ignored file) is undefined: every line is judged", () => {
    expect(ranges("")).toBeUndefined();
    expect(ranges("\n")).toBeUndefined();
  });

  it("a created file ('--- /dev/null') gets its '+++ b/' file's range", () => {
    const created = "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n";
    expect(ranges(created, "new.ts")).toEqual([[1, 3]]);
  });

  it("'\\ No newline at end of file' markers are skipped without being counted as body lines", () => {
    expect(ranges(header("a.mjs") + "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n")).toEqual([[1, 1]]);
  });

  it("a path with a space (git appends a tab) and a non-ASCII path are read for the requested file", () => {
    const spaced = "diff --git a/with space/f.ts b/with space/f.ts\nindex 1..2 100644\n--- a/with space/f.ts\t\n+++ b/with space/f.ts\t\n" + one;
    expect(ranges(spaced, "with space/f.ts")).toEqual([[1, 1]]);
    expect(ranges(header("ünï/ö.ts") + "@@ -2 +2 @@\n-a\n+b\n", "ünï/ö.ts")).toEqual([[2, 2]]);
  });
});

describe("newCodeLineRanges: hunk bodies are never read as headers", () => {
  it("an added line whose text starts with '++ b/' (rendered '+++ b/...') inside a hunk is body", () => {
    expect(ranges(header("a.mjs") + "@@ -1,0 +2,2 @@\n+++ b/other.mjs\n+const x = [3, 1].sort();\n@@ -9 +11 @@\n-old\n+new\n")).toEqual([[2, 3], [11, 11]]);
  });

  it("a removed '-- a/x' line and an added '++ b/x' line (rendered '--- a/x' / '+++ b/x') are body text", () => {
    expect(ranges(header("a.mjs") + "@@ -5 +5 @@\n--- a/x\n+++ b/x\n")).toEqual([[5, 5]]);
  });
});

describe("newCodeLineRanges: the printed path never gives a file its identity", () => {
  it("a path other than the requested file's b/<file> (dstPrefix=b/lib/ prints 'b/lib/a.ts' for a.ts) gives no ranges", () => {
    expect(ranges(header("lib/a.ts", "a.ts"), "a.ts")).toBeUndefined();
    expect(ranges(header("x/README.md"), "README.md")).toBeUndefined();
  });

  it("two diff blocks in one single-file call give no ranges, whichever path they print", () => {
    expect(ranges(header("a.mjs") + one + header("a.mjs") + one)).toBeUndefined();
    expect(ranges(header("a.mjs") + one + header("b.mjs") + one)).toBeUndefined();
    expect(ranges(header("b.mjs") + one + header("a.mjs") + one)).toBeUndefined();
  });

  it("a deleted file ('+++ /dev/null') and a symlink or gitlink (mode 120000 / 160000) give no ranges", () => {
    expect(ranges("diff --git a/a.mjs b/a.mjs\ndeleted file mode 100644\n--- a/a.mjs\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n")).toBeUndefined();
    expect(ranges("diff --git a/a.mjs b/a.mjs\nnew file mode 120000\nindex 1..2\n--- /dev/null\n+++ b/a.mjs\n@@ -0,0 +1 @@\n+target\n")).toBeUndefined();
    expect(ranges("diff --git a/a.mjs b/a.mjs\nindex 1..2 160000\n--- a/a.mjs\n+++ b/a.mjs\n@@ -1 +1 @@\n-Subproject commit 1\n+Subproject commit 2\n")).toBeUndefined();
  });
});

describe("newCodeLineRanges: anything not understood gives no ranges (the parser never guesses)", () => {
  const cases: Array<[string, string]> = [
    ["a context line inside a counted hunk (GIT_DIFF_OPTS, diff.interHunkContext)", header("a.mjs") + "@@ -1,4 +1,5 @@\n one\n--- a/q\n+++ b/zzz.mjs\n+bad\n three\n@@ -20,0 +21,1 @@\n+late\n"],
    ["a combined-diff '@@@' hunk header", header("a.mjs") + "@@@ -1,2 -1,2 +1,3 @@@\n  x\n++y\n"],
    ["a truncated last hunk", header("a.mjs") + "@@ -1,0 +1,3 @@\n+a\n+b\n"],
    ["an over-long hunk (added)", header("a.mjs") + "@@ -1 +1 @@\n-a\n+b\n+c\n"],
    ["an over-long hunk (removed)", header("a.mjs") + "@@ -1 +1 @@\n-a\n-c\n+b\n"],
    ["a '+++' that does not follow a '---'", "diff --git a/a.mjs b/a.mjs\n+++ b/a.mjs\n@@ -1 +1 @@\n-a\n+b\n"],
    ["a hunk header before any '+++'", "diff --git a/a.mjs b/a.mjs\n--- a/a.mjs\n@@ -1 +1 @@\n-a\n+b\n"],
    ["a stray line between hunks", header("a.mjs") + "@@ -1 +1 @@\n-a\n+b\n stray\n@@ -9 +9 @@\n-c\n+d\n"],
    ["a second '---' line after the header", header("a.mjs") + "--- a/again\n" + one],
    ["a header with no hunk", header("a.mjs")],
    ["text before the first 'diff --git'", "warning: something\n" + header("a.mjs") + one],
  ];
  it.each(cases)("%s", (_name, text) => {
    expect(ranges(text)).toBeUndefined();
  });
});

describe("hasEslintOnlyLineBreak: ESLint splits lines on more than git's newline", () => {
  it("is true for a lone CR, U+2028 and U+2029, false for LF and CRLF only", () => {
    expect(hasEslintOnlyLineBreak("a\rb\n")).toBe(true);
    expect(hasEslintOnlyLineBreak("a\u2028b\n")).toBe(true);
    expect(hasEslintOnlyLineBreak("a\u2029b\n")).toBe(true);
    expect(hasEslintOnlyLineBreak("a\r\nb\r\n")).toBe(false);
    expect(hasEslintOnlyLineBreak("a\nb\n")).toBe(false);
  });
});

describe("newCodeDiffArgs: a controlled diff of one file", () => {
  it("passes one pathspec after --, literally, with the prefixes, drivers and context pinned", () => {
    const args = newCodeDiffArgs("abc", ":(exclude)x.mjs");
    expect(args.slice(-3)).toEqual(["abc", "--", ":(exclude)x.mjs"]);
    expect(args).toEqual(expect.arrayContaining([
      "--literal-pathspecs", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--inter-hunk-context=0", "-U0", "--no-renames",
    ]));
    expect(args.indexOf("--literal-pathspecs")).toBeLessThan(args.indexOf("diff"));
  });
});

describe("newCodeLineRanges on the output of the real git, in a temporary repository", () => {
  const git = resolveGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-diff-"));
  const emptyConfig = path.join(dir, "..", `${path.basename(dir)}-gitconfig`);
  const noHooks = path.join(dir, "..", `${path.basename(dir)}-nohooks`);
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyConfig, { force: true });
    fs.rmSync(noHooks, { recursive: true, force: true });
  });

  // Isolated from the machine: no global or system config, no hooks, no signing (git-config: GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM).
  const isolatedEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" });

  const g = (...args: string[]): string => {
    if (!git) throw new Error("git not found in its standard install locations");
    const pinned = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${noHooks}`];
    return execFileSync(git, ["-C", dir, ...pinned, ...args], { encoding: "utf8", env: isolatedEnv() });
  };

  const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
  const edit = (text: string, line: number): string => text.split("\n").map((l, i) => (i === line - 1 ? l.toUpperCase() : l)).join("\n");
  const expected: Record<string, Array<[number, number]>> = {
    "a.ts": [[2, 2]], "lib/a.ts": [[10, 10]], "[a].ts": [[5, 5]], "with space/f.ts": [[4, 4]], "ünï/ö.ts": [[1, 1]], "m.mjs": [[3, 3], [10, 10]],
  };

  const rangesFor = (extraEnv: NodeJS.ProcessEnv, file: string) => {
    const run = makeGit({ root: dir, env: { ...isolatedEnv(), ...extraEnv } });
    return newCodeLineRanges(run(newCodeDiffArgs("HEAD", file)), file);
  };

  it("sets up a repository with hostile config and changes to a.ts, lib/a.ts, [a].ts, spaces, non-ASCII and crafted lines", () => {
    fs.writeFileSync(emptyConfig, "");
    fs.mkdirSync(noHooks, { recursive: true });
    g("init", "-q");
    // A user's own settings must not change the prefixes, the quoting or the context the parser relies on.
    for (const [k, v] of [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"], ["core.quotePath", "true"], ["core.autocrlf", "false"], ["diff.interHunkContext", "5"]]) g("config", k, v);
    const files = Object.keys(expected);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), f === "m.mjs" ? "one\n-- a/q\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n" : base);
    }
    g("add", "--", ...files);
    g("commit", "-q", "-m", "base");
    // m.mjs: removes "-- a/q" (diff line "--- a/q"), adds "++ b/zzz.mjs" (diff line "+++ b/zzz.mjs"), edits line 10 far below.
    fs.writeFileSync(path.join(dir, "m.mjs"), "one\nthree\n++ b/zzz.mjs\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
    for (const [f, line] of [["a.ts", 2], ["lib/a.ts", 10], ["[a].ts", 5], ["with space/f.ts", 4], ["ünï/ö.ts", 1]] as const) fs.writeFileSync(path.join(dir, f), edit(base, line));
    expect(g("status", "--porcelain").length).toBeGreaterThan(0);
  }, 60_000);

  it("each requested file gets exactly its own ranges, with GIT_DIFF_OPTS=-u3 and diff.interHunkContext set, and glob and crafted names", () => {
    for (const file of Object.keys(expected)) expect(rangesFor({ GIT_DIFF_OPTS: "-u3" }, file), file).toEqual(expected[file]);
  }, 60_000);

  const prefixVariants: Array<[string, Record<string, string>]> = [
    ["diff.dstPrefix=b/lib/", { "diff.dstPrefix": "b/lib/" }],
    ["diff.srcPrefix=a/lib/", { "diff.srcPrefix": "a/lib/" }],
    ["both prefixes, with noprefix=false and mnemonicPrefix=false", { "diff.srcPrefix": "a/lib/", "diff.dstPrefix": "b/lib/", "diff.noprefix": "false", "diff.mnemonicPrefix": "false" }],
  ];

  it.each(prefixVariants)("user prefix config cannot credit one file's ranges to another: %s (through GIT_CONFIG_COUNT)", (_name, config) => {
    const entries = Object.entries(config);
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(entries.length) };
    entries.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
    expect(rangesFor(env, "a.ts")).toEqual([[2, 2]]);
    expect(rangesFor(env, "lib/a.ts")).toEqual([[10, 10]]);
  }, 60_000);

  it("the same prefix config set in the repository itself", () => {
    g("config", "diff.dstPrefix", "b/lib/");
    g("config", "diff.srcPrefix", "a/lib/");
    expect(rangesFor({}, "a.ts")).toEqual([[2, 2]]);
    expect(rangesFor({}, "lib/a.ts")).toEqual([[10, 10]]);
  }, 60_000);

  it("an unchanged tracked file and an untracked file give no output, so every line is judged", () => {
    fs.writeFileSync(path.join(dir, "untracked.ts"), base);
    expect(rangesFor({}, "untracked.ts")).toBeUndefined();
    g("add", "--", "untracked.ts");
    g("commit", "-q", "-m", "second");
    expect(rangesFor({}, "untracked.ts")).toBeUndefined();
  }, 60_000);
});
