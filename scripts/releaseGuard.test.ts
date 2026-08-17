import { describe, test, expect } from "vitest";
import {
  PRODUCTION_CONFIRMATION,
  classifyMaterializationReport,
  decideCommitAuthority,
  decidePollOutcome,
  mergeVerdicts,
  parseConvexRunJson,
  parseReleaseInputs,
  renderReleaseSummary,
  type OrgReport,
  type PlatformReport,
} from "./releaseGuard";

const TIP = "a".repeat(40);
const OLDER = "b".repeat(40);

const ok = (raw: Partial<{ sha: string; confirm: string; mode: string }> = {}) =>
  parseReleaseInputs({ sha: TIP, confirm: PRODUCTION_CONFIRMATION, mode: "deploy", ...raw });

describe("release inputs are validated before anything reaches production", () => {
  test("an ABBREVIATED sha is refused, because it names a query and not a commit", () => {
    // The input most likely to be offered in good faith: `git log --oneline`
    // prints it and `git rev-parse` resolves it happily. Accepting it would
    // make "deploy exactly this commit" a statement about what the repository
    // happens to contain at resolution time.
    const result = ok({ sha: "a1b2c3d" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/full 40-character/i);
  });

  test("a branch name, a tag and a ref path are all refused", () => {
    for (const sha of ["main", "v1.2.3", "refs/heads/main", "origin/main", "HEAD"]) {
      expect(ok({ sha }).ok, sha).toBe(false);
    }
  });

  test("a 39- and a 41-character sha are both refused", () => {
    expect(ok({ sha: "a".repeat(39) }).ok).toBe(false);
    expect(ok({ sha: "a".repeat(41) }).ok).toBe(false);
  });

  test("a missing or empty sha is refused rather than defaulted", () => {
    expect(parseReleaseInputs({ sha: undefined, confirm: PRODUCTION_CONFIRMATION, mode: "deploy" }).ok).toBe(
      false
    );
    expect(ok({ sha: "   " }).ok).toBe(false);
  });

  test("the confirmation must match exactly, including case", () => {
    expect(ok({ confirm: "deploy to production" }).ok).toBe(false);
    expect(ok({ confirm: "DEPLOY TO PRODUCTION!" }).ok).toBe(false);
    expect(ok({ confirm: "" }).ok).toBe(false);
    expect(ok({ confirm: "yes" }).ok).toBe(false);
    // Surrounding whitespace is forgiven — a copy-paste artefact is not a
    // different intention.
    expect(ok({ confirm: `  ${PRODUCTION_CONFIRMATION}  ` }).ok).toBe(true);
  });

  test("mode must be one of the two known modes", () => {
    expect(ok({ mode: "" }).ok).toBe(false);
    expect(ok({ mode: "Deploy" }).ok).toBe(false);
    expect(ok({ mode: "force" }).ok).toBe(false);
  });

  test("a valid input is normalised to a lower-case sha", () => {
    const result = ok({ sha: "A".repeat(40) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sha).toBe("a".repeat(40));
    expect(result.mode).toBe("deploy");
  });
});

describe("only commits contained in main may reach production", () => {
  const authority = (over: Partial<Parameters<typeof decideCommitAuthority>[0]> = {}) =>
    decideCommitAuthority({
      mode: "deploy",
      sha: TIP,
      mainTipSha: TIP,
      commitExists: true,
      isAncestorOfMain: true,
      ...over,
    });

  test("a commit that does not exist is refused", () => {
    expect(authority({ commitExists: false }).ok).toBe(false);
  });

  test("a commit that is not contained in main is refused, in BOTH modes", () => {
    expect(authority({ isAncestorOfMain: false, sha: OLDER }).ok).toBe(false);
    expect(authority({ mode: "rollback", isAncestorOfMain: false, sha: OLDER }).ok).toBe(false);
  });

  test("a deploy of something other than main's tip is refused", () => {
    const result = authority({ sha: OLDER, mainTipSha: TIP });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/rollback/i);
  });

  test("REGRESSION: a rollback whose target IS the tip is refused", () => {
    // ⚠️ This is the defect that shipped in the abandoned local wrapper: a
    // `--rollback-to` whose value went missing left `argv[i + 1]` undefined,
    // which is falsy, so the rollback branch never ran and the deploy fell
    // through to main's TIP — the exact commit the operator was rolling back
    // away from, during an incident. Nothing on screen contradicted them,
    // because the confirmation named a deployment and the deployment was right.
    //
    // The shape survives the rewrite even though the mechanism is gone, so the
    // refusal is asserted at the decision rather than at the argument parser.
    const result = authority({ mode: "rollback", sha: TIP, mainTipSha: TIP });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/rolling back away from/i);
  });

  test("an unreadable main tip fails closed", () => {
    expect(authority({ mainTipSha: "" }).ok).toBe(false);
    expect(authority({ mainTipSha: "unknown" }).ok).toBe(false);
  });

  test("the two legitimate cases are allowed", () => {
    expect(authority().ok).toBe(true);
    expect(authority({ mode: "rollback", sha: OLDER, mainTipSha: TIP }).ok).toBe(true);
  });
});

