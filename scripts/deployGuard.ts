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
 * ## What the SECOND version got wrong, and why the trust model changed
 *
 * It validated the developer's working tree — clean tree, every deployable file
 * under `convex/` tracked by git — and then let the CLI bundle from that same
 * mutable directory. That is a **proxy** for what ships, and two independent
 * reviews (Codex and a Claude-family seat, separately) each proved the proxy
 * incomplete:
 *
 *   - Convex's bundler follows relative imports OUT of `convex/`. Real modules
 *     do this today (`convex/aggregates.ts` imports `../lib/vinHelpers`,
 *     `convex/financingEconomics.ts` imports `../lib/financingEconomics`), and
 *     `createExternalPlugin` in the CLI bundle returns `null` for any specifier
 *     starting with `.`, so relative imports are never externalised. An
 *     untracked file under `lib/` therefore shipped while the guard reported a
 *     clean tree and a fully tracked bundle.
 *   - Worse, no new import was even needed. esbuild resolves `.tsx` BEFORE
 *     `.ts` (measured against the installed 0.27.0), so an untracked
 *     `lib/vinHelpers.tsx` SHADOWS the reviewed `lib/vinHelpers.ts` and
 *     replaces production logic with nothing tracked having changed at all.
 *   - And the re-validation that was supposed to close the timing window ran
 *     BEFORE a second dry run, leaving a fresh gap between the last check and
 *     the push in which a file could appear.
 *
 * All three are the same defect wearing different clothes: **the guard checked
 * git state instead of checking the artifact.**
 *
 * So the artifact is now the thing that is controlled. The approved commit is
 * extracted into a brand-new directory, its own locked dependencies are
 * installed there, and the CLI that pushes is the one inside it. Nothing in the
 * caller's worktree — untracked, ignored, shadowing, or written a millisecond
 * after the checks pass — is read at any point. The timing window closes not by
 * being re-checked but by ceasing to exist.
 *
 * ⚠️ What this still does NOT buy, stated plainly because the previous version
 * of this file was punished for overclaiming: `npx convex deploy` still exists
 * and this wrapper cannot stop anyone reaching for it. The production
 * credential is on developer machines. Making production unreachable from a
 * workstation is a CI-mediated deploy against a protected environment, and that
 * is a separate change this file does not attempt.
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
  /**
   * The exact full commit that will be deployed, decided once by the shell
   * before anything is prepared and never re-derived from a mutable ref.
   *
   * For a normal release this is `origin/main`'s tip. A rollback names an older
   * merged commit explicitly. Everything downstream — the isolated checkout,
   * the confirmation text, the push — is bound to this string, so "which source
   * went to production" has one answer that cannot drift mid-run.
   */
  approvedSha: string;
  /** `git merge-base --is-ancestor HEAD origin/main` succeeded. */
  headIsAncestorOfOriginMain: boolean;
  /** The same question asked of `approvedSha`, which is what actually ships. */
  approvedIsAncestorOfOriginMain: boolean;
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
    // ⚠️ The REASON for this check inverted when the isolated checkout landed,
    // and the message has to say the true one. Untracked files can no longer
    // ship — the deploy reads a clean extract of the approved commit, not this
    // directory. What they can now do is the opposite: silently NOT ship, while
    // the operator believes work in front of them is going out. Both are
    // surprises worth refusing on; only one of them used to be possible.
    detail:
      offenders.length === 0
        ? "every deployable file under convex/ is tracked by git"
        : `deployable file(s) under convex/ are not committed, so they will NOT be deployed even though they are in front of you: ${offenders.join(", ")} — commit or delete them (note: .gitignore hides them from git status, not from this check)`,
  };
}

