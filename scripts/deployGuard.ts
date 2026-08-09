/**
 * Preconditions for a production Convex deploy.
 *
 * ## Why this exists
 *
 * On 2026-08-07 unmerged code and an untracked scratch module were deployed to
 * production. The Social Inbox then reported zero conversations for an org
 * holding over a thousand live events, because the reader had shipped ahead of
 * its backfill.
 *
 * The tempting lesson was "the CLI hides which deployment it targets". That is
 * false, and worth stating plainly because it changes the fix. `convex deploy`
 * prints the resolved production deployment and then asks:
 *
 *     [Production] aalzriqat:auto:production (prod)  -> kindly-hound-172
 *     You're currently developing against your dev deployment
 *       vibrant-cat-418 (set in CONVEX_DEPLOYMENT)
 *     Do you want to push your code to your prod deployment kindly-hound-172 now?
 *
 * It even names the dev deployment you believed you were targeting, directly
 * beside the production one it is about to write. That prompt would have stopped
 * the incident. It was suppressed by `-y` — an accepted flag that appears in
 * neither `convex deploy --help` nor `convex --help`.
 *
 * So the guard's first job is not to reinvent that confirmation. It is to make
 * `-y` impossible to pass, and to add the checks Convex has no way to make:
 * whether the working tree is clean, whether anything untracked is about to be
 * bundled, and whether this commit is actually merged.
 *
 * Kept as pure functions over an injected snapshot so every rule is testable
 * without shelling out or touching a real deployment. `scripts/deployProd.mjs`
 * collects the snapshot and owns the side effects.
 */

/** One precondition and how it landed. */
export type DeployCheck = {
  id: string;
  ok: boolean;
  /** Shown to the operator. On failure this must say how to resolve it. */
  detail: string;
};

/** Everything the rules need, gathered by the caller. */
export type RepoSnapshot = {
  branch: string;
  headSha: string;
  originMainSha: string;
  /** `git merge-base --is-ancestor HEAD origin/main` succeeded. */
  headIsAncestorOfOriginMain: boolean;
  /** Tracked paths with staged or unstaged modifications. */
  trackedChanges: string[];
  /** Untracked paths, repo-relative, forward-slashed. */
  untrackedPaths: string[];
  /** Arguments the caller intends to forward to `convex deploy`. */
  forwardedArgs: string[];
  /** Ambient deployment-selecting env, for display. */
  env: { CONVEX_DEPLOYMENT?: string; CONVEX_DEPLOY_KEY?: string };
};

export type DeployOptions = {
  /** Deploy a commit that is merged but behind the tip — a deliberate rollback. */
  allowBehind?: boolean;
};

/**
 * Flags that answer Convex's production confirmation on the operator's behalf.
 *
 * `-y` is undocumented, which is precisely why it needs naming here: someone
 * reaching for a non-interactive deploy will not find it in `--help` and will
 * not learn what it turns off. `--yes` is included because an undocumented flag
 * has no contract and its long form may exist or appear later.
 */
export const AUTO_CONFIRM_FLAGS = ["-y", "--yes"] as const;

/** Convex bundles this directory. Anything untracked here ships. */
const BUNDLED_DIR = "convex/";

/**
 * Splits `git status --porcelain=v1` into tracked changes and untracked paths.
 *
 * Lives here rather than in the CLI shell because parsing it wrong is not
 * theoretical: the first version trimmed the command's whole output, which ate
 * the **leading space** that porcelain uses for "unstaged", so `" M package.json"`
 * became `"M package.json"` and the path was reported as `"ackage.json"`. A
 * format with significant leading whitespace does not survive a convenience
 * trim, and the guard's messages are only useful if they name the real file.
 *
 * Pass the raw output with only the trailing newline removed.
 */
export function parsePorcelain(raw: string): {
  trackedChanges: string[];
  untrackedPaths: string[];
} {
  const trackedChanges: string[] = [];
  const untrackedPaths: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.length < 4) continue;
    // Two status columns, then a space, then the path.
    const path = line.slice(3).trim().replace(/\\/g, "/");
    if (!path) continue;
    if (line.startsWith("??")) {
      untrackedPaths.push(path);
    } else {
      // Renames read as "R  old -> new"; the destination is what would deploy.
      const arrow = path.indexOf(" -> ");
      trackedChanges.push(arrow === -1 ? path : path.slice(arrow + 4));
    }
  }

  return { trackedChanges, untrackedPaths };
}

function checkNoAutoConfirm(snapshot: RepoSnapshot): DeployCheck {
  const found = snapshot.forwardedArgs.filter((arg) =>
    (AUTO_CONFIRM_FLAGS as readonly string[]).includes(arg)
  );
  return {
    id: "no-auto-confirm",
    ok: found.length === 0,
    detail:
      found.length === 0
        ? "Convex's production confirmation will be shown"
        : `refusing to pass ${found.join(" ")} — that suppresses the prompt naming the production deployment, which is what turned the 2026-08-07 incident from a question into a deploy`,
  };
}

