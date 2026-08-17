/**
 * The decisions the production release workflow makes, separated from the I/O
 * that feeds them.
 *
 * Everything here is a pure function over plain data, for one reason learned
 * the hard way on the abandoned local wrapper (PR #219): that script ran a
 * deploy on import, so it could not be imported by a test, so not one line of
 * its argument handling was covered — and a `--rollback-to` with a missing
 * value silently deployed `main`'s tip instead, the exact commit the operator
 * was rolling back away from. Nothing on screen contradicted them, because the
 * confirmation only named a deployment, and the deployment was right.
 *
 * So the rule for this file is that anything capable of being wrong about
 * *which commit ships* or *whether a rollout succeeded* lives here, where a
 * test can call it directly, and the `.mjs` shells stay thin enough to read.
 */

/** What the operator must type to confirm. Exact, and case-sensitive. */
export const PRODUCTION_CONFIRMATION = "DEPLOY TO PRODUCTION";

/**
 * `deploy` ships `main`'s current tip. `rollback` ships an older commit that is
 * still contained in `main`.
 *
 * They are separate modes rather than one input with an optional override
 * because they answer to opposite failure modes: a deploy that is not the tip
 * is usually a stale tab, and a rollback that *is* the tip is a no-op dressed
 * as an incident response.
 */
export type ReleaseMode = "deploy" | "rollback";

export type Refusal = { ok: false; reason: string };

export type ParsedInputs = {
  ok: true;
  /** Lower-cased, exactly 40 hex characters. */
  sha: string;
  mode: ReleaseMode;
};

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * Whether a value is a full commit SHA and nothing else.
 *
 * Exported so callers can prove it BEFORE interpolating a value into a URL
 * path, not merely before deciding with it. Both are needed and they are not
 * the same check at the same moment.
 */
export function isFullSha(value: string | undefined): boolean {
  return typeof value === "string" && FULL_SHA.test(value);
}

/**
 * Whether a GitHub API path is a plain resource path this script may request.
 *
 * Validated at the sink rather than only at each call site, because that is the
 * one place a future caller cannot forget.
 *
 * ⚠️ `..` is refused as a SEGMENT, not as a substring, and the distinction is
 * load-bearing: the compare endpoint's own syntax is
 * `/compare/<sha>...<sha>`, so a naive `path.includes("..")` refuses the very
 * request this script depends on — a guard that breaks the thing it guards.
 * (Caught here by writing the test, which is the point of it being a function.)
 */
