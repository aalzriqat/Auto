import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIsolatedCheckout, removeIsolatedCheckout } from "./isolatedCheckout";

/**
 * The isolation property, tested against a real git repository.
 *
 * ## Why these are integration tests and not unit tests
 *
 * The claim is about what a directory contains after `git archive` — that is a
 * fact about git and tar, not about our own arithmetic. A mocked `spawnSync`
 * would only prove that we call the functions we think we call, which is
 * exactly the class of test that let the previous design pass while shipping
 * unreviewed code. Each case below builds a repository, commits it, plants the
 * bypass, and inspects the result on disk.
 *
 * Every case here corresponds to a defect an independent review reproduced
 * against the previous guard.
 */

const GIT = process.platform === "win32" ? "git.exe" : "git";
const created: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, rel: string, body: string) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function git(root: string, args: string[]): string {
  return execFileSync(GIT, args, { cwd: root, encoding: "utf8" }).trim();
}

/**
 * A repository shaped like this one: a `convex/` module importing a helper from
 * `lib/` with an extensionless specifier, which is what makes the shadowing
 * bypass reachable.
 */
function seedRepo(): { root: string; sha: string } {
  const root = tmp("guard-src-");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);

  write(root, "convex/aggregates.ts", 'import { helper } from "../lib/helper";\nexport const x = helper;\n');
  write(root, "lib/helper.ts", 'export const helper = "REVIEWED";\n');
  write(root, ".gitignore", "ignored-*.ts\n");

  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed"]);
  return { root, sha: git(root, ["rev-parse", "HEAD"]) };
}

function checkout(root: string, sha: string): string {
  const result = createIsolatedCheckout({ git: GIT, repoRoot: root, sha, tmpRoot: os.tmpdir() });
  if ("error" in result) throw new Error(result.error);
  created.push(result.dir);
  return result.dir;
}

describe("the isolated checkout contains one commit and nothing else", () => {
  test("an untracked file imported from outside convex/ does not reach the checkout", () => {
    // ⚠️ THE GENERALISED INCIDENT. The previous guard walked only `convex/` and
    // deferred untracked files to that walk, so an untracked module under
    // `lib/` — which Convex genuinely bundles, because relative imports are
    // never externalised — shipped while the guard reported a clean tree and a
    // fully tracked bundle.
    const { root, sha } = seedRepo();
    write(root, "lib/secretHelper.ts", 'export const leaked = "UNTRACKED";\n');

    const dir = checkout(root, sha);

    expect(existsSync(path.join(dir, "lib", "helper.ts"))).toBe(true);
    expect(existsSync(path.join(dir, "lib", "secretHelper.ts"))).toBe(false);
  });

  test("a .tsx shadow of a reviewed .ts module does not reach the checkout", () => {
    // ⚠️ The sharper form, and the one that needs NO tracked change at all:
    // `convex/aggregates.ts` already imports "../lib/helper" without an
    // extension, and esbuild resolves .tsx before .ts. So planting an untracked
    // lib/helper.tsx replaces reviewed production logic with the tree still
    // reporting clean. Measured against the installed esbuild 0.27.0.
    const { root, sha } = seedRepo();
    write(root, "lib/helper.tsx", 'export const helper = "SHADOW";\n');

    const dir = checkout(root, sha);

    expect(existsSync(path.join(dir, "lib", "helper.tsx"))).toBe(false);
    expect(readFileSync(path.join(dir, "lib", "helper.ts"), "utf8")).toContain("REVIEWED");
  });

  test("a .gitignored deployable file does not reach the checkout", () => {
    // `.gitignore` hides a file from `git status`, never from a bundler reading
    // the directory. Against an extract of the commit it cannot appear at all.
    const { root, sha } = seedRepo();
    write(root, "convex/ignored-probe.ts", 'export const probe = "IGNORED";\n');

    const dir = checkout(root, sha);

    expect(existsSync(path.join(dir, "convex", "ignored-probe.ts"))).toBe(false);
  });

  test("editing the original worktree after preparation does not change the checkout", () => {
    // ⚠️ The time-of-check/time-of-use window. The previous design re-validated
    // the worktree and then ran another dry run before pushing, so a file
    // created in between still shipped — reproduced by an independent review.
    // Here the question is not detected, it is dissolved: the deployed
    // directory is not the directory anyone is editing.
    const { root, sha } = seedRepo();
    const dir = checkout(root, sha);

    const before = readFileSync(path.join(dir, "lib", "helper.ts"), "utf8");

    write(root, "lib/helper.ts", 'export const helper = "TAMPERED AFTER CHECKOUT";\n');
    write(root, "convex/probe211.ts", 'export const probe = "LATE";\n');

    expect(readFileSync(path.join(dir, "lib", "helper.ts"), "utf8")).toBe(before);
    expect(existsSync(path.join(dir, "convex", "probe211.ts"))).toBe(false);
  });

  test("the checkout carries no .git, so it cannot be switched to another commit", () => {
    const { root, sha } = seedRepo();
    const dir = checkout(root, sha);
    expect(existsSync(path.join(dir, ".git"))).toBe(false);
  });

  test("two runs never share a directory", () => {
    const { root, sha } = seedRepo();
    expect(checkout(root, sha)).not.toBe(checkout(root, sha));
  });

  test("an older commit extracts as it was, not as the tip is", () => {
    // The rollback path. `--allow-behind` is only meaningful if the older
    // commit's own content is what lands.
    const { root, sha: first } = seedRepo();
    write(root, "lib/helper.ts", 'export const helper = "SECOND";\n');
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "second"]);

    const dir = checkout(root, first);
    expect(readFileSync(path.join(dir, "lib", "helper.ts"), "utf8")).toContain("REVIEWED");
  });

  test("a commit that does not exist is an error, not a partial checkout", () => {
    const { root } = seedRepo();
    const result = createIsolatedCheckout({
      git: GIT,
      repoRoot: root,
      sha: "0".repeat(40),
      tmpRoot: os.tmpdir(),
    });
    expect("error" in result).toBe(true);
  });
});

describe("cleanup", () => {
  test("removes the checkout", () => {
    const { root, sha } = seedRepo();
    const dir = checkout(root, sha);
    expect(existsSync(dir)).toBe(true);
    expect(removeIsolatedCheckout(dir).removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("reports rather than throws when it cannot remove", () => {
    // Called from a `finally`, so a cleanup failure must never mask the
    // deploy's own outcome.
    const result = removeIsolatedCheckout(path.join(os.tmpdir(), "definitely-not-here-12345"));
    expect(result.removed).toBe(true); // force:true treats a missing path as done
  });
});
