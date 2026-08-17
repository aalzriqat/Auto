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
  let dir: string;
  try {
    dir = mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "autoflow-deploy-"));
  } catch (error) {
    return { error: `could not create a temporary directory: ${(error as Error).message}` };
  }

  try {
    // Resolve the commit first, so a bad ref is a clean refusal rather than a
    // half-populated directory.
    const resolved = spawnSync(git, ["rev-parse", "--verify", `${sha}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (resolved.status !== 0) {
      return { error: `${sha} is not a commit in this repository` };
    }

    // A scratch index, inside the throwaway directory's parent, so the
    // operator's own staged changes are untouched.
    const indexFile = path.join(dir, ".autoflow-deploy-index");
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };

    const readTree = spawnSync(git, ["read-tree", resolved.stdout.trim()], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    if (readTree.status !== 0) {
      return { error: `read-tree failed: ${readTree.stderr?.trim() || "unknown error"}` };
    }

    const checkout = spawnSync(
      git,
      ["--work-tree", dir, "checkout-index", "--all", "--force"],
      { cwd: repoRoot, env, encoding: "utf8" }
    );
    if (checkout.status !== 0) {
      return { error: `checkout-index failed: ${checkout.stderr?.trim() || "unknown error"}` };
    }

    // The scratch index has done its job; leaving it behind would put a file in
    // the deployed tree that is not in the commit, which is the exact property
    // this function exists to guarantee.
    rmSync(indexFile, { force: true });

    return { dir };
  } catch (error) {
    return { error: (error as Error).message };
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
