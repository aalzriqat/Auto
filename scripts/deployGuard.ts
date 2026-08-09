/**
 * Preconditions for a production Convex deploy.
 *
 * ## Why this exists
 *
 * On 2026-08-07 unmerged code and an untracked scratch module were deployed to
 * production. The Social Inbox then reported zero conversations for an org
 * holding over a thousand live events, because the materialised reader shipped
 * ahead of its backfill.
 *
 * ## What the first version of this file got wrong
 *
 * It delegated the final "are you sure this is production" question to Convex,
 * on the strength of having watched the CLI ask it once. Convex asks
 * **conditionally**. Verified with `--dry-run` against the real CLI:
 *
 *   - `CONVEX_DEPLOYMENT=dev:…`  → it prints the prod deployment and asks.
 *   - `CONVEX_DEPLOYMENT=prod:…` → **no prompt at all**; it deploys.
 *   - `CONVEX_DEPLOY_KEY` set    → no prompt (the CI shape).
 *   - neither set                → refuses outright, which is at least safe.
 *
 * A wrapper that prints "Convex will now ask you to confirm" and then does not
 * get asked is worse than no wrapper: it manufactures confidence. So the
 * confirmation is owned here — the operator types the deployment name, and
 * nothing is spawned until they do.
 *
 * The same review found the two rules that mattered were each one small
 * variation from useless: `-vy` slipped past an exact-match check on `-y`
 * (commander expands combined short flags), and a `.gitignore`d file under
 * `convex/` is not "untracked" to `git status`, so it passed the bundle check
 * while Convex would still have bundled it off disk. Both are reproduced in
 * `deployGuard.test.ts`.
 *
 * Rules are pure functions over an injected snapshot so each one is testable
 * without shelling out or touching a deployment. `scripts/deployProd.mjs`
 * gathers the snapshot and owns the side effects.
 */

/** One precondition and how it landed. */
export type DeployCheck = {
  id: string;
  ok: boolean;
  /** Shown to the operator. On failure this must say how to resolve it. */
  detail: string;
};

export type RepoSnapshot = {
  branch: string;
  headSha: string;
  originMainSha: string;
  /** `git merge-base --is-ancestor HEAD origin/main` succeeded. */
  headIsAncestorOfOriginMain: boolean;
  /** Tracked paths with staged or unstaged modifications. */
  trackedChanges: string[];
  /** Deployable files present on disk under `convex/` (see `bundleOffenders`). */
  bundleFilesOnDisk: string[];
  /** `git ls-files convex/` — what is actually committed. */
  trackedBundleFiles: string[];
  /** Arguments the caller intends to forward to `convex deploy`. */
  forwardedArgs: string[];
  /** Deployment-selecting configuration, resolved the way the CLI resolves it. */
  env: { CONVEX_DEPLOYMENT?: string; CONVEX_DEPLOY_KEY?: string; source?: string };
};

export type DeployOptions = {
  /** Deploy a commit that is merged but behind the tip — a deliberate rollback. */
  allowBehind?: boolean;
};

/**
 * The only arguments that may reach `convex deploy`.
 *
 * An allowlist, not a denylist, because a denylist on this CLI was already
 * defeated once. `-y` is undocumented — it appears in neither `convex deploy
 * --help` nor `convex --help` — and commander expands combined short flags, so
 * `-vy` sets both verbose and yes while matching neither `-y` nor `--yes`
 * exactly. Enumerating what is permitted means the next undocumented flag is
 * refused by default rather than discovered by an incident.
 */
export const ALLOWED_DEPLOY_ARGS = new Set([
  "-v",
  "--verbose",
  "--typecheck",
  "--typecheck-components",
  "--codegen",
  "--cmd",
  "--cmd-url-env-var-name",
  "--debug-bundle-path",
]);

/** Values these flags take, which must pass through without being read as flags. */
const ARGS_TAKING_VALUES = new Set([
  "--typecheck",
  "--codegen",
  "--cmd",
  "--cmd-url-env-var-name",
  "--debug-bundle-path",
]);

/**
 * Extensions Convex treats as deployable entry points, from its bundler.
 * Anything with one of these under `convex/` ships.
 */
export const BUNDLED_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
];

function checkForwardedArgs(snapshot: RepoSnapshot): DeployCheck {
  const rejected: string[] = [];
  const args = snapshot.forwardedArgs;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue; // a value for the flag before it
    // `--flag=value` is the same flag as `--flag`.
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!ALLOWED_DEPLOY_ARGS.has(name)) {
      rejected.push(arg);
      continue;
    }
    if (ARGS_TAKING_VALUES.has(name) && !arg.includes("=")) i += 1; // skip its value
  }

  return {
    id: "allowed-args-only",
    ok: rejected.length === 0,
    detail:
      rejected.length === 0
        ? "only known-safe arguments are forwarded"
        : `refusing ${rejected.join(" ")} — only ${[...ALLOWED_DEPLOY_ARGS].join(", ")} may be forwarded. '-y' (and any combined form such as '-vy') suppresses the production confirmation and is never allowed`,
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
 * Deployable files on disk that git does not track.
 *
 * Asking git "what is untracked?" was the wrong question, and the difference is
 * the whole finding: `git status --porcelain` omits **ignored** files, so
 * `convex/fix_probe.js` — matched by `.gitignore`'s unanchored `fix_*.js` —
 * was reported as "nothing untracked under convex/" while Convex would have
 * bundled it off disk. That is strictly more invisible than the module which
 * caused the incident, since even `git status` stays silent.
 *
 * So the comparison is the deployable set on disk against the git index. Also
 * sidesteps porcelain's path quoting, which mangles non-ASCII names
 * (`"conv\303\251x/x.ts"`) and would break a `convex/` prefix test.
 */
export function bundleOffenders(
  onDisk: string[],
  tracked: string[]
): string[] {
  const trackedSet = new Set(tracked.map((p) => p.replace(/\\/g, "/")));
  return onDisk
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => !trackedSet.has(p))
    .sort();
}