function checkMerged(snapshot: RepoSnapshot): DeployCheck {
  // ⚠️ Judges `approvedSha`, not HEAD. What ships is the approved commit
  // extracted into an isolated checkout; the caller may be sitting on any
  // branch at the time and it has no bearing on the artifact.
  const short = snapshot.approvedSha.slice(0, 8);
  return {
    id: "merged-into-main",
    ok: snapshot.approvedIsAncestorOfOriginMain,
    detail: snapshot.approvedIsAncestorOfOriginMain
      ? `${short} is contained in origin/main`
      : `${short} is not an ancestor of origin/main — this is unmerged code, which is what reached production on 2026-08-07`,
  };
}

function checkAtTip(snapshot: RepoSnapshot, options: DeployOptions): DeployCheck {
  const short = snapshot.approvedSha.slice(0, 8);
  const tip = snapshot.originMainSha.slice(0, 8);
  if (snapshot.approvedSha === snapshot.originMainSha) {
    return { id: "at-origin-main-tip", ok: true, detail: `${short} is origin/main` };
  }
  // "Behind" only means something for a commit that is on main. Telling a
  // diverged branch author to pass --allow-behind is advice that cannot work,
  // because merged-into-main refuses regardless.
  if (!snapshot.approvedIsAncestorOfOriginMain) {
    return {
      id: "at-origin-main-tip",
      ok: false,
      detail: `${short} has diverged from origin/main ${tip} — merge it first; --allow-behind does not apply to unmerged work`,
    };
  }
  return {
    id: "at-origin-main-tip",
    ok: options.allowBehind === true,
    detail: options.allowBehind
      ? `deploying ${short}, behind origin/main ${tip} (--allow-behind, deliberate rollback)`
      : `${short} is behind origin/main ${tip} — pass --allow-behind if this is a deliberate rollback`,
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
export type CanonicalTarget =
  | { kind: "ok"; name: string; label: string; url: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; found: { label: string; name: string }[] };

/**
 * The bar the CLI prefixes every announcement line with (U+258C), and the
 * `└─` elbow (U+2514 U+2500) that introduces the URL line.
 */
const ANNOUNCE_TAG = /^\s*▌\s*\[([A-Za-z]+)\]\s/;
const ANNOUNCE_URL = /^\s*▌\s*└─\s*(https:\/\/([a-z0-9-]+)\.convex\.cloud)\/?\s*$/i;

/**
 * The one deployment this dry run announced, or a refusal.
 *
 * ## Why this replaced two whole-string scans
 *
 * The previous pair — `extractDeploymentName` and `looksLikeProduction` — each
 * scanned the ENTIRE captured output independently and unanchored, taking the
 * first `https://<name>.convex.cloud` anywhere and testing for `[Production]`
 * or `(prod)` anywhere. Nothing required the two to come from the same
 * announcement, or from an announcement at all.
 *
 * Reproduced against the shipped code, no mutation:
 *
 *     "Deploy message: routine hotfix, see (prod) notes at
 *      https://decoy-name.convex.cloud/docs"
 *     "▌ Deploying code to deployment:"
 *     "▌ [Production] … (dashboard: …/kindly-hound-172)"
 *     "▌ └─ https://kindly-hound-172.convex.cloud"
 *
 * gave `decoy-name` / `true`. The operator would be asked to type `decoy-name`
 * while the push went to `kindly-hound-172` — defeating the single safety
 * property this wrapper exists to provide. `--message` is on the forwardable
 * allowlist and is unvalidated free text, so operator-supplied text does reach
 * the captured stream.
 *
 * ⚠️ The double dry run could never have caught it: both runs receive identical
 * arguments, so both extract the same wrong name and the equality check that is
 * supposed to bind the confirmation compares a wrong value with itself.
 *
 * ## What "canonical" means here
 *
 * `formatTargetedDeployment` in the CLI bundle emits, at colour level 0 (which
 * the dry run forces with `NO_COLOR`), a tag line and its URL line adjacently:
 *
 *     ▌ [Production] aalzriqat:auto:production (prod) (dashboard: …)
 *     ▌ └─ https://kindly-hound-172.convex.cloud
 *
 * So a record is a `▌ [Label]` line whose IMMEDIATE successor is a `▌ └─ URL`
 * line, and both the label and the name come from that one matched pair. Prose
 * cannot form a record, because prose does not carry the bar-and-elbow frame on
 * two consecutive lines.
 *
 * ## Exactly one, or refuse
 *
 * `announceDeploymentTarget` is reached once per deploy — the headered call
 * sites are the mutually exclusive preview and existing-deployment branches,
 * and the header-less ones are local-deployment paths. So more than one record
 * means the output is not what this parser was built to read, and the guard
 * must not pick a winner. Failing closed on ambiguity is the same rule the
 * materialisation readiness gate uses, and for the same reason: choosing
 * between two candidates is exactly where a guard silently chooses wrong.
 */
export function parseCanonicalTarget(dryRunOutput: string): CanonicalTarget {
  const lines = dryRunOutput.split(/\r?\n/);
  const found: { label: string; name: string; url: string }[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const tag = ANNOUNCE_TAG.exec(lines[i]);
    if (!tag) continue;
    const url = ANNOUNCE_URL.exec(lines[i + 1]);
    if (!url) continue;
    found.push({ label: tag[1], name: url[2], url: url[1] });
  }

  if (found.length === 0) return { kind: "missing" };
  if (found.length > 1) {
    return { kind: "ambiguous", found: found.map(({ label, name }) => ({ label, name })) };
  }
  return { kind: "ok", ...found[0] };
}

/** The label the CLI prints for a production deployment, at colour level 0. */
export const PRODUCTION_LABEL = "Production";

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
 * The prose deliberately says nothing about what the CLI will do — not where a
 * deploy would land, and not which variable it will act on. Every defect here
 * has been a sentence whose subject is the CLI: "targets the project's
 * PRODUCTION deployment regardless" is false for a preview deploy key, and "the
 * CLI acts on one of them" is false for the self-hosted pair, which is selected
 * by two variables together, and for `CONVEX_DEPLOYMENT` alongside a self-hosted
 * variable, where the CLI acts on none of them and crashes instead.
 *
 * Statements about this wrapper are safe: they are verifiable against code in
 * this repository and cannot be invalidated by a Convex release.
 *
 * Per-key origins matter because the CLI loads `.env.local` and `.env` on its
 * own: a value can be in force without ever appearing in `process.env`.
 */
export function describeTargetSelection(env: RepoSnapshot["env"]): string {
  // `undefined` is absent; `""` is present and empty, which is a different
  // state the operator needs to see — it is an own property, so it stops the
  // CLI's dotenv from loading the same variable out of a file.
  const set = FROZEN_DEPLOY_ENV_KEYS.filter((key) => env[key] !== undefined);

  const lines = set.map((key) => {
    const origin = env.sources?.[key] ? ` (from ${env.sources[key]})` : "";
    const shown = env[key] === "" ? '= ""' : SECRET_SELECTORS.has(key) ? "set" : `= ${env[key]}`;
    return `  ${key} ${shown}${origin}`;
  });

  return [
    "Deployment selection the CLI will read:",
    // The empty case gets the same prose as every other, rather than an early
    // return of its own. That early return was the last sentence predicting the
    // CLI ("the CLI will refuse rather than guess"), and being a separate branch
    // is what kept it out of the invariance test that would have caught it.
    ...(lines.length > 0 ? lines : ["  (none set)"]),
    "More than one of these can be set; this wrapper does not guess which the CLI",
    "will act on. It deploys to production only: the target below is read back from",
    "the CLI's own dry run, and one that does not announce itself as production is",
    "refused.",
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
    if (parsed[key] !== undefined) out[key] = parsed[key];
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

  // Presence is `!== undefined`, not truthiness. An empty string is a present
  // value: `dotenv.populate` gates on `hasOwnProperty`, so `CONVEX_DEPLOYMENT=""`
  // in the shell stops the CLI loading that variable from a file at all, and the
  // CLI then reads it as unset. Treating `""` as absent here resolved the file's
  // value instead and froze it into the child — so the wrapper would deploy to a
  // deployment the bare CLI would have refused to pick.
  for (const key of FROZEN_DEPLOY_ENV_KEYS) {
    if (processEnv[key] !== undefined) {
      values[key] = processEnv[key];
      origins[key] = "process env";
    }
  }
  for (const file of files) {
    const parsed = selectorsFromEnvFile(file.text);
    for (const key of FROZEN_DEPLOY_ENV_KEYS) {
      if (values[key] === undefined && parsed[key] !== undefined) {
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
  /**
   * Materialise the approved commit into a brand-new directory containing only
   * that commit's tracked content, and return where it landed.
   *
   * The contract this must satisfy is the whole point of the redesign: nothing
   * in the caller's worktree — untracked, ignored, shadowing, or written a
   * moment later — may appear in the returned directory.
   */
  prepareIsolatedCheckout: (sha: string) => { dir: string } | { error: string };
  /** Install the approved commit's own locked dependency set, inside `dir`. */
  installDependencies: (dir: string) => { status: number; output: string };
  runDryRun: (
    cliPath: string,
    cwd: string,
    args: string[],
    env: FrozenDeployEnv
  ) => { status: number | null; output: string; errorMessage?: string };
  runDeploy: (cliPath: string, cwd: string, args: string[], env: FrozenDeployEnv) => number;
  /** Remove the isolated checkout. Called from a `finally`, so it must not throw. */
  cleanupCheckout: (dir: string) => void;
  /** Whether `dir` contains an installed Convex CLI at the expected path. */
  cliExists: (cliPath: string) => boolean;
  prompt: (question: string) => Promise<string>;
  isTTY: boolean;
  log: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Where the Convex CLI lives inside a prepared checkout.
 *
 * Always resolved against the isolated directory, never against the caller's
 * repo and never through `PATH`: the binary that pushes must come from the
 * approved commit's own locked dependency set. `npx` is not used, so nothing
 * can substitute a downloaded CLI mid-deploy.
 *
 * Forward slashes only — this string is compared in tests and printed to the
 * operator, and a separator that changes by platform makes both worse.
 */
export function convexCliPath(dir: string): string {
  return `${dir.replaceAll("\\", "/").replace(/\/+$/, "")}/node_modules/convex/bin/main.js`;
}

/**
 * Runs the dry run and reads the target back, or returns the exit code to stop on.
 *
 * Split out so the sequence above reads as the list of gates it is.
 */
function resolveTarget(
  io: DeployIO,
  snapshot: RepoSnapshot,
  env: FrozenDeployEnv,
  cliPath: string,
  cwd: string
): { target: string; output: string } | number {
  io.log("Resolving the target deployment (dry run, nothing is applied)\u2026\n");
  const dry = io.runDryRun(cliPath, cwd, dryRunArgs(snapshot.forwardedArgs), env);
  io.log(dry.output);
  if (dry.errorMessage) io.error(`\nCould not run the dry run: ${dry.errorMessage}`);
  if (dry.status !== 0) {
    io.error("\nDry run failed. Not deploying.\n");
    return dry.status ?? 1;
  }

  const parsed = parseCanonicalTarget(dry.output);
  if (parsed.kind === "missing") {
    io.error(
      "\nCould not read a deployment announcement out of the dry run. Refusing:\n" +
        "a confirmation that cannot name the target is not a confirmation.\n"
    );
    return 1;
  }
  if (parsed.kind === "ambiguous") {
    // Never pick a winner. Two announcements mean the output is not the shape
    // this parser was built to read, and guessing is how a guard confirms one
    // deployment while pushing to another.
    io.error(
      `\nRefusing: the dry run announced ${parsed.found.length} deployments, not one:\n` +
        parsed.found.map((f) => `  [${f.label}] ${f.name}`).join("\n") +
        "\nNothing was pushed.\n"
    );
    return 1;
  }
  // `deploy:prod` means production. Previously this only decorated a log line,
  // so the command would happily push to whatever the dry run resolved. A label
  // is not a gate. The label now comes from the same matched record as the
  // name, so it cannot be satisfied by unrelated text elsewhere in the output.
  if (parsed.label !== PRODUCTION_LABEL) {
    io.error(
      `\nRefusing: the resolved target ${parsed.name} announced itself as ` +
        `[${parsed.label}], not [${PRODUCTION_LABEL}],\n` +
        "and this command deploys to production only. Nothing was pushed.\n"
    );
    return 1;
  }
  return { target: parsed.name, output: dry.output };
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

  // ── Everything past here runs against an isolated checkout, never the
  //    caller's worktree. See the module header for why.
  const prepared = io.prepareIsolatedCheckout(snapshot.approvedSha);
  if ("error" in prepared) {
    io.error(`\nCould not prepare an isolated checkout. Refusing:\n  ${prepared.error}\n`);
    return 1;
  }
  const dir = prepared.dir;

  try {
    io.log(
      `\nPrepared an isolated checkout of ${snapshot.approvedSha.slice(0, 12)}\n` +
        `  ${dir}\n` +
        "Only this commit's tracked content is present. Nothing in your working\n" +
        "tree — untracked, ignored, or written from here on — can reach production.\n"
    );

    const install = io.installDependencies(dir);
    if (install.status !== 0) {
      io.error(
        `\nThe frozen dependency install failed in the isolated checkout. Refusing:\n${install.output}\n`
      );
      return 1;
    }

    // The CLI that pushes is the approved commit's own, installed from its own
    // lockfile, addressed absolutely. Not `npx`, not `PATH`, not the caller's
    // node_modules.
    const cliPath = convexCliPath(dir);
    if (!io.cliExists(cliPath)) {
      io.error(
        `\nNo Convex CLI at ${cliPath} after the install. Refusing:\n` +
          "the deploy must run the approved commit's own CLI, not one resolved elsewhere.\n"
      );
      return 1;
    }

    const resolved = resolveTarget(io, snapshot, frozenEnv, cliPath, dir);
    if (typeof resolved === "number") return resolved;
    const { target } = resolved;

    // Both halves of what is about to happen, together, immediately above the
    // prompt: which deployment, and which commit. Naming only the deployment
    // let an operator confirm "yes, production" without ever being shown which
    // source was going there — and shipping the wrong source to the right
    // deployment is exactly the 2026-08-07 incident.
    io.log(
      `\nAbout to deploy\n` +
        `  commit      ${snapshot.approvedSha}\n` +
        `  deployment  ${target}  [${PRODUCTION_LABEL}]\n\n` +
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

    // Resolve the target a second time, from the same isolated checkout, and
    // require it to be the one that was confirmed.
    //
    // ⚠️ What this check is and is not. It is NOT a re-validation of the
    // filesystem — that question is now answered by construction, because the
    // directory being deployed cannot change: it holds one commit's content and
    // no process writes to it. The previous design re-checked the worktree here
    // and then ran another dry run before pushing, which reopened the very
    // window the re-check existed to close; an independent review reproduced a
    // file appearing in that gap and still reaching `runDeploy`.
    //
    // What remains worth re-checking is the TARGET, because deployment
    // selection is read from the environment by each CLI process. The frozen
    // env makes that stable, and this proves it rather than asserting it.
    const reresolved = resolveTarget(io, snapshot, frozenEnv, cliPath, dir);
    if (typeof reresolved === "number") return reresolved;
    if (reresolved.target !== target) {
      io.error(
        `\nThe target changed after you confirmed it: you approved ${target}, but the\n` +
          `deploy now resolves to ${reresolved.target}. Nothing was pushed.\n`
      );
      return 1;
    }

    return io.runDeploy(cliPath, dir, deployArgs(snapshot.forwardedArgs), frozenEnv);
  } finally {
    // Unconditional. A refusal, a throw, or a successful push all leave the
    // machine without a stray copy of the repository lying around, and a
    // cleanup failure must never mask the deploy's own outcome.
    io.cleanupCheckout(dir);
  }
}