// ─── Rollout verification ───────────────────────────────────────────────────

const platform = (over: Partial<PlatformReport> = {}): PlatformReport => ({
  platform: "instagram",
  status: "completed",
  duplicateState: false,
  generation: 1,
  expectedGeneration: 1,
  processedCount: 1029,
  materializedCount: 12,
  expectedCount: 1029,
  failureMessage: null,
  ...over,
});

const org = (over: Partial<OrgReport> = {}): OrgReport => ({
  orgId: "org_1",
  orgName: "Bloom Cars",
  readerSource: "materialized",
  platforms: [platform(), platform({ platform: "facebook" })],
  ...over,
});

describe("the rollout verdict fails closed", () => {
  test("a healthy report verifies", () => {
    const verdict = classifyMaterializationReport([org()]);
    expect(verdict).toMatchObject({ ok: true, settled: true, orgCount: 1, completedOrgCount: 1 });
  });

  test("THE 2026-08-07 INCIDENT: completed over real events, zero conversations materialised", () => {
    // On that day the Social Inbox reported zero conversations for an org
    // holding 347 Instagram and 689 Facebook events — no throw, no log —
    // because the reader had been pointed at a table whose backfill never ran.
    // "COMPLETED" alone cannot distinguish that from a genuinely empty org,
    // which is exactly why the source count is compared against the result.
    const verdict = classifyMaterializationReport([
      org({
        readerSource: "materialized",
        platforms: [platform({ expectedCount: 347, processedCount: 347, materializedCount: 0 })],
      }),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.settled).toBe(true);
    expect(verdict.problems.map((p) => p.kind)).toContain("emptyMaterialization");
  });

  test("an org with genuinely no events is NOT the incident", () => {
    const verdict = classifyMaterializationReport([
      org({ platforms: [platform({ expectedCount: 0, processedCount: 0, materializedCount: 0 })] }),
    ]);
    expect(verdict.ok).toBe(true);
  });

  test("failed, interrupted and ambiguous are terminal problems, not waits", () => {
    for (const status of ["failed", "interrupted"]) {
      const verdict = classifyMaterializationReport([org({ platforms: [platform({ status })] })]);
      expect(verdict.ok, status).toBe(false);
      expect(verdict.settled, status).toBe(true);
      expect(verdict.problems[0].kind, status).toBe(status);
    }

    const ambiguous = classifyMaterializationReport([
      org({ platforms: [platform({ status: "ambiguous", duplicateState: true })] }),
    ]);
    expect(ambiguous.problems[0].kind).toBe("ambiguous");
    expect(ambiguous.settled).toBe(true);
  });

  test("a failure message is carried through instead of being swallowed", () => {
    const verdict = classifyMaterializationReport([
      org({ platforms: [platform({ status: "failed", failureMessage: "hit a document limit" })] }),
    ]);
    expect(verdict.problems[0].detail).toBe("hit a document limit");
  });

  test("running and notStarted mean ASK AGAIN, not healthy and not broken", () => {
    // `notStarted` is deliberately not a failure. The fan-out only *schedules*
    // the per-org workers and the state row is created by the worker, so an org
    // legitimately reports `notStarted` for a moment after the rollout begins.
    // Treating it as a failure would fail nearly every rollout in its first
    // seconds; the poll deadline is what catches one that never starts.
    for (const status of ["running", "notStarted"]) {
      const verdict = classifyMaterializationReport([
        org({ readerSource: "legacyEvents", platforms: [platform({ status })] }),
      ]);
      expect(verdict.ok, status).toBe(false);
      expect(verdict.settled, status).toBe(false);
      expect(verdict.problems, status).toEqual([]);
      expect(verdict.inFlight[0].kind, status).toBe(status);
    }
  });

  test("a stale generation is refused even when the row says completed", () => {
    const verdict = classifyMaterializationReport([
      org({ platforms: [platform({ generation: 1, expectedGeneration: 2 })] }),
    ]);
    expect(verdict.problems[0].kind).toBe("staleGeneration");
  });

  test("an UNKNOWN status fails closed rather than being ignored", () => {
    // Adding a status to the backend must not silently widen what this gate
    // accepts.
    const verdict = classifyMaterializationReport([
      org({ platforms: [platform({ status: "reconciling" })] }),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0].kind).toBe("unknownStatus");
  });

  test("readerSource is checked as well as the platform rows, not inferred from them", () => {
    const verdict = classifyMaterializationReport([org({ readerSource: "legacyEvents" })]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0].kind).toBe("readerSourceContradiction");
  });

  test("an org reported with no platform rows is a problem", () => {
    expect(classifyMaterializationReport([org({ platforms: [] })]).problems[0].kind).toBe("noPlatforms");
  });

  test("an EMPTY report is not a pass", () => {
    // Verifying nothing must never read as verifying everything.
    const verdict = classifyMaterializationReport([]);
    expect(verdict.ok).toBe(false);
    expect(verdict.orgCount).toBe(0);
  });

  test("one bad page poisons the merged verdict, so pagination cannot hide it", () => {
    const good = classifyMaterializationReport([org()]);
    const bad = classifyMaterializationReport([
      org({ orgId: "org_2", platforms: [platform({ status: "failed" })] }),
    ]);
    const merged = mergeVerdicts([good, bad]);
    expect(merged.ok).toBe(false);
    expect(merged.orgCount).toBe(2);
    expect(merged.completedOrgCount).toBe(1);
    expect(merged.problems).toHaveLength(1);
  });

  test("merging nothing is not a pass either", () => {
    expect(mergeVerdicts([]).ok).toBe(false);
  });
});

