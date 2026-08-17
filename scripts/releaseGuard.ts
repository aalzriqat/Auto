/**
 * The decisions the production release workflow makes, separated from the I/O
 * that feeds them.
 *
 * Everything here is a pure function over plain data, for one reason learned
 * the hard way on the abandoned local wrapper (PR #219): that script ran a
 * deploy on import, so it could not be imported by a test, so not one line of
 * its argument handling was covered — and a `--rollback-to` with a missing
 * value silently deployed `main`'s tip instead, the exact commit the operator
 * was rolling back away from.
 *
 * So the rule for this file is that anything capable of being wrong about
 * *which commit ships*, *which deployment it ships to*, or *whether a rollout
 * succeeded* lives here, where a test can call it directly, and the `.mjs`
 * shells stay thin enough to read.
 *
 * ⚠️ This repository is PUBLIC, and so are its Actions logs and job summaries.
 * Nothing built here may carry a tenant's name, a raw document id, or backend
 * error text. See `opaqueOrgRef`.
 */
import { createHash } from "node:crypto";

/** What the operator must type to confirm. Exact, and case-sensitive. */
export const PRODUCTION_CONFIRMATION = "DEPLOY TO PRODUCTION";

export type Refusal = { ok: false; reason: string };

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
 * ⚠️ `..` is refused as a SEGMENT, not as a substring, and the distinction is
 * load-bearing: the compare endpoint's own syntax is `/compare/<sha>...<sha>`,
 * so a naive `path.includes("..")` refuses the very request this script depends
 * on — a guard that breaks the thing it guards.
 */
