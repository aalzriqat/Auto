/**
 * Materialising one commit somewhere nothing else can reach.
 *
 * This is the load-bearing half of the production deploy guard, so it lives in
 * its own module rather than inside `deployProd.mjs`: that file runs a deploy
 * on import, which means anything defined in it can never be tested. The
 * property being claimed here — *the caller's working directory is not an
 * input* — is exactly the kind of claim that has to be demonstrated against a
 * real repository rather than asserted in a comment.
 *
 * ## Why `read-tree` + `checkout-index`, and not archive-through-tar
 *
 * The mechanism is git's own tree export: point a THROWAWAY index at the
 * commit, then have git write that index out into an empty directory. What
 * lands is the commit's tree and nothing else — no `.git`, no ignored files, no
 * untracked files, and no registration in the repository's worktree list.
 *
 * ⚠️ The first implementation piped `git archive` into `tar -x -C <dir>`, and
 * the integration tests below caught it failing on Windows: git-bash's `tar`
 * mangles a native path (`C:\Users\…` arrives as `C\:\\UsersS\\…`) and refuses
 * to open the destination. That matters more than usual here — Windows is the
 * platform the 2026-08-07 incident happened on, so a deploy guard that only
 * works on Linux is a deploy guard that is not there when it is needed. A unit
 * test with a mocked `spawnSync` would have passed happily.
 *
 * `git worktree add --detach` was the other candidate and would also contain
 * only committed content, but it leaves a `.git` link back to the repository
 * and a registration that has to be pruned; this repo already carries twenty-odd
 * worktrees, and a failed cleanup adding more is a real cost.
 *
 * `GIT_INDEX_FILE` is redirected to a scratch path so the operator's own staged
 * changes are never touched. Without it, `read-tree` would overwrite the index
 * of the repository they are working in — a guard that damages the working
 * state it is protecting would not survive first contact.
 *
 * ⚠️ Two specific bypasses this closes, both found by independent review of the
 * previous design, both invisible to a git-status-based check:
 *
 *   - Convex's bundler follows relative imports OUT of `convex/`, and
 *     `createExternalPlugin` returns `null` for any specifier starting with
 *     `.`, so they are never externalised. An untracked file under `lib/` that
 *     a tracked `convex/` module imports therefore shipped.
 *   - esbuild resolves `.tsx` before `.ts`, so an untracked `lib/x.tsx` shadows
 *     a reviewed `lib/x.ts` with nothing tracked having changed at all.
 *
 * Neither is detectable by asking git what changed. Both are impossible against
 * a tree that contains only committed content.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CheckoutResult = { dir: string } | { error: string };

/**
 * Extract `sha` into a brand-new directory and return where it landed.
 *
 * `git` is passed in as an absolute path rather than resolved here: every
 * precondition in this guard is answered by git, so a `PATH`-resolved binary is
 * a single substitution that falsifies all of them at once.
 *
 * A fresh `mkdtemp` per call, never a reused or derived path, so no previous
 * run's leftovers can be inherited and two concurrent deploys cannot collide.
 */