export function isSafeApiPath(path: string): boolean {
  if (!/^\/[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(path)) return false;
  // A `..` or `.` of its own would walk out of the repository scope that every
  // other guarantee in this file assumes.
  return !path.split("/").some((segment) => segment === ".." || segment === ".");
}

/**
 * Bounds a value that is about to be written to a log or a run summary.
 *
 * Dispatching this workflow already requires write access, so this is hygiene
 * rather than a security boundary — but an unbounded echo of an arbitrary input
 * into a shared CI log is worth not doing, and truncation costs nothing.
 */
export function forLog(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? JSON.stringify(flat) : `${JSON.stringify(flat.slice(0, max))}…`;
}

/**
 * Validates the three `workflow_dispatch` inputs before anything else happens.
 *
 * ⚠️ Abbreviated SHAs are refused on purpose, and they are the input most
 * likely to be offered in good faith — `git log --oneline` prints them, and
 * `git rev-parse` resolves them happily. An abbreviation is a *query*, not an
 * identity: it names whichever object currently matches, so "deploy exactly
 * this commit" stops being a statement about a commit and becomes a statement
 * about the repository's contents at resolution time. Requiring all 40
 * characters is what makes the rest of this file's guarantees mean anything.
 */
export function parseReleaseInputs(raw: {
  sha: string | undefined;
  confirm: string | undefined;
  mode: string | undefined;
}): ParsedInputs | Refusal {
  const sha = (raw.sha ?? "").trim();
  const confirm = (raw.confirm ?? "").trim();
  const mode = (raw.mode ?? "").trim();

  if (sha === "") return { ok: false, reason: "commit_sha is required." };
  if (!FULL_SHA.test(sha)) {
    return {
      ok: false,
      reason:
        `commit_sha must be a full 40-character commit SHA; got ${forLog(sha)} ` +
        `(${sha.length} characters). Abbreviated SHAs, branch names and tags are refused ` +
        `because they name whatever they resolve to at the time, not one fixed commit.`,
    };
  }

  if (confirm !== PRODUCTION_CONFIRMATION) {
    return {
      ok: false,
      reason: `confirm must be exactly ${JSON.stringify(PRODUCTION_CONFIRMATION)}.`,
    };
  }

  if (mode !== "deploy" && mode !== "rollback") {
    return { ok: false, reason: `mode must be "deploy" or "rollback"; got ${forLog(mode)}.` };
  }

  return { ok: true, sha: sha.toLowerCase(), mode };
}

export type CommitAuthority =
  | { ok: true; mode: ReleaseMode; sha: string; mainTipSha: string }
  | Refusal;

/**
 * Decides whether this commit is one production is allowed to run.
 *
 * The authority is always "contained in `main`" — never "looks reviewed",
 * never "the operator says so". A rollback goes *backwards* along `main`'s
 * history, never sideways to something that was never merged.
 */
export function decideCommitAuthority(input: {
  mode: ReleaseMode;
  sha: string;
  mainTipSha: string;
  commitExists: boolean;
  isAncestorOfMain: boolean;
}): CommitAuthority {
  const { mode, sha, mainTipSha, commitExists, isAncestorOfMain } = input;

  if (!commitExists) {
    return { ok: false, reason: `Commit ${sha} does not exist in this repository.` };
  }

  if (!isFullSha(mainTipSha)) {
    // Fail closed rather than compare against a half-read value: every decision
    // below is relative to the tip, so not knowing it is not a small problem.
    return { ok: false, reason: `Could not read main's tip commit (got ${forLog(mainTipSha)}).` };
  }

  if (!isAncestorOfMain) {
    return {
      ok: false,
      reason:
        `Commit ${sha} is not contained in main. Only commits merged into main may reach ` +
        `production — that is the whole review guarantee this workflow rests on.`,
    };
  }

  if (mode === "deploy" && sha !== mainTipSha) {
    return {
      ok: false,
      reason:
        `Commit ${sha} is not main's current tip (${mainTipSha}). A normal deploy ships the tip; ` +
        `if shipping an older commit is intended, choose the "rollback" mode explicitly.`,
    };
  }

  if (mode === "rollback" && sha === mainTipSha) {
    // ⚠️ This is the regression from PR #219, kept because the shape survives a
    // rewrite: there, a `--rollback-to` whose value went missing fell through to
    // main's tip — deploying the exact commit the operator was rolling back
    // away from, during an incident, while the confirmation prompt showed a
    // deployment name that was entirely correct. A rollback that resolves to the
    // tip is never what was meant, so it refuses instead of proceeding.
    return {
      ok: false,
      reason:
        `Rollback target ${sha} IS main's current tip. That deploys the commit you are rolling ` +
        `back away from. Name the older commit explicitly, or use the "deploy" mode.`,
    };
  }

  return { ok: true, mode, sha, mainTipSha };
}

// ─── Rollout verification ───────────────────────────────────────────────────

export type PlatformReport = {
  platform: string;
  status: string;
  duplicateState: boolean;
  generation: number | null;
  expectedGeneration: number;
  processedCount: number;
  materializedCount: number;
  expectedCount: number;
  failureMessage: string | null;
};

export type OrgReport = {
  orgId: string;
  orgName: string;
  readerSource: string;
  platforms: PlatformReport[];
};

export type Problem = {
  orgId: string;
  orgName: string;
  platform: string | null;
  kind: string;
  detail: string;
};

// ─── Deploy-key shape ───────────────────────────────────────────────────────

export type DeployKeyKind = "prod" | "dev" | "preview" | "project" | "legacy" | "missing";

/**
 * Classifies a Convex deploy key WITHOUT ever revealing it.
 *
 * ⚠️ This exists because of a real, live hazard rather than a hypothetical one.
 * `playwright.yml` already consumes a repository-level secret named
 * `CONVEX_DEPLOY_KEY` on every pull request, using `--cmd-url-env-var-name` —
 * Convex's PREVIEW deploy pattern. A repository secret is visible to every job,
 * so a workflow referencing that name gets it whenever an environment-scoped
 * secret of the same name is absent.
 *
 * The consequence is the 2026-08-07 incident inverted: `convex deploy` with a
 * preview key creates a PREVIEW deployment, the rollout verifier then happily
 * verifies that deployment, every check passes, and the summary reports
 * "Production rollout verified" while production was never touched. It fails
 * OPEN, silently, with a success report — the worst available shape.
 *
 * Renaming the secrets is the primary fix; this is the second lock. The
 * predicates are taken from the installed CLI (convex 1.42.1), not guessed:
 * `isPreviewDeployKey` requires a `preview:<team>:<project>|` prefix,
 * `isProjectKey` is `/^project:.*\|/`, and `isDeploymentKey` is
 * `/^(dev|prod):.*\|/`.
 */
export function classifyDeployKey(rawKey: string | undefined): DeployKeyKind {
  const key = (rawKey ?? "").trim();
  if (key === "") return "missing";

  const [prefix, ...rest] = key.split("|");
  // No `|` at all is Convex's pre-scoping key format. `deploymentTypeFromAdminKey`
  // reports those as "prod", which is exactly the assumption not to inherit here:
  // an unrecognised shape must not be granted the most dangerous meaning.
  if (rest.length === 0) return "legacy";

  const parts = prefix.split(":");
  if (parts[0] === "preview" && parts.length === 3) return "preview";
  if (parts[0] === "project") return "project";
  if (parts[0] === "prod") return "prod";
  if (parts[0] === "dev") return "dev";
  return "legacy";
}

/** Refuses any credential that is not provably scoped to a production deployment. */
export function requireProductionDeployKey(rawKey: string | undefined): { ok: true } | Refusal {
  const kind = classifyDeployKey(rawKey);
  if (kind === "prod") return { ok: true };

  const why: Record<Exclude<DeployKeyKind, "prod">, string> = {
    missing:
      "no deploy key was provided. The production environment's secrets are almost certainly " +
      "not configured — see AGENTS.md. Refusing rather than falling back to anything ambient.",
    preview:
      "this is a PREVIEW deploy key. It would create a preview deployment, and every check " +
      "afterwards would pass against that preview while production went untouched.",
    project:
      "this is a project-scoped key, which does not name a deployment. It can resolve to the " +
      "dev deployment.",
    dev: "this is a DEV deployment key.",
    legacy:
      "this key's format is not recognised as deployment-scoped. Refusing rather than assuming " +
      "it means production.",
  };

  return {
    ok: false,
    reason: `Refusing to deploy: ${why[kind]} (classified as ${JSON.stringify(kind)}; the key itself is never logged).`,
  };
}

export type Verdict = {
  /** Every org is on the materialised path and nothing looks wrong. */
  ok: boolean;
  /**
   * Nothing is still in flight. `false` means "ask again"; it does NOT mean
   * healthy, and the two are kept apart on purpose — a poller that treats
   * "still working" as "fine" is how a half-finished rollout gets signed off.
   */
  settled: boolean;
  orgCount: number;
  completedOrgCount: number;
  inFlight: Problem[];
  problems: Problem[];
  /**
   * Worth a human's eyes, but NOT grounds to fail the rollout — because this
   * gate cannot tell the anomaly apart from a legitimate state with the data it
   * has. Reported loudly, never enforced. See `emptyMaterialization`.
   */
  anomalies: Problem[];
};

/**
 * States that are not a verdict yet, because something is still going to change
 * them without anyone intervening.
 *
 * The rule is REDRIVABILITY, not optimism: a status belongs here exactly when
 * `startSocialConversationBackfills` will act on it.
 *
 * - `notStarted` — the fan-out only *schedules* the per-org workers; the state
 *   row is created by the worker itself, so an org genuinely reports this for a
 *   moment after a rollout begins.
 * - `running` — obviously.
 * - `failed` / `interrupted` — ⚠️ these look terminal and are not. The fan-out
 *   redrives both, and its scheduled worker resets the row only when it runs.
 *   Treating them as terminal meant the FIRST poll saw the pre-existing failure
 *   and aborted the rollout while its own recovery was already queued — so any
 *   org with a stale failed row made every future rollout fail instantly, which
 *   is precisely the state a redrive exists for.
 *
 * `ambiguous` is deliberately NOT here. `startSocialConversationBackfills`
 * skips it unconditionally — no run can repair a contradiction it is not
 * allowed to resolve — so waiting for it to clear would burn the whole deadline
 * on something only a human can fix.
 */
const REDRIVABLE_STATUSES = new Set(["running", "notStarted", "failed", "interrupted"]);

/**
 * Classifies one page of the materialisation report.
 *
 * Fails closed everywhere. An unrecognised status is a problem, not a shrug:
 * the alternative is that adding a status to the backend silently widens what
 * this gate accepts, and a gate that accepts unknown states is not a gate.
 */
type PlatformVerdict =
  | { bucket: "healthy" }
  | { bucket: "inFlight" | "problem" | "anomaly"; kind: string; detail: string };

/** One platform's verdict. Extracted so the org loop stays readable. */
function classifyPlatform(p: PlatformReport): PlatformVerdict {
  if (p.duplicateState || p.status === "ambiguous") {
    return {
      bucket: "problem",
      kind: "ambiguous",
      detail:
        "Two contradictory materialisation state rows exist. No backfill can clear this — the " +
        "writer stands down on it too. A human must delete the wrong row.",
    };
  }

  if (REDRIVABLE_STATUSES.has(p.status)) {
    const progress =
      `${p.processedCount}/${p.expectedCount} events processed, ` +
      `${p.materializedCount} conversations materialised.`;
    return {
      bucket: "inFlight",
      kind: p.status,
      detail: p.failureMessage ? `${p.failureMessage} — awaiting redrive. ${progress}` : progress,
    };
  }

  if (p.status !== "completed") {
    return {
      bucket: "problem",
      kind: "unknownStatus",
      detail: `Unrecognised materialisation status ${JSON.stringify(p.status)}.`,
    };
  }

  // ⚠️ Unreachable through the live data path today, and kept deliberately.
  // `lookupMaterializationState` queries BY the current generation, so a row it
  // returns always carries that generation and a superseded one surfaces as
  // `notStarted` instead. This is defence for a future report that carries more
  // than one generation — it is NOT what protects against a stale generation
  // today, and describing it as such would be an overclaim.
  if (p.generation !== p.expectedGeneration) {
    return {
      bucket: "problem",
      kind: "staleGeneration",
      detail: `Completed at generation ${p.generation}, but the reader expects ${p.expectedGeneration}.`,
    };
  }

  // ⚠️ REPORTED, NOT ENFORCED — and the demotion is the whole point.
  //
  // This started as a hard failure, because it is the shape of the 2026-08-07
  // incident: a reader pointed at a table whose backfill never ran, answering
  // "no conversations" for an org holding 347 Instagram and 689 Facebook
  // events, with no throw and no log.
  //
  // But it cannot tell that apart from a perfectly healthy org.
  // `syncThreadsInBackfillPage` skips every event without a `customerId`
  // (`if (!event.customerId) continue;`), and
  // `socialInboxConversations.test.ts` pins that as correct — "materialising
  // one would put a row in the inbox the list never showed". `expectedCount`
  // meanwhile counts ALL events. So an org whose events are all unlinked ends
  // legitimately `completed` with `expectedCount > 0` and `materializedCount 0`.
  //
  // Failing on that would have been unrecoverable, not merely wrong: the
  // fan-out SKIPS orgs that are already `completed`, so no re-run could ever
  // clear it, and the only escape — `force` — restarts the backfill and drops
  // that org back to the legacy scan. A gate no operator can clear is worse
  // than one that asks a human to look.
  //
  // Making this enforceable needs the backfill to record how many events were
  // materialisABLE, not how many existed. Tracked as follow-up work.
  if (p.expectedCount > 0 && p.materializedCount === 0) {
    return {
      bucket: "anomaly",
      kind: "emptyMaterialization",
      detail:
        `Completed over ${p.expectedCount} source events but materialised 0 conversations. ` +
        `Expected when none of those events are linked to a customer; the shape of the ` +
        `2026-08-07 incident when they are. Worth one look at this org's inbox.`,
    };
  }

  return { bucket: "healthy" };
}

/**
 * Classifies one page of the materialisation report.
 *
 * Fails closed everywhere. An unrecognised status is a problem, not a shrug:
 * the alternative is that adding a status to the backend silently widens what
 * this gate accepts, and a gate that accepts unknown states is not a gate.
 */
type OrgVerdict = {
  settledHealthy: boolean;
  problems: Problem[];
  inFlight: Problem[];
  anomalies: Problem[];
};

/** One organization's verdict, so the page loop is only bookkeeping. */
function classifyOrg(org: OrgReport): OrgVerdict {
  const out: OrgVerdict = { settledHealthy: true, problems: [], inFlight: [], anomalies: [] };
  const at = (platform: string | null, kind: string, detail: string): Problem => ({
    orgId: org.orgId,
    orgName: org.orgName,
    platform,
    kind,
    detail,
  });

  if (!Array.isArray(org.platforms) || org.platforms.length === 0) {
    out.settledHealthy = false;
    out.problems.push(at(null, "noPlatforms", "The report carried no platform rows for this org."));
    return out;
  }

  for (const p of org.platforms) {
    const verdict = classifyPlatform(p);
    if (verdict.bucket === "healthy") continue;

    const entry = at(p.platform, verdict.kind, verdict.detail);
    if (verdict.bucket === "anomaly") {
      // Deliberately does not clear `settledHealthy` — an anomaly is a note,
      // not a verdict.
      out.anomalies.push(entry);
      continue;
    }

    out.settledHealthy = false;
    (verdict.bucket === "inFlight" ? out.inFlight : out.problems).push(entry);
  }

  // Checked as well as, not instead of, the per-platform states. It is
  // deliberately redundant: `readerSource` is what the inbox actually keys off,
  // so if it ever stops agreeing with the platform rows, the gate should notice
  // rather than infer.
  if (org.readerSource !== "materialized") {
    if (out.settledHealthy) {
      out.problems.push(
        at(
          null,
          "readerSourceContradiction",
          `Every platform reports completed, but the reader still resolves to ` +
            `${JSON.stringify(org.readerSource)}.`
        )
      );
    }
    out.settledHealthy = false;
  }

  return out;
}

export function classifyMaterializationReport(orgs: OrgReport[]): Verdict {
  const problems: Problem[] = [];
  const inFlight: Problem[] = [];
  const anomalies: Problem[] = [];
  let completedOrgCount = 0;

  for (const org of orgs) {
    const verdict = classifyOrg(org);
    problems.push(...verdict.problems);
    inFlight.push(...verdict.inFlight);
    anomalies.push(...verdict.anomalies);
    if (verdict.settledHealthy) completedOrgCount += 1;
  }

  return {
    ok: problems.length === 0 && inFlight.length === 0 && orgs.length > 0,
    settled: inFlight.length === 0,
    orgCount: orgs.length,
    completedOrgCount,
    inFlight,
    problems,
    anomalies,
  };
}

/** Merges page verdicts into one, so pagination cannot hide a bad page. */
export function mergeVerdicts(verdicts: Verdict[]): Verdict {
  const problems = verdicts.flatMap((v) => v.problems);
  const inFlight = verdicts.flatMap((v) => v.inFlight);
  const orgCount = verdicts.reduce((n, v) => n + v.orgCount, 0);
  return {
    ok: problems.length === 0 && inFlight.length === 0 && orgCount > 0,
    settled: inFlight.length === 0,
    orgCount,
    completedOrgCount: verdicts.reduce((n, v) => n + v.completedOrgCount, 0),
    inFlight,
    problems,
    anomalies: verdicts.flatMap((v) => v.anomalies),
  };
}

export type PollOutcome = "verified" | "failed" | "continue" | "timedOut";

/**
 * Whether to poll again, and what to conclude if not.
 *
 * A settled-but-unhealthy report ends the poll immediately: waiting does not
 * repair a `failed`, an `interrupted` or a contradictory pair of state rows,
 * and burning the deadline on one only delays the report.
 */
export function decidePollOutcome(input: {
  verdict: Verdict;
  elapsedMs: number;
  timeoutMs: number;
}): PollOutcome {
  const { verdict, elapsedMs, timeoutMs } = input;
  if (verdict.ok) return "verified";
  if (verdict.problems.length > 0) return "failed";
  if (elapsedMs >= timeoutMs) return "timedOut";
  return "continue";
}

/**
 * How long to wait before asking again.
 *
 * Each poll re-walks the whole organization catalog, which is cheap at this
 * tenant count and would stop being cheap at a much larger one — and re-running
 * a full scan every 15 seconds is a poor look for a change whose entire
 * programme is about cutting Convex read volume. So it starts responsive, for
 * the common case where a rollout finishes in the first minutes, then backs off
 * to a rate that costs almost nothing across a long walk.
 */
export function pollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < 2 * 60_000) return 15_000;
  if (elapsedMs < 10 * 60_000) return 30_000;
  return 60_000;
}