function checkBundleIsTracked(snapshot: RepoSnapshot): DeployCheck {
  const offenders = bundleOffenders(
    snapshot.bundleFilesOnDisk,
    snapshot.trackedBundleFiles
  );
  return {
    id: "bundle-is-tracked",
    ok: offenders.length === 0,
    detail:
      offenders.length === 0
        ? "every deployable file under convex/ is tracked by git"
        : `deployable file(s) under convex/ are not in git and would ship unreviewed: ${offenders.join(", ")} — commit or delete them (note: .gitignore does NOT stop Convex bundling them)`,
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
  if (snapshot.headSha === snapshot.originMainSha) {
    return { id: "at-origin-main-tip", ok: true, detail: "HEAD is origin/main" };
  }
  // "Behind" only means something for a commit that is on main. Telling a
  // diverged branch's author to pass --allow-behind is advice that cannot work,
  // because merged-into-main refuses regardless.
  if (!snapshot.headIsAncestorOfOriginMain) {
    return {
      id: "at-origin-main-tip",
      ok: false,
      detail: `HEAD ${snapshot.headSha.slice(0, 8)} has diverged from origin/main ${snapshot.originMainSha.slice(0, 8)} — merge it first; --allow-behind does not apply to unmerged work`,
    };
  }
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
 * usually wants to hear about the stray bundle file in the same breath.
 */
export function evaluateProdDeploy(
  snapshot: RepoSnapshot,
  options: DeployOptions = {}
): { ok: boolean; checks: DeployCheck[]; failures: DeployCheck[] } {
  const checks = [
    checkForwardedArgs(snapshot),
    checkBundleIsTracked(snapshot),
    checkCleanTree(snapshot),
    checkMerged(snapshot),
    checkAtTip(snapshot, options),
  ];
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}

/**
 * The deployment `convex deploy` resolved, read back out of its own dry run.
 *
 * Taken from the CLI's announcement rather than inferred from configuration,
 * because inferring it from `CONVEX_DEPLOYMENT` is precisely the mistake that
 * caused the incident. Returns null when no target line is present, and the
 * caller must treat that as a refusal — a confirmation prompt that cannot name
 * the target is not a confirmation.
 */
export function extractDeploymentName(dryRunOutput: string): string | null {
  // e.g. "▌ └─ https://kindly-hound-172.convex.cloud"
  const url = dryRunOutput.match(/https:\/\/([a-z0-9-]+)\.convex\.cloud/i);
  if (url) return url[1];
  const dash = dryRunOutput.match(/dashboard\.convex\.dev\/t\/[^/]+\/[^/]+\/([a-z0-9-]+)/i);
  return dash ? dash[1] : null;
}

/**
 * Whether the dry run says this is a production deployment.
 *
 * Belt and braces beside the typed confirmation: the operator can mistype
 * their way into agreeing with a name, but they cannot make a preview
 * deployment announce itself as production.
 */
export function looksLikeProduction(dryRunOutput: string): boolean {
  return /\[Production\]|\(prod\)/i.test(dryRunOutput);
}

/**
 * How the environment will steer `convex deploy`, in words.
 *
 * `source` is reported because the CLI loads `.env.local` and `.env` itself, so
 * a value can be in force without appearing in `process.env` — and a deploy key
 * is exactly the case where Convex asks nothing.
 */
export function describeTargetSelection(env: RepoSnapshot["env"]): string {
  const from = env.source ? ` (from ${env.source})` : "";
  if (env.CONVEX_DEPLOY_KEY) {
    return `CONVEX_DEPLOY_KEY is set${from} — the target is whatever deployment that key belongs to, and Convex will NOT prompt in this configuration.`;
  }
  if (env.CONVEX_DEPLOYMENT?.startsWith("prod:")) {
    return `CONVEX_DEPLOYMENT=${env.CONVEX_DEPLOYMENT}${from} — this names production directly, and Convex will NOT prompt when the configured deployment is the target.`;
  }
  if (env.CONVEX_DEPLOYMENT) {
    return `CONVEX_DEPLOYMENT=${env.CONVEX_DEPLOYMENT}${from} is a dev deployment. It does NOT redirect a deploy: 'convex deploy' targets the project's PRODUCTION deployment regardless.`;
  }
  return "Neither CONVEX_DEPLOYMENT nor CONVEX_DEPLOY_KEY is set — the CLI will refuse rather than guess.";
}