export function isSafeApiPath(path: string): boolean {
  if (!/^\/[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(path)) return false;
  return !path.split("/").some((segment) => segment === ".." || segment === ".");
}

/** Bounds a value that is about to be written to a log or a run summary. */
export function forLog(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? JSON.stringify(flat) : `${JSON.stringify(flat.slice(0, max))}…`;
}

/**
 * A stable, non-reversible handle for one organization.
 *
 * ⚠️ This repository is public, which makes every Actions log and job summary
 * public with it. Printing a tenant's name — or the document id that addresses
 * their data — publishes the customer list of a dealership platform to anyone
 * who opens the run. A hash is enough for what the log is actually for:
 * correlating the same org across polls and across runs.
 *
 * Whoever needs to know WHICH dealership this is looks at the `/admin`
 * materialisation screen, which is authenticated and already exists for exactly
 * that question.
 */
export function opaqueOrgRef(orgId: string): string {
  return `org-${createHash("sha256").update(orgId).digest("hex").slice(0, 10)}`;
}

// ─── Inputs and commit authority ────────────────────────────────────────────

export type ParsedInputs = { ok: true; sha: string };

/**
 * Validates the `workflow_dispatch` inputs before anything else happens.
 *
 * ⚠️ Abbreviated SHAs are refused on purpose, and they are the input most
 * likely to be offered in good faith — `git log --oneline` prints them, and
 * `git rev-parse` resolves them happily. An abbreviation is a *query*, not an
 * identity: it names whichever object currently matches, so "deploy exactly
 * this commit" stops being a statement about a commit and becomes a statement
 * about the repository's contents at resolution time.
 */
export function parseReleaseInputs(raw: {
  sha: string | undefined;
  confirm: string | undefined;
}): ParsedInputs | Refusal {
  const sha = (raw.sha ?? "").trim();
  const confirm = (raw.confirm ?? "").trim();

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

  return { ok: true, sha: sha.toLowerCase() };
}

export type CommitAuthority = { ok: true; sha: string; mainTipSha: string } | Refusal;

/**
 * Decides whether this commit is one production is allowed to run.
 *
 * The authority is always `main`'s current tip — never "looks reviewed", never
 * "the operator says so".
 *
 * ⚠️ There is deliberately NO rollback mode. An earlier revision had one, and
 * it could only ever deploy a commit that predates this verification tooling:
 * the rollout script and the Convex function it calls would both be absent from
 * the tree and from the backend it had just deployed, so the run would report
 * success having verified nothing. Rolling back is a forward revert commit,
 * merged to `main` and deployed through this same path with the full checks.
 * Versioned rollback compatibility is separate work.
 */
export function decideCommitAuthority(input: {
  sha: string;
  mainTipSha: string;
  commitExists: boolean;
  isAncestorOfMain: boolean;
}): CommitAuthority {
  const { sha, mainTipSha, commitExists, isAncestorOfMain } = input;

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

  if (sha !== mainTipSha) {
    return {
      ok: false,
      reason:
        `Commit ${sha} is not main's current tip (${mainTipSha}). This workflow deploys the tip. ` +
        `To undo something, merge a revert and deploy that.`,
    };
  }

  return { ok: true, sha, mainTipSha };
}

// ─── Deploy-key identity ────────────────────────────────────────────────────

export type DeployKeyKind = "prod" | "dev" | "preview" | "project" | "malformed" | "missing";

export type DeployKeyTarget = { kind: DeployKeyKind; deployment: string | null };

/**
 * Classifies a Convex deploy key and names the deployment it addresses, WITHOUT
 * ever revealing the key.
 *
 * The predicates come from the installed CLI (convex 1.42.1) rather than from
 * memory: `isPreviewDeployKey` requires a `preview:<team>:<project>|` prefix,
 * `isProjectKey` is `/^project:.*\|/`, and `isDeploymentKey` is
 * `/^(dev|prod):.*\|/` — so a deployment key's prefix is `<type>:<name>`.
 *
 * ⚠️ A key with no `|` at all is Convex's pre-scoping format, and the CLI's
 * `deploymentTypeFromAdminKey` reports those as `"prod"`. That is exactly the
 * assumption not to inherit: an unrecognised shape must not be granted the most
 * dangerous meaning.
 */
export function parseDeployKeyTarget(rawKey: string | undefined): DeployKeyTarget {
  const key = (rawKey ?? "").trim();
  if (key === "") return { kind: "missing", deployment: null };

  const [prefix, ...rest] = key.split("|");
  if (rest.length === 0) return { kind: "malformed", deployment: null };

  const parts = prefix.split(":");
  if (parts[0] === "preview" && parts.length === 3) return { kind: "preview", deployment: null };
  if (parts[0] === "project") return { kind: "project", deployment: null };

  if (parts[0] === "prod" || parts[0] === "dev") {
    // `prod:` with no name, or `prod:a:b`, is not a shape whose target can be
    // read — and a target that cannot be read must never be assumed correct.
    if (parts.length !== 2 || parts[1].trim() === "") {
      return { kind: "malformed", deployment: null };
    }
    return { kind: parts[0], deployment: parts[1].trim() };
  }

  return { kind: "malformed", deployment: null };
}

/** Convenience wrapper kept for readability at call sites. */
export function classifyDeployKey(rawKey: string | undefined): DeployKeyKind {
  return parseDeployKeyTarget(rawKey).kind;
}

const KIND_REASONS: Record<Exclude<DeployKeyKind, "prod">, string> = {
  missing:
    "no key was provided. The production environment's secrets are almost certainly not " +
    "configured — see AGENTS.md. Refusing rather than falling back to anything ambient.",
  preview:
    "this is a PREVIEW deploy key. It would create a preview deployment, and every check " +
    "afterwards would pass against that preview while production went untouched.",
  project:
    "this is a project-scoped key, which does not name a deployment. It can resolve to the " +
    "dev deployment.",
  dev: "this is a DEV deployment key.",
  malformed:
    "the key's shape is not a readable deployment-scoped key. Refusing rather than assuming " +
    "it means production.",
};

/**
 * Requires both credentials to address one exact, named production deployment.
 *
 * ⚠️ Checking only that a key is `prod`-scoped is not enough, and this is the
 * failure the whole workflow exists to prevent wearing a different hat: a valid
 * production key for the WRONG project deploys, verifies and reports success
 * there, exactly as confidently as it would for the right one. The 2026-08-07
 * incident was a targeting error, not an authorisation one.
 *
 * The two keys are also required to agree with each other. If the deploy key
 * pointed at one deployment and the operator key at another, the workflow would
 * deploy to the first and verify the second — and report the second's health as
 * though it were the first's.
 */
export function requireBoundProductionKey(
  rawKey: string | undefined,
  expectedDeployment: string | undefined,
  label: string
): { ok: true; deployment: string } | Refusal {
  const expected = (expectedDeployment ?? "").trim();
  if (expected === "") {
    return {
      ok: false,
      reason:
        "CONVEX_PROD_DEPLOYMENT is not set. This workflow will not act on a deployment it cannot " +
        "name in advance.",
    };
  }

  const target = parseDeployKeyTarget(rawKey);
  if (target.kind !== "prod") {
    return { ok: false, reason: `Refusing: for the ${label}, ${KIND_REASONS[target.kind]}` };
  }
  if (target.deployment !== expected) {
    return {
      ok: false,
      reason:
        `Refusing: the ${label} addresses deployment ${forLog(String(target.deployment))}, but this ` +
        `repository expects ${forLog(expected)}. A valid production key for the wrong deployment ` +
        `would deploy, verify and report success there.`,
    };
  }
  return { ok: true, deployment: expected };
}

/**
 * Both credentials, checked together where both are available.
 *
 * The hazard being closed is real: if the deploy key pointed at one deployment
 * and the operator key at another, the workflow would deploy to the first and
 * verify the second, then report the second's health as though it were the
 * first's — a green run over an unexamined production deployment.
 *
 * ⚠️ But the final equality check below is UNREACHABLE as written, and saying
 * so is the honest version. Both keys are compared against the same
 * `expectedDeployment`, so two keys that each pass have already been proven
 * equal to each other; mutation testing confirmed no test can distinguish its
 * presence. It is kept as a cheap invariant against a future edit that gives
 * the two credentials different expectations, and it is NOT what protects
 * against mismatched keys today — the per-key comparison is.
 */
export function requireBoundProductionKeys(input: {
  deployKey: string | undefined;
  operatorKey: string | undefined;
  expectedDeployment: string | undefined;
}): { ok: true; deployment: string } | Refusal {
  const deploy = requireBoundProductionKey(input.deployKey, input.expectedDeployment, "deploy key");
  if (!deploy.ok) return deploy;
  const operator = requireBoundProductionKey(input.operatorKey, input.expectedDeployment, "operator key");
  if (!operator.ok) return operator;
  if (deploy.deployment !== operator.deployment) {
    return {
      ok: false,
      reason: `Refusing: the deploy key and the operator key address different deployments.`,
    };
  }
  return deploy;
}

/**
 * Confirms the deployment that answered is the one that was meant.
 *
 * Asked of the deployment itself rather than scraped from the CLI's output:
 * Convex exposes `CONVEX_CLOUD_URL` inside the function runtime, so the backend
 * states its own identity over the same connection the verification uses. A log
 * line can be stale, reformatted or absent; this cannot be any of those and
 * still return an answer.
 */
export function assertDeploymentIdentity(
  reportedCloudUrl: string | null | undefined,
  expectedDeployment: string
): { ok: true } | Refusal {
  if (!reportedCloudUrl) {
    return {
      ok: false,
      reason:
        "The deployment did not report its own URL, so its identity cannot be confirmed. " +
        "Refusing to certify a rollout on a deployment that will not say which one it is.",
    };
  }
  const match = /^https:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/i.exec(reportedCloudUrl.trim());
  if (!match) {
    return { ok: false, reason: `Unrecognised deployment URL ${forLog(reportedCloudUrl)}.` };
  }
  if (match[1] !== expectedDeployment) {
    return {
      ok: false,
      reason:
        `The deployment that answered is ${forLog(match[1])}, but this repository expects ` +
        `${forLog(expectedDeployment)}. Verification was pointed somewhere else.`,
    };
  }
  return { ok: true };
}

// ─── Exact-SHA CI gating ────────────────────────────────────────────────────

export type CheckResult = { name: string; conclusion: string | null };

export type Waiver = { context: string; issue: string; expires: string; reason: string };

export type CheckVerdict = {
  ok: boolean;
  passed: string[];
  /** Explicitly waived. ⚠️ Never to be reported as passing. */
  waived: Waiver[];
  failures: string[];
};

/**
 * Requires the commit being deployed to have green CI *at that exact SHA*.
 *
 * Ancestry proves a commit was merged; it does not prove the merge was healthy.
 * A push to `main` whose checks are still running, or red, is otherwise
 * perfectly deployable by this workflow — and "it is on main" is precisely the
 * reassurance that would stop anyone looking.
 *
 * Waivers are data, not judgement calls made at 2am. Each names an issue and an
 * expiry, and an expired one is a failure — the known-red checks in this
 * repository are known-red for reasons that are supposed to get fixed, and a
 * waiver with no end date is just a lowered standard.
 */
export function evaluateRequiredChecks(input: {
  required: string[];
  results: CheckResult[];
  waivers: Waiver[];
  now: Date;
}): CheckVerdict {
  const { required, results, waivers, now } = input;
  const byName = new Map(results.map((r) => [r.name, r.conclusion]));
  const verdict: CheckVerdict = { ok: true, passed: [], waived: [], failures: [] };

  for (const context of required) {
    const waiver = waivers.find((w) => w.context === context);
    if (waiver) {
      const expires = new Date(waiver.expires);
      if (Number.isNaN(expires.getTime())) {
        verdict.failures.push(`${context}: its waiver has an unreadable expiry (${forLog(waiver.expires)}).`);
        continue;
      }
      if (expires.getTime() <= now.getTime()) {
        verdict.failures.push(
          `${context}: its waiver expired on ${waiver.expires} (${waiver.issue}). Fix it or renew it deliberately.`
        );
        continue;
      }
      verdict.waived.push(waiver);
      continue;
    }

    const conclusion = byName.get(context);
    if (conclusion === "success") {
      verdict.passed.push(context);
      continue;
    }
    verdict.failures.push(
      conclusion === undefined
        ? `${context}: no result at this commit. It may still be running.`
        : `${context}: ${forLog(String(conclusion))}.`
    );
  }

  verdict.ok = verdict.failures.length === 0;
  return verdict;
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
  /** Fences concurrent chains, and here: tells a stale failure from a new one. */
  runId: string | null;
};

export type OrgReport = {
  orgId: string;
  readerSource: string;
  /**
   * Whether ANY `socialConversations` row exists for this org at the current
   * generation. A bounded existence probe, not a count.
   */
  hasCurrentGenerationConversations: boolean;
  platforms: PlatformReport[];
};

export type Problem = {
  /** ⚠️ Opaque. This output is public — see `opaqueOrgRef`. */
  org: string;
  platform: string | null;
  kind: string;
  detail: string;
};

export type Verdict = {
  ok: boolean;
  settled: boolean;
  orgCount: number;
  completedOrgCount: number;
  inFlight: Problem[];
  problems: Problem[];
  anomalies: Problem[];
};

/** `org|platform` → the runId observed BEFORE the fan-out started. */
export type RunBaseline = Map<string, string | null>;

export const baselineKey = (orgId: string, platform: string) => `${orgId}|${platform}`;

/** Records what every org/platform looked like before any redrive was asked for. */
export function captureRunBaseline(orgs: OrgReport[], into: RunBaseline = new Map()): RunBaseline {
  for (const org of orgs) {
    for (const p of org.platforms) into.set(baselineKey(org.orgId, p.platform), p.runId);
  }
  return into;
}

/**
 * States that are not a verdict yet, because something is still going to change
 * them without anyone intervening.
 *
 * `notStarted` is here because the fan-out only *schedules* the per-org
 * workers; the state row is created by the worker itself, so an org genuinely
 * reports this for a moment after a rollout begins.
 *
 * `ambiguous` is deliberately NOT here. `startSocialConversationBackfills`
 * skips it unconditionally — no run can repair a contradiction it is not
 * allowed to resolve — so waiting would burn the whole deadline on something
 * only a human can fix.
 */
const IN_FLIGHT_STATUSES = new Set(["running", "notStarted"]);

type PlatformVerdict =
  | { bucket: "healthy" }
  | { bucket: "inFlight" | "problem" | "anomaly"; kind: string; detail: string };

/** One platform's verdict. Extracted so the org loop stays readable. */
function classifyPlatform(p: PlatformReport, baselineRunId: string | null | undefined): PlatformVerdict {
  if (p.duplicateState || p.status === "ambiguous") {
    return {
      bucket: "problem",
      kind: "ambiguous",
      detail:
        "Two contradictory materialisation state rows exist. No backfill can clear this — the " +
        "writer stands down on it too. A human must delete the wrong row.",
    };
  }

  if (IN_FLIGHT_STATUSES.has(p.status)) {
    return {
      bucket: "inFlight",
      kind: p.status,
      detail: `${p.processedCount}/${p.expectedCount} events processed.`,
    };
  }

  if (p.status === "failed" || p.status === "interrupted") {
    // ⚠️ Whether this is terminal depends on WHOSE failure it is.
    //
    // `startSocialConversationBackfills` redrives both statuses, but it only
    // SCHEDULES the worker that resets the row — so immediately after the
    // fan-out the row still shows the OLD failure. Treating that as terminal
    // aborted the rollout while its own recovery was queued, which made any org
    // carrying a stale failed row fail every future rollout instantly.
    //
    // Treating it as in-flight unconditionally has the opposite fault: a
    // redrive that runs and fails again would then be waited on until the
    // deadline, turning a definite answer into a 45-minute one.
    //
    // The runId settles it. A failure still carrying the run identity observed
    // before the fan-out is the stale one being recovered; a failure under a
    // NEW runId is this rollout's own attempt, and it has already answered.
    const isNewRun = baselineRunId !== undefined && p.runId !== baselineRunId;
    if (isNewRun) {
      return {
        bucket: "problem",
        kind: p.status,
        // ⚠️ Deliberately NOT `p.failureMessage`. This output is public, and the
        // stored message is raw backend error text (SCRUM-119).
        detail: "This rollout's own backfill run reported a failure. See the Convex logs.",
      };
    }
    return {
      bucket: "inFlight",
      kind: `${p.status}-awaitingRedrive`,
      detail: `A pre-existing failure is being redriven. ${p.processedCount}/${p.expectedCount} processed.`,
    };
  }

  if (p.status !== "completed") {
    return {
      bucket: "problem",
      kind: "unknownStatus",
      detail: `Unrecognised materialisation status ${forLog(p.status)}.`,
    };
  }

  // ⚠️ Unreachable through the live data path today, and kept deliberately.
  // `lookupMaterializationState` queries BY the current generation, so a row it
  // returns always carries that generation and a superseded one surfaces as
  // `notStarted`. Defence for a future report carrying more than one
  // generation — NOT what protects against a stale generation today.
  if (p.generation !== p.expectedGeneration) {
    return {
      bucket: "problem",
      kind: "staleGeneration",
      detail: `Completed at generation ${p.generation}, but the reader expects ${p.expectedGeneration}.`,
    };
  }

  // ⚠️ REPORTED, NOT ENFORCED, and the demotion is deliberate.
  //
  // `syncThreadsInBackfillPage` skips every event without a `customerId`, and
  // `socialInboxConversations.test.ts` pins that as correct. `expectedCount`
  // counts ALL events. So an org whose events are all unlinked legitimately
  // ends `completed` with `expectedCount > 0` and `materializedCount === 0`.
  //
  // Failing on that would be unrecoverable, not merely wrong: the fan-out SKIPS
  // orgs already `completed`, so no re-run clears it, and `force` restarts the
  // backfill and drops the org back to the legacy scan. The enforceable version
  // of this check is `emptyAfterMaterialising` below, which needs no inference.
  if (p.expectedCount > 0 && p.materializedCount === 0) {
    return {
      bucket: "anomaly",
      kind: "emptyMaterialization",
      detail:
        `Completed over ${p.expectedCount} source events, materialising none. Expected when no ` +
        `event is linked to a customer; worth one look at this org's inbox otherwise.`,
    };
  }

  return { bucket: "healthy" };
}

type OrgVerdict = { settledHealthy: boolean; problems: Problem[]; inFlight: Problem[]; anomalies: Problem[] };

/** One organization's verdict, so the page loop is only bookkeeping. */
function classifyOrg(org: OrgReport, baseline: RunBaseline | undefined): OrgVerdict {
  const out: OrgVerdict = { settledHealthy: true, problems: [], inFlight: [], anomalies: [] };
  const ref = opaqueOrgRef(org.orgId);
  const at = (platform: string | null, kind: string, detail: string): Problem => ({
    org: ref,
    platform,
    kind,
    detail,
  });

  if (!Array.isArray(org.platforms) || org.platforms.length === 0) {
    out.settledHealthy = false;
    out.problems.push(at(null, "noPlatforms", "The report carried no platform rows for this org."));
    return out;
  }

  let claimedMaterialised = 0;
  for (const p of org.platforms) {
    if (p.status === "completed") claimedMaterialised += p.materializedCount;
    const verdict = classifyPlatform(p, baseline?.get(baselineKey(org.orgId, p.platform)));
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

  // ⚠️ THE 2026-08-07 INCIDENT, checked against the table instead of inferred
  // from a counter.
  //
  // On that day the Social Inbox reported zero conversations for an org holding
  // 347 Instagram and 689 Facebook events — no throw, no log — because the
  // reader was pointed at a table with nothing in it. A backfill that CLAIMS to
  // have materialised rows while the table holds none at the current generation
  // is that picture exactly, and unlike the counter-only version it cannot be
  // confused with a healthy all-unlinked org: those claim zero and are asked
  // nothing further.
  if (claimedMaterialised > 0 && !org.hasCurrentGenerationConversations) {
    out.settledHealthy = false;
    out.problems.push(
      at(
        null,
        "emptyAfterMaterialising",
        `The backfill reports ${claimedMaterialised} conversations materialised, but no ` +
          `socialConversations row exists at the current generation. The reader would serve an ` +
          `empty inbox with total confidence.`
      )
    );
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
          `Every platform reports completed, but the reader still resolves to ${forLog(org.readerSource)}.`
        )
      );
    }
    out.settledHealthy = false;
  }

  return out;
}

