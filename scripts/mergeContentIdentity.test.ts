/**
 * SCRUM-494: Sonar must accept a regenerated PR merge (same tree, same
 * parents, new commit SHA) and refuse anything whose content differs.
 * Uses real git repositories, not mocks.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { contentIdentity, runCli, sameContentIdentity } from "./mergeContentIdentity.mjs";
import { resolveTrustedGitExecutable } from "./trustedGit.mjs";

// Wrap (not replace) the resolver so tests can observe and override it while the
// default behaviour stays the real one.
vi.mock("./trustedGit.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./trustedGit.mjs")>();
  return { resolveTrustedGitExecutable: vi.fn(actual.resolveTrustedGitExecutable) };
});

let repo = "";
const git = (args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();

const COMMITTER = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const commitTree = (tree: string, parents: string[], date: string) =>
  git(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "m"], {
    ...COMMITTER,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });

const treeOf = (content: string) => {
  writeFileSync(path.join(repo, "f.txt"), content);
  git(["add", "f.txt"]);
  return git(["write-tree"]);
};

let base = "";
let head = "";
let otherBase = "";
let tree = "";
let otherTree = "";
let merge1 = "";
let merge2 = "";
let tagSha = "";

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "merge-identity-"));
  execFileSync("git", ["init", "-q", repo]);
  const t0 = treeOf("base");
  base = commitTree(t0, [], "2026-01-01T00:00:00Z");
  otherBase = commitTree(t0, [], "2026-01-02T00:00:00Z");
  head = commitTree(treeOf("head"), [base], "2026-01-03T00:00:00Z");
  tree = treeOf("merged");
  otherTree = treeOf("merged-differently");
  merge1 = commitTree(tree, [base, head], "2026-02-01T00:00:00Z");
  merge2 = commitTree(tree, [base, head], "2026-02-01T01:00:00Z");
  git(["tag", "-a", "-m", "t", "tagged-merge", merge1], COMMITTER);
  tagSha = git(["rev-parse", "tagged-merge"]);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("merge content identity", () => {
  test("identical tree and parents with a different SHA is accepted", () => {
    expect(merge1).not.toBe(merge2);
    expect(sameContentIdentity(repo, merge1, merge2)).toBe(true);
    expect(contentIdentity(repo, merge1)).toEqual({ tree, first: base, second: head });
  });

  test.each([
    ["different tree", () => commitTree(otherTree, [base, head], "2026-02-01T02:00:00Z")],
    ["swapped parents", () => commitTree(tree, [head, base], "2026-02-01T03:00:00Z")],
    ["different first parent", () => commitTree(tree, [otherBase, head], "2026-02-01T04:00:00Z")],
    [
      "different second parent",
      () => commitTree(tree, [base, commitTree(treeOf("head2"), [base], "2026-01-04T00:00:00Z")], "2026-02-01T05:00:00Z"),
    ],
  ])("%s is refused", (_name, make) => {
    expect(sameContentIdentity(repo, merge1, make())).toBe(false);
  });

  test("one-parent and three-parent commits are refused", () => {
    const one = commitTree(tree, [base], "2026-02-01T06:00:00Z");
    const three = commitTree(tree, [base, head, otherBase], "2026-02-01T07:00:00Z");
    expect(() => contentIdentity(repo, one)).toThrow(/two-parent/);
    expect(() => sameContentIdentity(repo, merge1, one)).toThrow();
    expect(() => contentIdentity(repo, three)).toThrow(/two-parent/);
  });

  test("malformed SHAs are refused", () => {
    const bad = ["", "abc", "refs/heads/main", `${merge1}; echo pwn`, merge1.slice(0, 39), `${merge1}0`, "z".repeat(40)];
    for (const value of bad) {
      expect(() => contentIdentity(repo, value)).toThrow(/40-hex/);
      expect(() => sameContentIdentity(repo, merge1, value)).toThrow(/40-hex/);
    }
  });

  test("a well-formed SHA that is not in the repository (unfetchable) is refused", () => {
    expect(() => contentIdentity(repo, "1".repeat(40))).toThrow(/not a commit present/);
    expect(() => sameContentIdentity(repo, merge1, "1".repeat(40))).toThrow(/not a commit present/);
  });

  test("a non-commit object is refused", () => {
    expect(() => contentIdentity(repo, tree)).toThrow(/not a commit/);
  });

  test("an annotated tag pointing at a valid merge is refused (no tag peeling)", () => {
    expect(tagSha).not.toBe(merge1);
    expect(() => contentIdentity(repo, tagSha)).toThrow(/is not a commit/);
    expect(() => sameContentIdentity(repo, merge1, tagSha)).toThrow(/is not a commit/);
  });
});

describe("merge content identity CLI (subprocess)", () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "mergeContentIdentity.mjs");
  const run = (...args: string[]) =>
    spawnSync("node", [script, "--repo", repo, ...args], { encoding: "utf8" });

  test("identical content exits 0 and prints exactly SAME", () => {
    const r = run("same", merge1, merge2);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("SAME");
  });

  test.each([
    ["different tree", () => ["same", merge1, commitTree(otherTree, [base, head], "2026-03-01T00:00:00Z")], 1],
    ["malformed SHA", () => ["same", merge1, "not-a-sha"], 1],
    ["annotated tag", () => ["same", merge1, tagSha], 1],
    ["bad usage", () => ["same", merge1], 2],
  ] as const)("%s exits %i with no SAME output", (_label, args, status) => {
    const r = run(...args());
    expect(r.status).toBe(status);
    expect(r.stdout).not.toContain("SAME");
  });
});

describe("merge content identity CLI (in-process runCli)", () => {
  const out = () => vi.spyOn(console, "log").mockImplementation(() => {});
  const err = () => vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => vi.restoreAllMocks());

  test("SAME prints exactly SAME and returns 0", () => {
    const log = out();
    const error = err();
    expect(runCli(["--repo", repo, "same", merge1, merge2])).toBe(0);
    expect(log.mock.calls).toEqual([["SAME"]]);
    expect(error).not.toHaveBeenCalled();
  });

  test("defaults --repo to the current directory", () => {
    const log = out();
    const error = err();
    // No --repo: "." is used, which here is the AutoFlow repo, so the SHAs are not present.
    expect(runCli(["same", merge1, merge2])).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toMatch(/not a commit present/);
  });

  test("DIFFERENT returns 1 with nothing on stdout", () => {
    const log = out();
    const error = err();
    const other = commitTree(otherTree, [base, head], "2026-04-01T00:00:00Z");
    expect(runCli(["--repo", repo, "same", merge1, other])).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toMatch(/differ/);
  });

  test.each([
    ["wrong command", () => ["--repo", repo, "diff", merge1, merge2]],
    ["too few args", () => ["--repo", repo, "same", merge1]],
    ["too many args", () => ["--repo", repo, "same", merge1, merge2, merge1]],
    ["no args", () => []],
  ])("usage error (%s) returns 2 with nothing on stdout", (_l, args) => {
    const log = out();
    const error = err();
    expect(runCli(args())).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toMatch(/usage:/);
  });

  test("a bad SHA returns 1 without SAME", () => {
    const log = out();
    const error = err();
    expect(runCli(["--repo", repo, "same", merge1, "nope"])).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toMatch(/mergeContentIdentity: .*40-hex/);
  });

  test("a non-Error throw is still reported and fails closed", () => {
    const log = out();
    const error = err();
    vi.mocked(resolveTrustedGitExecutable).mockImplementationOnce(() => {
      throw "boom";
    });
    expect(runCli(["--repo", repo, "same", merge1, merge2])).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toBe("mergeContentIdentity: boom");
  });

  test("resolver failure fails closed: contentIdentity throws, CLI returns 1, no SAME", () => {
    const log = out();
    const error = err();
    const failing = () => {
      throw new Error("A trusted absolute Git executable was not found");
    };
    vi.mocked(resolveTrustedGitExecutable).mockImplementation(failing);
    try {
      expect(() => contentIdentity(repo, merge1)).toThrow(/trusted absolute Git/);
      expect(runCli(["--repo", repo, "same", merge1, merge2])).toBe(1);
    } finally {
      vi.mocked(resolveTrustedGitExecutable).mockReset();
    }
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toMatch(/trusted absolute Git/);
  });
});

describe("git is resolved to an absolute trusted path, never via PATH", () => {
  afterEach(() => vi.restoreAllMocks());


  test("contentIdentity executes exactly the path the resolver returns", () => {
    // A resolver result that does not exist makes the lookup fail closed; if the
    // code used a bare "git" from PATH instead, it would succeed and this would fail.
    vi.mocked(resolveTrustedGitExecutable).mockImplementationOnce(() =>
      path.join(tmpdir(), "no-such-dir", "git-not-here"),
    );
    expect(() => contentIdentity(repo, merge1)).toThrow(/not a commit present/);
    expect(contentIdentity(repo, merge1).tree).toBe(tree);
  });
});