describe("polling stops for the right reasons", () => {
  const verdictWith = (over: Partial<ReturnType<typeof classifyMaterializationReport>>) => ({
    ...classifyMaterializationReport([org()]),
    ...over,
  });

  test("a healthy settled report verifies", () => {
    expect(decidePollOutcome({ verdict: verdictWith({}), elapsedMs: 0, timeoutMs: 1000 })).toBe("verified");
  });

  test("a settled FAILURE ends the poll immediately instead of burning the deadline", () => {
    // Waiting does not repair a `failed`, an `interrupted`, or a contradictory
    // pair of state rows.
    const verdict = classifyMaterializationReport([org({ platforms: [platform({ status: "failed" })] })]);
    expect(decidePollOutcome({ verdict, elapsedMs: 0, timeoutMs: 60_000 })).toBe("failed");
  });

  test("work still in flight keeps polling until the deadline, then times out", () => {
    const verdict = classifyMaterializationReport([
      org({ readerSource: "legacyEvents", platforms: [platform({ status: "running" })] }),
    ]);
    expect(decidePollOutcome({ verdict, elapsedMs: 5_000, timeoutMs: 60_000 })).toBe("continue");
    expect(decidePollOutcome({ verdict, elapsedMs: 60_000, timeoutMs: 60_000 })).toBe("timedOut");
    expect(decidePollOutcome({ verdict, elapsedMs: 61_000, timeoutMs: 60_000 })).toBe("timedOut");
  });
});

describe("convex run output is parsed strictly", () => {
  test("well-formed JSON is returned", () => {
    const result = parseConvexRunJson('\n{\n  "page": [],\n  "isDone": true\n}\n');
    expect(result).toEqual({ ok: true, value: { page: [], isDone: true } });
  });

  test("empty stdout is a refusal, never an empty result", () => {
    // An empty page would classify as "no orgs", which must not be reachable
    // from "the CLI printed nothing".
    expect(parseConvexRunJson("   \n ").ok).toBe(false);
  });

  test("non-JSON stdout refuses rather than guessing which line was the answer", () => {
    const result = parseConvexRunJson("✔ Ran function\n{ not json }");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Refusing to guess/i);
  });
});

describe("the summary says what is true", () => {
  test("an incomplete rollout says production IS deployed and must not be signed off", () => {
    const verdict = classifyMaterializationReport([org({ platforms: [platform({ status: "failed" })] })]);
    const summary = renderReleaseSummary({
      mode: "deploy",
      sha: TIP,
      mainTipSha: TIP,
      deployment: "kindly-hound-172",
      verdict,
      outcome: "failed",
    });
    expect(summary).toMatch(/Production is deployed. The rollout is not complete./);
    expect(summary).toMatch(/Do not record SCRUM-21 as closed/);
    expect(summary).toContain("kindly-hound-172");
    expect(summary).toContain(TIP);
  });

  test("a verified rollout does not carry the incomplete warning", () => {
    const summary = renderReleaseSummary({
      mode: "deploy",
      sha: TIP,
      mainTipSha: TIP,
      deployment: "kindly-hound-172",
      verdict: classifyMaterializationReport([org()]),
      outcome: "verified",
    });
    expect(summary).toMatch(/Production rollout verified/);
    expect(summary).not.toMatch(/rollout is not complete/);
  });
});