function checkCleanTree(snapshot: RepoSnapshot): DeployCheck {
  const changed = snapshot.trackedChanges;
  return {
    id: "clean-worktree",
    ok: changed.length === 0,
    detail:
      changed.length === 0
        ? "no tracked modifications"
        : `${changed.length} modified tracked file(s) would deploy uncommitted work: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", …" : ""}`,
  };
}

/**
 * The specific hole that put a scratch probe module on production.
 *
 * `convex deploy` bundles the `convex/` directory from disk, not from git, so an
 * untracked file there is deployed as readily as a committed one — and being
 * untracked, it is invisible to every review, diff and CI check that looked at
 * the change. No escape flag: the fix is to commit the file or delete it, and a
 * bypass on this particular rule would reinstate exactly the failure it exists
 * to prevent.
 */
function checkNoUntrackedBundled(snapshot: RepoSnapshot): DeployCheck {
  const offenders = snapshot.untrackedPaths.filter((p) => p.startsWith(BUNDLED_DIR));
  return {
    id: "no-untracked-in-bundle",
    ok: offenders.length === 0,
    detail:
      offenders.length === 0
        ? `nothing untracked under ${BUNDLED_DIR}`
        : `untracked file(s) under ${BUNDLED_DIR} would be bundled and deployed unreviewed: ${offenders.join(", ")} — commit or delete them`,
  };
}

function checkMerged(snapshot: RepoSnapshot): DeployCheck {
  return {
    id: "merged-into-main",
    ok: snapshot.headIsAncestorOfOriginMain,
    detail: snapshot.headIsAncestorOfOriginMain
      ? `HEAD ${snapshot.headSha.slice(0, 8)} is contained in origin/main`
      : `HEAD ${snapshot.headSha.slice(0, 8)} on '${snapshot.branch}' is not an ancestor of origin/main — this is unmerged code, which is what reached production on 2026-08-07`,
  };
}

function checkAtTip(snapshot: RepoSnapshot, options: DeployOptions): DeployCheck {
  const atTip = snapshot.headSha === snapshot.originMainSha;
  if (atTip) {
    return { id: "at-origin-main-tip", ok: true, detail: "HEAD is origin/main" };
  }

  // "Behind" only means something for a commit that is actually on main. A
  // diverged branch is not behind the tip, it is somewhere else entirely, and
  // telling its author to pass --allow-behind is advice that cannot work:
  // `merged-into-main` would still refuse. Naming the state wrongly is how a
  // guard teaches people to reach for the wrong flag.
  if (!snapshot.headIsAncestorOfOriginMain) {
    return {
      id: "at-origin-main-tip",
      ok: false,
      detail: `HEAD ${snapshot.headSha.slice(0, 8)} has diverged from origin/main ${snapshot.originMainSha.slice(0, 8)} — merge it first; --allow-behind does not apply to unmerged work`,
    };
  }

  // A rollback deploys an older, already-merged commit on purpose. Allowed, but
  // never by default and never silently — the operator has to say so.
  return {
    id: "at-origin-main-tip",
    ok: options.allowBehind === true,
    detail: options.allowBehind
      ? `deploying ${snapshot.headSha.slice(0, 8)}, behind origin/main ${snapshot.originMainSha.slice(0, 8)} (--allow-behind)`
      : `HEAD ${snapshot.headSha.slice(0, 8)} is behind origin/main ${snapshot.originMainSha.slice(0, 8)} — pass --allow-behind if this is a deliberate rollback`,
  };
}

/**
 * Every precondition, in the order an operator should read them.
 *
 * Runs them all rather than short-circuiting: someone whose tree is dirty
 * usually wants to know about the untracked bundle file in the same breath,
 * not one failure per attempt.
 */
export function evaluateProdDeploy(
  snapshot: RepoSnapshot,
  options: DeployOptions = {}
): { ok: boolean; checks: DeployCheck[]; failures: DeployCheck[] } {
  const checks = [
    checkNoAutoConfirm(snapshot),
    checkNoUntrackedBundled(snapshot),
    checkCleanTree(snapshot),
    checkMerged(snapshot),
    checkAtTip(snapshot, options),
  ];
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}

/**
 * How the ambient environment will steer `convex deploy`, in words.
 *
 * Printed before anything runs because this is the sentence the incident turned
 * on: `CONVEX_DEPLOYMENT=dev:…` reads like a dev target and is not one.
 */
export function describeTargetSelection(env: RepoSnapshot["env"]): string {
  if (env.CONVEX_DEPLOY_KEY) {
    return "CONVEX_DEPLOY_KEY is set — the target is whatever deployment that key belongs to (this is the CI shape).";
  }
  if (env.CONVEX_DEPLOYMENT) {
    return `CONVEX_DEPLOYMENT=${env.CONVEX_DEPLOYMENT} is set. It does NOT redirect a deploy: 'convex deploy' targets the project's PRODUCTION deployment regardless of the dev deployment named here.`;
  }
  return "Neither CONVEX_DEPLOYMENT nor CONVEX_DEPLOY_KEY is set — the CLI will resolve the project's production deployment.";
}