/**
 * Classifies one page of the materialisation report.
 *
 * Fails closed everywhere. An unrecognised status is a problem, not a shrug:
 * the alternative is that adding a status to the backend silently widens what
 * this gate accepts, and a gate that accepts unknown states is not a gate.
 */
export function classifyMaterializationReport(orgs: OrgReport[], baseline?: RunBaseline): Verdict {
  const problems: Problem[] = [];
  const inFlight: Problem[] = [];
  const anomalies: Problem[] = [];
  let completedOrgCount = 0;

  for (const org of orgs) {
    const verdict = classifyOrg(org, baseline);
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
 * repair a contradictory pair of state rows or a run that has already failed.
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
 * tenant count and would stop being cheap at a much larger one — and a full
 * scan every 15 seconds is a poor look for a change whose entire programme is
 * about cutting Convex read volume.
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
 * diagnostic goes through `logToStderr` instead.
 *
 * Parsed strictly anyway. If a future CLI writes a banner to stdout, the honest
 * outcome is refusing to certify a rollout it can no longer read.
 */
export function parseConvexRunJson(stdout: string): { ok: true; value: unknown } | Refusal {
  const trimmed = stdout.trim();
  if (trimmed === "") return { ok: false, reason: "convex run produced no output on stdout." };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason:
        `convex run's stdout was not JSON (${message}). Refusing to guess at a rollout verdict. ` +
        `First 200 characters: ${forLog(trimmed.slice(0, 200), 200)}`,
    };
  }
}

