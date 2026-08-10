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
import { parseEnv } from "node:util";

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
  env: {
    CONVEX_DEPLOYMENT?: string;
    CONVEX_DEPLOY_KEY?: string;
    CONVEX_DEPLOYMENT_TOKEN?: string;
    CONVEX_SELF_HOSTED_URL?: string;
    CONVEX_SELF_HOSTED_ADMIN_KEY?: string;
    /** Where each set variable was read from, keyed by variable name. */
    sources?: Partial<Record<SelectorKey, string>>;
  };
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
  // Long form only: `convex deploy` declares "--message <message>" and
  // registers no `-m`, so advertising one would fail the dry run.
  "--message",
]);

/**
 * `--cmd`, `--cmd-url-env-var-name` and `--debug-bundle-path` are deliberately
 * NOT allowlisted.
 *
 * They ran arbitrary code and undid the guard's central check. From the CLI's
 * own help, `convex deploy` runs in this order:
 *
 *   1. Run a command if specified with `--cmd`
 *   2. Typecheck   3. Regenerate   4. Bundle   5. Push
 *
 * The bundle is read from disk at step 4, after `--cmd` has already run at step
 * 1 — and after every precondition this guard evaluated, because those all
 * happen before the CLI is spawned at all. So an allowed `--cmd` could write
 * `convex/anything.ts` and have it shipped, which is precisely the
 * untracked-module failure the guard exists to prevent, reintroduced through a
 * flag the guard itself permitted.
 *
 * Not fixable by inspecting the command string: any shell string can reach a
 * writer. The flag has to go. A production deploy of Convex functions does not
 * need a build step — the web build is Vercel's — and CI's own use of `--cmd`
 * is a separate raw invocation with a deploy key, not this wrapper. If a build
 * command is ever genuinely required here, the wrapper must run it itself,
 * before the final validation, and then deploy without `--cmd`.
 *
 * `--debug-bundle-path` is the same class of flag, and is refused for the same
 * reason the allowlist exists. It is hidden from `--help` (`.hideHelp()` in the
 * CLI's option registration), it writes files — the directory is created and
 * filled with `fullConfig.json` plus one `.js` per bundled module — and, worst
 * of the three, it makes the CLI log "Wrote bundle and metadata … Skipping rest
 * of push." and **exit 0 without deploying**. A wrapper that reports success on
 * a deploy that never happened is the "merged is not deployed" failure with a
 * green checkmark on it. Nothing about a production push needs it.
 */
const ARGS_TAKING_VALUES = new Set(["--typecheck", "--codegen", "--message"]);

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

/**
 * Splits the forwarded arguments into what was rejected and why.
 *
 * Separated from the message building so each half stays readable; the scan is
 * the part that has to be right.
 */
function scanForwardedArgs(args: string[]): {
  rejected: string[];
  flagShapedValues: string[];
} {
  const rejected: string[] = [];
  const flagShapedValues: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue; // a value for the flag before it
    // `--flag=value` is the same flag as `--flag`.
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!ALLOWED_DEPLOY_ARGS.has(name)) {
      rejected.push(arg);
      continue;
    }
    if (!ARGS_TAKING_VALUES.has(name) || arg.includes("=")) continue;

    // Skipping the value unconditionally would let `--cmd -y` carry `-y`
    // through as a "value". Convex binds it as the option's argument rather
    // than as auto-confirm, so it is not a live bypass — but a rule that reads
    // as one should not be left to be trusted by inspection.
    const value = args[i + 1];
    if (value?.startsWith("-")) flagShapedValues.push(`${arg} ${value}`);
    i += 1;
  }

  return { rejected, flagShapedValues };
}