export function createIsolatedCheckout(options: {
  git: string;
  repoRoot: string;
  sha: string;
  /** Overridable so tests do not depend on the machine's temp directory. */
  tmpRoot?: string;
}): CheckoutResult {
  const { git, repoRoot, sha } = options;

  // ── Resolve BEFORE creating anything. The previous version created the
  //    directory first and then lost its path down every error return, because
  //    `CheckoutResult`'s error arm carries no `dir` and the caller's `finally`
  //    only begins after a successful result. Both reviewers found it, and it
  //    was not theoretical: twelve empty `autoflow-deploy-*` directories were
  //    sitting in this machine's temp directory, one per failed test run.
  const resolved = spawnSync(git, ["rev-parse", "--verify", `${sha}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (resolved.status !== 0) {
    return { error: `${sha} is not a commit in this repository` };
  }
  const commit = resolved.stdout.trim();

  // ── Refuse tree shapes this exporter cannot reproduce faithfully.
  //
  // `checkout-index` writes a WORKING TREE, not a byte-for-byte tree export: it
  // applies `text`/`eol`/`ident`/encoding conversion and any configured smudge
  // filter, and it materialises symlinks. The conversions are neutralised below,
  // but two shapes cannot be neutralised and must not be silently mangled:
  //
  //   - a symlink (mode 120000) can point outside the checkout, and Convex
  //     would follow a relative import straight back out to untracked content;
  //   - a gitlink (mode 160000, a submodule) is not materialised at all, so the
  //     deployed tree would be missing source the commit says is there.
  //
  // Neither exists in this repository today. That is exactly why this refuses
  // rather than warns: the day one is committed, a guard that quietly deviated
  // from the commit would be the last thing to notice.
  const tree = spawnSync(git, ["ls-tree", "-r", "-z", "--full-tree", commit], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  if (tree.status !== 0) {
    return { error: `ls-tree failed: ${tree.stderr?.trim() || "unknown error"}` };
  }
  const unsupported: string[] = [];
  let hasGitAttributes = false;
  for (const entry of tree.stdout.split("\0").filter(Boolean)) {
    // "<mode> <type> <object>\t<path>"
    const mode = entry.slice(0, 6);
    const file = entry.slice(entry.indexOf("\t") + 1);
    if (mode === "120000" || mode === "160000") unsupported.push(`${file} (mode ${mode})`);
    if (file === ".gitattributes" || file.endsWith("/.gitattributes")) hasGitAttributes = true;
  }
  if (unsupported.length > 0) {
    return {
      error:
        `the commit contains symlinks or submodules, which this exporter will not reproduce ` +
        `faithfully: ${unsupported.slice(0, 5).join(", ")}${unsupported.length > 5 ? ", …" : ""}`,
    };
  }
  if (hasGitAttributes) {
    // A committed `.gitattributes` can route files through a smudge filter,
    // whose stdout replaces the blob's content wholesale. Refusing is the only
    // honest answer while the export goes through the working-tree machinery.
    return {
      error:
        "the commit contains a .gitattributes, which can route files through smudge filters " +
        "that would substitute content at checkout — this exporter cannot guarantee the " +
        "deployed bytes match the commit while one is present",
    };
  }

  let dir: string;
  try {
    dir = mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "autoflow-deploy-"));
  } catch (error) {
    return { error: `could not create a temporary directory: ${(error as Error).message}` };
  }

  // From here on the directory exists, so every exit removes it.
  let succeeded = false;
  try {
    // A scratch index inside the throwaway directory, so the operator's own
    // staged changes are untouched. ⚠️ This is the load-bearing line: without
    // it, `read-tree` overwrites the index of the repository they are working
    // in. A guard that damages the working state it is protecting would not
    // survive first contact — and until this round no test could tell the
    // difference, because every fixture committed cleanly first.
    const indexFile = path.join(dir, ".autoflow-deploy-index");
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };

    // Conversions off, explicitly, for these invocations only. `core.autocrlf`
    // is true on this machine (globally), and `git ls-files --eol` reports
    // `i/lf w/crlf` for the repository's own sources — so without these the
    // deployed bytes differ from the commit's blobs. It does not change what
    // JavaScript means, but "the deployed tree is the commit" is the claim this
    // whole design rests on, and a claim that is only nearly true is the kind
    // this PR has already been caught making twice.
    const noConvert = [
      "-c", "core.autocrlf=false",
      "-c", "core.eol=lf",
      "-c", "core.symlinks=false",
    ];

    const readTree = spawnSync(git, [...noConvert, "read-tree", commit], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    if (readTree.status !== 0) {
      return { error: `read-tree failed: ${readTree.stderr?.trim() || "unknown error"}` };
    }

    const checkout = spawnSync(
      git,
      [...noConvert, "--work-tree", dir, "checkout-index", "--all", "--force"],
      { cwd: repoRoot, env, encoding: "utf8" }
    );
    if (checkout.status !== 0) {
      return { error: `checkout-index failed: ${checkout.stderr?.trim() || "unknown error"}` };
    }

    // The scratch index has done its job; leaving it behind would put a file in
    // the deployed tree that is not in the commit, which is the exact property
    // this function exists to guarantee.
    rmSync(indexFile, { force: true });

    succeeded = true;
    return { dir };
  } catch (error) {
    return { error: (error as Error).message };
  } finally {
    if (!succeeded) removeIsolatedCheckout(dir);
  }
}

/** Remove a checkout. Called from a `finally`, so it never throws. */
export function removeIsolatedCheckout(dir: string): { removed: boolean; error?: string } {
  try {
    rmSync(dir, { recursive: true, force: true });
    return { removed: true };
  } catch (error) {
    return { removed: false, error: (error as Error).message };
  }
}