/** Renders the verdict for `$GITHUB_STEP_SUMMARY`. */
export function renderReleaseSummary(input: {
  sha: string;
  deployment: string;
  verdict: Verdict;
  outcome: PollOutcome;
}): string {
  const { sha, deployment, verdict, outcome } = input;

  const HEADINGS: Record<PollOutcome, string> = {
    verified: "✅ Production rollout verified",
    timedOut: "⏳ Deployed, but the rollout did not finish in time",
    failed: "❌ Deployed, but the rollout is incomplete",
    continue: "❌ Deployed, but the rollout is incomplete",
  };

  const lines = [
    `## ${HEADINGS[outcome]}`,
    "",
    `| | |`,
    `| --- | --- |`,
    `| Deployed commit | \`${sha}\` |`,
    `| Convex deployment | \`${deployment}\` |`,
    `| Organizations on the materialised path | ${verdict.completedOrgCount}/${verdict.orgCount} |`,
    "",
  ];

  if (outcome !== "verified") {
    lines.push(
      "> **Production is deployed. The rollout is not complete.**",
      "> Do not record SCRUM-21 as closed.",
      ""
    );
  }

  // ⚠️ Organizations are identified by an opaque, stable hash. This repository
  // is public, so its Actions summaries are too; a tenant's name or document id
  // here would publish a dealership platform's customer list. Match these
  // against the authenticated /admin materialisation screen.
  const table = (title: string, rows: Problem[], note?: string) => {
    if (rows.length === 0) return;
    lines.push(`### ${title}`, "");
    if (note) lines.push(note, "");
    lines.push("| Organization | Platform | Kind | Detail |", "| --- | --- | --- | --- |");
    for (const p of rows) {
      lines.push(`| \`${p.org}\` | ${p.platform ?? "—"} | \`${p.kind}\` | ${p.detail} |`);
    }
    lines.push("");
  };

  table("Problems", verdict.problems);
  table("Still in flight at the deadline", verdict.inFlight);
  table(
    "Worth a look (did not fail the rollout)",
    verdict.anomalies,
    "These cannot be told apart from a legitimate state with the data this gate has, so they are reported rather than enforced."
  );

  if (verdict.problems.length > 0 || verdict.inFlight.length > 0 || verdict.anomalies.length > 0) {
    lines.push(
      "_Organizations are shown as stable hashes because this repository, and therefore this " +
        "summary, is public. Resolve them on the `/admin` materialisation screen._",
      ""
    );
  }

  return lines.join("\n");
}
