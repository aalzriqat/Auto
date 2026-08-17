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
        `commit_sha must be a full 40-character commit SHA; got ${JSON.stringify(sha)} ` +
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
    return { ok: false, reason: `mode must be "deploy" or "rollback"; got ${JSON.stringify(mode)}.` };
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

  if (!FULL_SHA.test(mainTipSha)) {
    // Fail closed rather than compare against a half-read value: every decision
    // below is relative to the tip, so not knowing it is not a small problem.
    return { ok: false, reason: `Could not read main's tip commit (got ${JSON.stringify(mainTipSha)}).` };
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
};

/**
 * States a backfill can legitimately be passing through, as opposed to states
 * it has landed in.
 *
 * `notStarted` is here rather than in the failure set, and the reason is a real
 * race: `startSocialConversationBackfills` only *schedules* the per-org workers,
 * and the state row is created by the worker itself. Between the fan-out
 * returning and the worker running, an org genuinely reports `notStarted`.
 * Treating that as a failure would fail almost every rollout in its first
 * seconds. The overall poll deadline is what catches a backfill that never
 * actually starts.
 */
const IN_FLIGHT_STATUSES = new Set(["running", "notStarted"]);

/**
 * Classifies one page of the materialisation report.
 *
 * Fails closed everywhere. An unrecognised status is a problem, not a shrug:
 * the alternative is that adding a status to the backend silently widens what
 * this gate accepts, and a gate that accepts unknown states is not a gate.
 */
export function classifyMaterializationReport(orgs: OrgReport[]): Verdict {
  const problems: Problem[] = [];
  const inFlight: Problem[] = [];
  let completedOrgCount = 0;

  for (const org of orgs) {
    const at = (platform: string | null, kind: string, detail: string): Problem => ({
      orgId: org.orgId,
      orgName: org.orgName,
      platform,
      kind,
      detail,
    });

    if (!Array.isArray(org.platforms) || org.platforms.length === 0) {
      problems.push(at(null, "noPlatforms", "The report carried no platform rows for this org."));
      continue;
    }

    let orgSettledHealthy = true;

    for (const p of org.platforms) {
      if (p.duplicateState || p.status === "ambiguous") {
        orgSettledHealthy = false;
        problems.push(
          at(
            p.platform,
            "ambiguous",
            "Two contradictory materialisation state rows exist. No backfill can clear this — " +
              "the writer stands down on it too. A human must delete the wrong row."
          )
        );
        continue;
      }

      if (IN_FLIGHT_STATUSES.has(p.status)) {
        orgSettledHealthy = false;
        inFlight.push(
          at(
            p.platform,
            p.status,
            `${p.processedCount}/${p.expectedCount} events processed, ` +
              `${p.materializedCount} conversations materialised.`
          )
        );
        continue;
      }

      if (p.status === "failed" || p.status === "interrupted") {
        orgSettledHealthy = false;
        problems.push(
          at(
            p.platform,
            p.status,
            p.failureMessage ??
              (p.status === "interrupted"
                ? "The backfill chain stopped advancing and is no longer running."
                : "The backfill reported a failure with no message.")
          )
        );
        continue;
      }

      if (p.status !== "completed") {
        orgSettledHealthy = false;
        problems.push(
          at(p.platform, "unknownStatus", `Unrecognised materialisation status ${JSON.stringify(p.status)}.`)
        );
        continue;
      }

      if (p.generation !== p.expectedGeneration) {
        orgSettledHealthy = false;
        problems.push(
          at(
            p.platform,
            "staleGeneration",
            `Completed at generation ${p.generation}, but the reader expects ${p.expectedGeneration}.`
          )
        );
        continue;
      }

      // ⚠️ THE 2026-08-07 INCIDENT SIGNATURE. On that day the Social Inbox
      // reported zero conversations for an org holding 347 Instagram and 689
      // Facebook events, with no throw and no log, because the reader was
      // pointed at a table whose backfill had never run. A completed backfill
      // over a non-empty event set that produced no conversations at all is
      // that same picture, and it is the one thing "COMPLETED" cannot tell
      // you on its own.
      if (p.expectedCount > 0 && p.materializedCount === 0) {
        orgSettledHealthy = false;
        problems.push(
          at(
            p.platform,
            "emptyMaterialization",
            `Completed over ${p.expectedCount} source events but materialised 0 conversations. ` +
              `This is the shape of the 2026-08-07 incident: a reader switched to a table that ` +
              `has nothing in it.`
          )
        );
      }
    }

    // Checked as well as, not instead of, the per-platform states. It is
    // deliberately redundant: `readerSource` is what the inbox actually keys
    // off, so if it ever stops agreeing with the platform rows, the gate should
    // notice rather than infer.
    if (org.readerSource !== "materialized") {
      if (orgSettledHealthy) {
        problems.push(
          at(
            null,
            "readerSourceContradiction",
            `Every platform reports completed, but the reader still resolves to ` +
              `${JSON.stringify(org.readerSource)}.`
          )
        );
      }
      orgSettledHealthy = false;
    }

    if (orgSettledHealthy) completedOrgCount += 1;
  }

  return {
    ok: problems.length === 0 && inFlight.length === 0 && orgs.length > 0,
    settled: inFlight.length === 0,
    orgCount: orgs.length,
    completedOrgCount,
    inFlight,
    problems,
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
  const heading =
    outcome === "verified"
      ? "✅ Production rollout verified"
      : outcome === "timedOut"
        ? "⏳ Deployed, but the rollout did not finish in time"
        : "❌ Deployed, but the rollout is incomplete";

  const lines = [
    `## ${heading}`,
    "",
    `| | |`,
    `| --- | --- |`,
    `| Mode | \`${mode}\` |`,
    `| Deployed commit | \`${sha}\` |`,
    `| main tip at verification | \`${mainTipSha}\` |`,
    `| Convex deployment | ${deployment ? `\`${deployment}\`` : "_not reported_"} |`,
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
    lines.push("### Still in flight at the deadline", "", "| Organization | Platform | Status | Progress |", "| --- | --- | --- | --- |");
    for (const p of verdict.inFlight) {
      lines.push(`| ${p.orgName} (\`${p.orgId}\`) | ${p.platform ?? "—"} | \`${p.kind}\` | ${p.detail} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