/**
 * Reads the JSON a `convex run` invocation printed.
 *
 * Verified against the installed CLI (convex 1.42.1) rather than assumed: the
 * function's return value is printed by `logOutput` → `console.log` → stdout,
 * and on a non-TTY `formatValue` emits `JSON.stringify(value, null, 2)`. Every
 * diagnostic the CLI produces — progress, warnings, failures, deployment log
 * lines — goes through `logToStderr` instead. So stdout is the value and
 * nothing else.
 *
 * It is parsed strictly anyway. If a future CLI ever writes a banner to stdout,
 * the honest outcome is this gate refusing to certify a rollout it can no
 * longer read, not it guessing which line was the answer.
 */
export function parseConvexRunJson(stdout: string): { ok: true; value: unknown } | Refusal {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return { ok: false, reason: "convex run produced no output on stdout." };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason:
        `convex run's stdout was not JSON (${message}). Refusing to guess at a rollout verdict. ` +
        `First 200 characters: ${JSON.stringify(trimmed.slice(0, 200))}`,
    };
  }
}

/** Renders the verdict for `$GITHUB_STEP_SUMMARY`. */
export function renderReleaseSummary(input: {
  mode: ReleaseMode;
  sha: string;
  mainTipSha: string;
  deployment: string | null;
  verdict: Verdict;
  outcome: PollOutcome;
}): string {
  const { mode, sha, mainTipSha, deployment, verdict, outcome } = input;

  const HEADINGS: Record<PollOutcome, string> = {
    verified: "✅ Production rollout verified",
    timedOut: "⏳ Deployed, but the rollout did not finish in time",
    failed: "❌ Deployed, but the rollout is incomplete",
    continue: "❌ Deployed, but the rollout is incomplete",
  };
  const deploymentCell = deployment ? `\`${deployment}\`` : "_not reported_";

  const lines = [
    `## ${HEADINGS[outcome]}`,
    "",
    `| | |`,
    `| --- | --- |`,
    `| Mode | \`${mode}\` |`,
    `| Deployed commit | \`${sha}\` |`,
    `| main tip at verification | \`${mainTipSha}\` |`,
    `| Convex deployment | ${deploymentCell} |`,
    `| Organizations on the materialised path | ${verdict.completedOrgCount}/${verdict.orgCount} |`,
    "",
  ];

  if (outcome !== "verified") {
    lines.push(
      "> **Production is deployed. The rollout is not complete.**",
      "> Do not record SCRUM-21 as closed. The identifiers below are what a follow-up run needs.",
      ""
    );
  }

  if (verdict.problems.length > 0) {
    lines.push("### Problems", "", "| Organization | Platform | Kind | Detail |", "| --- | --- | --- | --- |");
    for (const p of verdict.problems) {
      lines.push(`| ${p.orgName} (\`${p.orgId}\`) | ${p.platform ?? "—"} | \`${p.kind}\` | ${p.detail} |`);
    }
    lines.push("");
  }

  if (verdict.inFlight.length > 0) {
    lines.push(
      "### Still in flight at the deadline",
      "",
      "| Organization | Platform | Status | Progress |",
      "| --- | --- | --- | --- |"
    );
    for (const p of verdict.inFlight) {
      lines.push(`| ${p.orgName} (\`${p.orgId}\`) | ${p.platform ?? "—"} | \`${p.kind}\` | ${p.detail} |`);
    }
    lines.push("");
  }

  if (verdict.anomalies.length > 0) {
    lines.push(
      "### Worth a look (did not fail the rollout)",
      "",
      "These cannot be told apart from a legitimate state with the data this gate has, so they",
      "are reported rather than enforced.",
      "",
      "| Organization | Platform | Kind | Detail |",
      "| --- | --- | --- | --- |"
    );
    for (const p of verdict.anomalies) {
      lines.push(`| ${p.orgName} (\`${p.orgId}\`) | ${p.platform ?? "—"} | \`${p.kind}\` | ${p.detail} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