function checkForwardedArgs(snapshot: RepoSnapshot): DeployCheck {
  const { rejected, flagShapedValues } = scanForwardedArgs(snapshot.forwardedArgs);

  // Two different reasons, two different sentences. Reporting a flag-shaped
  // value under "only these may be forwarded" contradicts itself when the flag
  // itself IS on the list — `--cmd -y` is refused for its value, not its name.
  const reasons: string[] = [];
  if (rejected.length > 0) {
    reasons.push(
      `refusing ${rejected.join(" ")} — only ${[...ALLOWED_DEPLOY_ARGS].join(", ")} may be forwarded. '-y' (and any combined form such as '-vy') suppresses the production confirmation and is never allowed`
    );
  }
  if (flagShapedValues.length > 0) {
    reasons.push(
      `refusing ${flagShapedValues.join(", ")} — the value looks like a flag, so what it does cannot be read from the command line`
    );
  }

  return {
    id: "allowed-args-only",
    ok: reasons.length === 0,
    detail: reasons.length === 0 ? "only known-safe arguments are forwarded" : reasons.join("; "),
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
  const normalise = (p: string) => p.replaceAll("\\", "/");
  const trackedSet = new Set(tracked.map(normalise));
  return onDisk
    .map(normalise)
    .filter((p) => !trackedSet.has(p))
    // Explicit comparator. These are file paths, so a stable byte ordering is
    // what is wanted — locale-aware collation would reorder a deploy refusal by
    // the operator's language, which is not a property a refusal should have.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
 * Arguments for the dry run that resolves the target.
 *
 * Two flags are added here and nowhere else, both inert because a dry run is
 * evaluated by the server and never applied:
 *
 *   `-y` — Convex asks its production question *before* it branches on
 *   `--dry-run`, so without this the operator answers the same alarming prompt
 *   twice and the first answer decides nothing. That is how a prompt becomes a
 *   reflex, which is the dynamic that produced habitual `-y`.
 *
 *   `--allow-deleting-large-indexes` — the index-deletion confirmation runs on
 *   the dry run too, and it crashes rather than prompts when stdin is not a TTY
 *   (which it is not, because the output is captured to read the target back).
 *   Without this, any schema change dropping an index on a table over 100k rows
 *   dead-ends `pnpm deploy:prod` entirely and the operator's only way forward is
 *   the unguarded raw CLI — at the riskiest possible moment.
 *
 * Neither reaches `deployArgs`. The real deploy gets an inherited TTY, so
 * Convex's genuine index-deletion prompt still fires there.
 */
export function dryRunArgs(forwarded: string[]): string[] {
  return ["deploy", "--dry-run", "-y", "--allow-deleting-large-indexes", ...forwarded];
}

/** Arguments for the real deploy. Deliberately carries no confirmation bypass. */
export function deployArgs(forwarded: string[]): string[] {
  return ["deploy", ...forwarded];
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
  const url = /https:\/\/([a-z0-9-]+)\.convex\.cloud/i.exec(dryRunOutput);
  if (url) return url[1];
  const dash = /dashboard\.convex\.dev\/t\/[^/]+\/[^/]+\/([a-z0-9-]+)/i.exec(dryRunOutput);
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

/** Variables whose value must never be printed. */
const SECRET_SELECTORS = new Set<SelectorKey>([
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
]);

/**
 * What is set, and where each value came from. An inventory, not a prediction.
 *
 * This used to state which variable would win and whether Convex would prompt —
 * a second implementation of the CLI's `getDeploymentSelectionFromEnv`,
 * maintained by reading a bundled file. It was wrong twice: once by omitting
 * `CONVEX_DEPLOYMENT_TOKEN` entirely, and once by putting the self-hosted branch
 * ahead of the deploy key and treating the URL alone as decisive when the CLI
 * requires both halves of the pair. Each time it printed a confident false
 * sentence immediately above a production push, which is precisely the
 * manufactured confidence this wrapper exists to remove.
 *
 * Predicting the CLI's branch order buys nothing: the guard already reads the
 * authoritative target back out of the CLI's own dry run, twice, and that is
 * what binds. So the inventory lines are the only environment-dependent output,
 * and the prose that follows them describes this wrapper's own behaviour rather
 * than the CLI's — a claim that cannot go stale when the CLI changes.
 *
 * The prose deliberately says nothing about where `convex deploy` would land.
 * An earlier version asserted it "targets the project's PRODUCTION deployment
 * regardless", which is false for a preview deploy key: the CLI's own help says
 * a preview key deploys to a preview deployment, and `kind === "preview"` routes
 * to `deployToNewPreviewDeployment`. That is the same defect one more time —
 * a sentence about the CLI's behaviour, written from a model of it.
 *
 * Per-key origins matter because the CLI loads `.env.local` and `.env` on its
 * own: a value can be in force without ever appearing in `process.env`.
 */
export function describeTargetSelection(env: RepoSnapshot["env"]): string {
  const set = FROZEN_DEPLOY_ENV_KEYS.filter((key) => env[key]);
  if (set.length === 0) {
    return "None of the deployment-selecting variables is set — the CLI will refuse rather than guess.";
  }

  const lines = set.map((key) => {
    const origin = env.sources?.[key] ? ` (from ${env.sources[key]})` : "";
    const shown = SECRET_SELECTORS.has(key) ? "set" : `= ${env[key]}`;
    return `  ${key} ${shown}${origin}`;
  });

  return [
    "Deployment selection the CLI will read:",
    ...lines,
    "More than one of these can be set; the CLI acts on one of them, and this",
    "wrapper does not guess which. It deploys to production only: the target below",
    "is read back from the CLI's own dry run, and one that does not announce itself",
    "as production is refused.",
  ].join("\n");
}

/**
 * Reads the selecting variables out of one `.env` file's contents.
 *
 * A leading BOM is stripped first. `parseEnv` keeps it inside the first key, so
 * a `.env.local` written by PowerShell 5.1 (`Out-File -Encoding UTF8` emits one)
 * yields `"﻿CONVEX_DEPLOYMENT"` and the real key reads as unset. That used
 * to be harmless — an unset selector was left `undefined` and the child's own
 * dotenv picked the value up off disk. It is no longer harmless: an unset
 * selector is now pinned to `""`, which is an own property the child's dotenv
 * refuses to overwrite, so the CLI would refuse with "No CONVEX_DEPLOYMENT set"
 * on a file it can read perfectly well itself. That turns a cosmetic parser gap
 * into `pnpm deploy:prod` failing where `npx convex deploy` succeeds — the worst
 * possible incentive for a guard whose only power is being used.
 */
export function selectorsFromEnvFile(text: string): Partial<Record<SelectorKey, string>> {
  const parsed = parseEnv(text.startsWith("﻿") ? text.slice(1) : text);
  const out: Partial<Record<SelectorKey, string>> = {};
  for (const key of FROZEN_DEPLOY_ENV_KEYS) {
    if (parsed[key]) out[key] = parsed[key];
  }
  return out;
}

/**
 * The selection the CLI will make, resolved from the same sources in the same
 * order: `process.env` first, then `.env.local`, then `.env` — because
 * `dotenv.config` never overrides a variable that is already set.
 *
 * Every set variable gets its own origin, so the operator can be pointed at the
 * exact file to edit without this code having to decide which variable the CLI
 * will act on.
 */
export function resolveSelectors(
  processEnv: Record<string, string | undefined>,
  files: { name: string; text: string }[]
): RepoSnapshot["env"] {
  const values: Partial<Record<SelectorKey, string>> = {};
  const origins: Partial<Record<SelectorKey, string>> = {};

  for (const key of FROZEN_DEPLOY_ENV_KEYS) {
    if (processEnv[key]) {
      values[key] = processEnv[key];
      origins[key] = "process env";
    }
  }
  for (const file of files) {
    const parsed = selectorsFromEnvFile(file.text);
    for (const key of FROZEN_DEPLOY_ENV_KEYS) {
      if (!values[key] && parsed[key]) {
        values[key] = parsed[key];
        origins[key] = file.name;
      }
    }
  }

  // Every origin is reported, rather than picking one "deciding" variable.
  // Choosing the decider meant modelling the CLI's branch order, which is the
  // thing that kept being wrong; showing all of them needs no such model.
  return { ...values, sources: origins };
}

/** Everything the flow touches that is not a pure decision. */
/**
 * The deployment-selecting variables, pinned for the whole run.
 *
 * Both dry runs and the real deploy are separate CLI processes that each
 * resolve their own target from the ambient environment — and each re-reads
 * `.env.local` then `.env` from disk as it starts. Pinning the selection means
 * an edit to those files between the confirmation and the push cannot silently
 * redirect the deploy.
 *
 * Every variable the CLI consults must be listed, because a missing one is not
 * neutral — it is ambient. `CONVEX_DEPLOYMENT_TOKEN` is the sharp case: the CLI
 * reads the deploy key as `CONVEX_DEPLOY_KEY || CONVEX_DEPLOYMENT_TOKEN` and
 * evaluates that branch *before* `CONVEX_DEPLOYMENT`, so leaving it unfrozen
 * lets it outrank the variable this type does freeze.
 *
 * The freeze narrows the surface; it is not by itself what makes the target
 * binding. The second dry run is — it reads the same disk the real push will.
 */
export type FrozenDeployEnv = {
  CONVEX_DEPLOYMENT?: string;
  CONVEX_DEPLOY_KEY?: string;
  CONVEX_DEPLOYMENT_TOKEN?: string;
  CONVEX_SELF_HOSTED_URL?: string;
  CONVEX_SELF_HOSTED_ADMIN_KEY?: string;
};

/**
 * The variables above, as a list, so the freeze and the child environment
 * cannot drift apart.
 */
export const FROZEN_DEPLOY_ENV_KEYS = [
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
] as const;

export type SelectorKey = (typeof FROZEN_DEPLOY_ENV_KEYS)[number];

/**
 * Freezes the selection out of a snapshot's environment.
 *
 * Unset variables become `""` rather than being left out. Node omits an
 * `undefined` value from a spawned child's environment entirely, which would
 * let the child's own `dotenv` load a value from disk for it — the exact
 * substitution this freeze exists to prevent. The CLI's `getEnv` treats `""` as
 * unset, and `dotenv` does not overwrite a key already present, so an empty
 * string reads as "not set" while still shadowing the file.
 */
export function freezeDeployEnv(env: RepoSnapshot["env"]): FrozenDeployEnv {
  const frozen: Record<string, string> = {};
  for (const key of FROZEN_DEPLOY_ENV_KEYS) frozen[key] = env[key] ?? "";
  return frozen;
}

export type DeployIO = {
  collectSnapshot: () => RepoSnapshot;
  runDryRun: (
    args: string[],
    env: FrozenDeployEnv
  ) => { status: number | null; output: string; errorMessage?: string };
  runDeploy: (args: string[], env: FrozenDeployEnv) => number;
  prompt: (question: string) => Promise<string>;
  isTTY: boolean;
  log: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Runs the dry run and reads the target back, or returns the exit code to stop on.
 *
 * Split out so the sequence above reads as the list of gates it is.
 */
function resolveTarget(
  io: DeployIO,
  snapshot: RepoSnapshot,
  env: FrozenDeployEnv
): { target: string; output: string } | number {
  io.log("Resolving the target deployment (dry run, nothing is applied)\u2026\n");
  const dry = io.runDryRun(dryRunArgs(snapshot.forwardedArgs), env);
  io.log(dry.output);
  if (dry.errorMessage) io.error(`\nCould not run the dry run: ${dry.errorMessage}`);
  if (dry.status !== 0) {
    io.error("\nDry run failed. Not deploying.\n");
    return dry.status ?? 1;
  }

  const target = extractDeploymentName(dry.output);
  if (!target) {
    io.error(
      "\nCould not read the target deployment out of the dry run. Refusing:\n" +
        "a confirmation that cannot name the target is not a confirmation.\n"
    );
    return 1;
  }
  // `deploy:prod` means production. Previously this only decorated a log line,
  // so the command would happily push to whatever the dry run resolved. A label
  // is not a gate.
  if (!looksLikeProduction(dry.output)) {
    io.error(
      `\nRefusing: the resolved target ${target} does not announce itself as production,\n` +
        "and this command deploys to production only. Nothing was pushed.\n"
    );
    return 1;
  }
  return { target, output: dry.output };
}

/**
 * The enforcement sequence, with its side effects injected.
 *
 * This lives here rather than in the CLI shell because the shell is where the
 * previous round's real defect was: the pure rules were fine while the
 * orchestration delegated the confirmation to a prompt that does not always
 * appear, and printed that it would. Every step below is one line away from
 * silently deploying — `-y` leaking into the real argv, the null-target
 * short-circuit going missing, the TTY refusal inverting, the typed comparison
 * loosening — and none of that was reachable by a test while it lived in a
 * `.mjs` that exported nothing.
 *
 * Returns the process exit code. Never throws for a refusal; refusals are
 * ordinary non-zero returns so the caller cannot mistake one for a crash.
 */
export async function runGuardedDeploy(
  io: DeployIO,
  options: DeployOptions = {}
): Promise<number> {
  const snapshot = io.collectSnapshot();
  const first = evaluateProdDeploy(snapshot, options);

  io.log("\nProduction deploy preconditions\n");
  for (const check of first.checks) {
    io.log(`  ${check.ok ? "ok  " : "FAIL"}  ${check.id}: ${check.detail}`);
  }
  io.log(`\n${describeTargetSelection(snapshot.env)}\n`);

  if (!first.ok) {
    io.error(
      `Refusing to deploy: ${first.failures.length} precondition(s) failed. Nothing was pushed.\n`
    );
    return 1;
  }

  // Pinned once and used for every child process below, so the target the
  // operator confirms is the target that is resolved again at push time.
  const frozenEnv = freezeDeployEnv(snapshot.env);

  const resolved = resolveTarget(io, snapshot, frozenEnv);
  if (typeof resolved === "number") return resolved;
  const { target, output: dryOutput } = resolved;

  io.log(
    `\nTarget: ${target}${looksLikeProduction(dryOutput) ? "  [PRODUCTION]" : ""}\n` +
      "Convex does not reliably prompt for this — it stays silent when CONVEX_DEPLOYMENT\n" +
      "already names the target, and when a deploy key is set. So confirm here.\n"
  );

  // Fail closed with no terminal: an unattended run must never self-confirm.
  if (!io.isTTY) {
    io.error("Refusing: no interactive terminal to confirm the target. Nothing was pushed.\n");
    return 1;
  }

  const typed = (await io.prompt("Type the deployment name to deploy to it: ")).trim();
  if (typed !== target) {
    io.error(`\nGot "${typed}", expected "${target}". Nothing was pushed.\n`);
    return 1;
  }

  // Re-validate immediately before pushing. The dry run and the human pause can
  // take minutes, and the bundle is read from disk at push time, not at check
  // time — a file created in that window would otherwise ship unexamined.
  const recheckSnapshot = io.collectSnapshot();
  const recheck = evaluateProdDeploy(recheckSnapshot, options);
  if (!recheck.ok) {
    io.error("\nThe working tree changed while confirming. Refusing:\n");
    for (const check of recheck.checks) {
      io.error(`  ${check.ok ? "ok  " : "FAIL"}  ${check.id}: ${check.detail}`);
    }
    return 1;
  }

  // Resolve the target a second time and require it to be the one that was
  // confirmed.
  //
  // Confirming a name and then letting a fresh CLI process resolve its own
  // target independently is a promise the guard was not keeping: the real
  // deploy re-reads the deployment selection, so a change between the
  // confirmation and the push could send it somewhere else. The preconditions
  // do not catch this either — none of them reads the environment.
  //
  // This is the check that actually makes the confirmed target binding: it is a
  // fresh CLI process reading the same disk the real push will read a moment
  // later. Reuses the recheck's snapshot rather than collecting a third — the
  // only field read is `forwardedArgs`, which cannot change mid-run, and
  // collecting again would run another `git fetch` after the operator has
  // already confirmed, adding a failure surface for no information.
  const reresolved = resolveTarget(io, recheckSnapshot, frozenEnv);
  if (typeof reresolved === "number") return reresolved;
  if (reresolved.target !== target) {
    io.error(
      `\nThe target changed after you confirmed it: you approved ${target}, but the\n` +
        `deploy now resolves to ${reresolved.target}. Nothing was pushed.\n`
    );
    return 1;
  }

  return io.runDeploy(deployArgs(snapshot.forwardedArgs), frozenEnv);
}
