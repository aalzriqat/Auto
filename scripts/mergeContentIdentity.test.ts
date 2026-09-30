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
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { contentIdentity, sameContentIdentity } from "./mergeContentIdentity.mjs";

let repo = "";
const git = (args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();

const commitTree = (tree: string, parents: string[], date: string) =>
  git(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "m"], {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
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
    const tagSha = makeTag();
    expect(tagSha).not.toBe(merge1);
    expect(() => contentIdentity(repo, tagSha)).toThrow(/is not a commit/);
    expect(() => sameContentIdentity(repo, merge1, tagSha)).toThrow(/is not a commit/);
  });
});

const makeTag = () => {
  git(["tag", "-f", "-a", "-m", "t", "tagged-merge", merge1], {
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  });
  return git(["rev-parse", "tagged-merge"]);
};

describe("merge content identity CLI (subprocess)", () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "mergeContentIdentity.mjs");
  const run = (...args: string[]) =>
    spawnSync("node", [script, "--repo", repo, ...args], { encoding: "utf8" });

  test("identical content exits 0 and prints exactly SAME", () => {
    const r = run("same", merge1, merge2);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("SAME");
  });

  test("different tree exits 1 with no SAME output", () => {
    const other = commitTree(otherTree, [base, head], "2026-03-01T00:00:00Z");
    const r = run("same", merge1, other);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("SAME");
  });

  test("malformed SHA exits 1 with no SAME output", () => {
    const r = run("same", merge1, "not-a-sha");
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("SAME");
  });

  test("bad usage exits 2 with no SAME output", () => {
    const r = run("same", merge1);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("SAME");
  });

  test("an annotated tag is refused with exit 1 and no SAME output", () => {
    const r = run("same", merge1, makeTag());
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("SAME");
  });
});
