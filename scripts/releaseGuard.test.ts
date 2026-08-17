import { describe, test, expect } from "vitest";
import {
  PRODUCTION_CONFIRMATION,
  assertDeploymentIdentity,
  captureRunBaseline,
  classifyDeployKey,
  classifyMaterializationReport,
  decideCommitAuthority,
  decidePollOutcome,
  evaluateRequiredChecks,
  forLog,
  isFullSha,
  isSafeApiPath,
  mergeVerdicts,
  opaqueOrgRef,
  parseConvexRunJson,
  parseDeployKeyTarget,
  parseReleaseInputs,
  pollIntervalMs,
  renderReleaseSummary,
  requireBoundProductionKeys,
  type CheckResult,
  type OrgReport,
  type PlatformReport,
} from "./releaseGuard";

const TIP = "a".repeat(40);
const OLDER = "b".repeat(40);

const inputs = (raw: Partial<{ sha: string; confirm: string }> = {}) =>
  parseReleaseInputs({ sha: TIP, confirm: PRODUCTION_CONFIRMATION, ...raw });

describe("release inputs are validated before anything reaches production", () => {
  test("an ABBREVIATED sha is refused, because it names a query and not a commit", () => {
    // The input most likely to be offered in good faith: `git log --oneline`
    // prints it and `git rev-parse` resolves it happily.
    const result = inputs({ sha: "a1b2c3d" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/full 40-character/i);
  });

  test("branch names, tags, ref paths and wrong lengths are refused", () => {
    for (const sha of ["main", "v1.2.3", "refs/heads/main", "HEAD", "a".repeat(39), "a".repeat(41), "   "]) {
      expect(inputs({ sha }).ok, sha).toBe(false);
    }
    expect(parseReleaseInputs({ sha: undefined, confirm: PRODUCTION_CONFIRMATION }).ok).toBe(false);
  });

  test("the confirmation must match exactly, including case", () => {
    for (const confirm of ["deploy to production", "DEPLOY TO PRODUCTION!", "", "yes"]) {
      expect(inputs({ confirm }).ok, confirm).toBe(false);
    }
    // Surrounding whitespace is forgiven — a copy-paste artefact is not a
    // different intention.
    expect(inputs({ confirm: `  ${PRODUCTION_CONFIRMATION}  ` }).ok).toBe(true);
  });

  test("a valid input is normalised to a lower-case sha", () => {
    const result = inputs({ sha: "A".repeat(40) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sha).toBe(TIP);
  });
});

describe("only main's current tip may reach production", () => {
  const authority = (over: Partial<Parameters<typeof decideCommitAuthority>[0]> = {}) =>
    decideCommitAuthority({ sha: TIP, mainTipSha: TIP, commitExists: true, isAncestorOfMain: true, ...over });

  test("a commit that does not exist is refused", () => {
    expect(authority({ commitExists: false }).ok).toBe(false);
  });

  test("a commit not contained in main is refused", () => {
    expect(authority({ isAncestorOfMain: false, sha: OLDER }).ok).toBe(false);
  });

  test("an older ancestor is refused — there is no rollback mode", () => {
    // ⚠️ Rollback was REMOVED. Any rollback target predates this verification
    // tooling, so the run would deploy and then verify nothing while reporting
    // success. Undo is a revert commit deployed through this same path.
    const result = authority({ sha: OLDER, mainTipSha: TIP });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/merge a revert/i);
  });

  test("an unreadable main tip fails closed", () => {
    expect(authority({ mainTipSha: "" }).ok).toBe(false);
    expect(authority({ mainTipSha: "unknown" }).ok).toBe(false);
  });

  test("the tip is allowed", () => {
    expect(authority().ok).toBe(true);
  });
});

describe("both credentials must address ONE named production deployment", () => {
  const PROD = "prod:kindly-hound-172|thesecretpart";
  const bind = (over: Partial<Parameters<typeof requireBoundProductionKeys>[0]> = {}) =>
    requireBoundProductionKeys({
      deployKey: PROD,
      operatorKey: PROD,
      expectedDeployment: "kindly-hound-172",
      ...over,
    });

  test("a PREVIEW key is refused — it would verify a preview and report success", () => {
    // ⚠️ Not hypothetical. A repository-level CONVEX_DEPLOY_KEY exists and
    // playwright.yml consumes it on every pull request with Convex's
    // preview-deploy flags. Repository secrets are visible to every job.
    const result = bind({ deployKey: "preview:team:project|abc123" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/PREVIEW/);
    expect(result.reason).not.toMatch(/abc123/);
  });

  test("THE F1 CASE: a valid PRODUCTION key for the WRONG deployment is refused", () => {
    // Checking only that a key is prod-scoped is not enough. A production key
    // for another project deploys, verifies and reports success there exactly
    // as confidently — and 2026-08-07 was a targeting error, not an
    // authorisation one.
    const result = bind({ deployKey: "prod:some-other-deployment|secret" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/expects/i);
    expect(result.reason).not.toMatch(/secret/);
  });

  test("an OPERATOR key pointing elsewhere is refused, naming which key it was", () => {
    // Otherwise the run deploys to one deployment and verifies another, then
    // reports the second's health as though it were the first's.
    //
    // ⚠️ Note what actually catches this: the per-key comparison against the
    // expected name, NOT the two keys being compared to one another. Mutation
    // testing showed the pairwise check is unreachable — two keys that each
    // match the same expected value have already been proven equal. An earlier
    // version of this test looked like it covered the pairwise check and did
    // not, because it refused at the unset-expectation gate instead.
    const result = bind({ operatorKey: "prod:kindly-hound-999|opsecret" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/operator key/);
    expect(result.reason).toMatch(/kindly-hound-999/);
    expect(result.reason).not.toMatch(/opsecret/);
  });

  test("an unnamed expected deployment refuses rather than accepting anything", () => {
    expect(bind({ expectedDeployment: "" }).ok).toBe(false);
    expect(bind({ expectedDeployment: undefined }).ok).toBe(false);
  });

  test("malformed prod prefixes are refused, never assumed to mean production", () => {
    // Convex's own `deploymentTypeFromAdminKey` reports a key with no `:` as
    // "prod". That is exactly the assumption not to inherit.
    for (const key of ["prod:|secret", "prod:a:b|secret", "legacykeynopipe", "prod|secret", ""]) {
      expect(parseDeployKeyTarget(key).kind, key).not.toBe("prod");
      expect(bind({ deployKey: key }).ok, key).toBe(false);
    }
  });

  test("dev and project keys are refused, and prod is parsed with its deployment", () => {
    expect(classifyDeployKey("dev:happy-otter-42|s")).toBe("dev");
    expect(classifyDeployKey("project:team:proj|s")).toBe("project");
    expect(parseDeployKeyTarget(PROD)).toEqual({ kind: "prod", deployment: "kindly-hound-172" });
    expect(bind().ok).toBe(true);
  });
});

describe("the deployment states its own identity", () => {
  test("a deployment that answers with a different name is refused", () => {
    const result = assertDeploymentIdentity("https://someone-elses-123.convex.cloud", "kindly-hound-172");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/pointed somewhere else/i);
  });

  test("a deployment that will not say who it is fails closed", () => {
    expect(assertDeploymentIdentity(null, "kindly-hound-172").ok).toBe(false);
    expect(assertDeploymentIdentity("", "kindly-hound-172").ok).toBe(false);
    expect(assertDeploymentIdentity("not-a-url", "kindly-hound-172").ok).toBe(false);
  });

  test("the expected deployment is accepted, with or without a trailing slash", () => {
    expect(assertDeploymentIdentity("https://kindly-hound-172.convex.cloud", "kindly-hound-172").ok).toBe(true);
    expect(assertDeploymentIdentity("https://kindly-hound-172.convex.cloud/", "kindly-hound-172").ok).toBe(true);
  });
});

describe("CI must be green at the exact commit, and waivers expire", () => {
  const NOW = new Date("2026-08-17T00:00:00Z");
  const PLAYWRIGHT = { producer: "github-actions", name: "playwright" };
  const waiver = { ...PLAYWRIGHT, issue: "SCRUM-95", expires: "2026-11-17", reason: "no backend" };

  const result = (over: Partial<CheckResult> = {}): CheckResult => ({
    producer: "github-actions",
    name: "lint",
    status: "completed",
    conclusion: "success",
    ...over,
  });
  const LINT = [{ producer: "github-actions", name: "lint" }];

  test("a still-running check is not a passing one", () => {
    // Ancestry proves a commit was merged, not that the merge was healthy.
    const verdict = evaluateRequiredChecks({
      required: LINT,
      results: [result({ status: "in_progress", conclusion: null })],
      waivers: [],
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/has not finished/);
    expect(verdict.failures[0]).toMatch(/in_progress/);
  });

  test("a WAIVED check that has not finished is still a refusal", () => {
    // ⚠️ REGRESSION. A waiver excuses a RESULT. A queued or running check has
    // not produced one, so consulting its waiver here signs the check off on
    // the strength of the note explaining why its outcome does not matter —
    // the same defect as excusing an absent check, one state later.
    const verdict = evaluateRequiredChecks({
      required: [PLAYWRIGHT],
      results: [result({ name: "playwright", status: "in_progress", conclusion: null })],
      waivers: [waiver],
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.waived).toEqual([]);
    expect(verdict.failures[0]).toMatch(/has not finished/);
  });

  test("a check with no result at this commit is a failure, not an absence", () => {
    const verdict = evaluateRequiredChecks({ required: LINT, results: [], waivers: [], now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/no result at this commit/);
  });

  test("THE OSV-SCANNER CASE: a duplicated name refuses rather than picking one", () => {
    // ⚠️ REGRESSION, and the one that ended round 3. This repository really does
    // publish two check-runs called `osv-scanner`: Advanced Security's SARIF
    // result, and a `security.yml` job whose scan step carries
    // `continue-on-error: true` and therefore reports success whatever it finds.
    //
    // The previous implementation built `new Map(results.map(...))`, so the
    // collision resolved by last-write-wins and the release gated on whichever
    // arrived second. A real CVE would have reported `osv-scanner: passed`.
    //
    // Both here are green, so "did it pass" cannot catch this — only counting
    // the matches can.
    const verdict = evaluateRequiredChecks({
      required: [{ producer: "github-actions", name: "osv-scanner" }],
      results: [
        result({ name: "osv-scanner" }),
        result({ name: "osv-scanner" }),
      ],
      waivers: [],
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/2 results share that producer and name/);
    expect(verdict.passed).toEqual([]);
  });

  test("the same name from a DIFFERENT producer does not satisfy the requirement", () => {
    // The other half of the same lesson: a name is not an identity in either
    // direction. A green `github-advanced-security/osv-scanner` says nothing
    // about whether the required Actions job ran.
    const verdict = evaluateRequiredChecks({
      required: [{ producer: "github-actions", name: "osv-scanner" }],
      results: [result({ producer: "github-advanced-security", name: "osv-scanner" })],
      waivers: [],
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/no result at this commit from that producer/);
  });

  test("a waiver excuses a RESULT, never the absence of one", () => {
    // ⚠️ REGRESSION. A waived check that is renamed or deleted used to pass
    // silently — the waiver was consulted before anything was observed, so the
    // gate reported WAIVED for a check that had not run at all.
    const verdict = evaluateRequiredChecks({
      required: [PLAYWRIGHT],
      results: [],
      waivers: [waiver],
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/no result at this commit/);
    expect(verdict.waived).toEqual([]);
  });

  test("a live waiver is recorded as WAIVED, with what was actually observed", () => {
    const verdict = evaluateRequiredChecks({
      required: [PLAYWRIGHT],
      results: [result({ name: "playwright", conclusion: "failure" })],
      waivers: [waiver],
      now: NOW,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.waived).toEqual([{ ...waiver, observed: "failure" }]);
    expect(verdict.passed).toEqual([]);
  });

  test("an EXPIRED waiver fails the release rather than degrading quietly", () => {
    const verdict = evaluateRequiredChecks({
      required: [PLAYWRIGHT],
      results: [result({ name: "playwright", conclusion: "failure" })],
      waivers: [waiver],
      now: new Date("2026-12-01T00:00:00Z"),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/expired/i);
  });

  test("an unreadable expiry fails closed", () => {
    const verdict = evaluateRequiredChecks({
      required: [PLAYWRIGHT],
      results: [result({ name: "playwright", conclusion: "failure" })],
      waivers: [{ ...waiver, expires: "whenever" }],
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
  });

  test("the checked-in policy is coherent, and requires nothing that cannot fail", async () => {
    // Not cast: the inferred JSON type is the point. If the file's shape drifts
    // from what the guard reads, this stops compiling rather than stops meaning
    // anything.
    const policy = (await import("../.github/release-waivers.json")).default;
    const key = (c: { producer: string; name: string }) => `${c.producer}/${c.name}`;
    const required = new Set(policy.required.map(key));

    expect(policy.required.length).toBeGreaterThan(5);
    // Duplicated entries would make the same check both required and ambiguous
    // with itself; the matcher would still refuse, but for a confusing reason.
    expect(required.size).toBe(policy.required.length);

    for (const w of policy.waivers) {
      // A waiver for something that is not required protects nothing and hides
      // the fact that the check was never gated.
      expect([...required], key(w)).toContain(key(w));
      expect(w.issue).toMatch(/^SCRUM-\d+$/);
      expect(Number.isNaN(new Date(w.expires).getTime())).toBe(false);
    }

    // ⚠️ The informational list is not decoration. Every name in it was
    // verified live to be incapable of refusing a release — report-only jobs
    // (`continue-on-error` on every step), Advanced Security checks that never
    // appear on a main commit, and a Sonar job that uploads without waiting for
    // the quality gate. Requiring any of them gates on nothing, or gates on
    // something that is never there.
    for (const group of Object.values(policy.informational)) {
      if (Array.isArray(group)) continue; // the block's own $comment
      for (const name of group.names) {
        expect(required, `${group.producer}/${name} must stay informational`).not.toContain(
          key({ producer: group.producer, name })
        );
      }
    }
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
  runId: "run-1",
  hasCurrentGenerationConversations: true,
  ...over,
});

const org = (over: Partial<OrgReport> = {}): OrgReport => ({
  orgId: "org_1",
  readerSource: "materialized",
  platforms: [platform(), platform({ platform: "facebook" })],
  ...over,
});

describe("the rollout verdict fails closed", () => {
  test("a healthy report verifies", () => {
    expect(classifyMaterializationReport([org()])).toMatchObject({
      ok: true,
      settled: true,
      orgCount: 1,
      completedOrgCount: 1,
    });
  });

  test("THE 2026-08-07 INCIDENT: rows claimed, table empty", () => {
    // Checked against the TABLE rather than inferred from a counter. On that
    // day the inbox reported zero conversations for an org holding 347
    // Instagram and 689 Facebook events, with no throw and no log, because the
    // reader was pointed at a table with nothing in it.
    const verdict = classifyMaterializationReport([
      org({
        platforms: [
          platform({ hasCurrentGenerationConversations: false }),
          platform({ platform: "facebook", hasCurrentGenerationConversations: false }),
        ],
      }),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.settled).toBe(true);
    expect(verdict.problems.map((p) => p.kind)).toContain("emptyAfterMaterialising");
  });

  test("ONE CHANNEL MISSING is caught: the other platform cannot answer for it", () => {
    // ⚠️ REGRESSION. The probe used to be org-wide, so Instagram claiming 12
    // materialised conversations while holding none passed as long as Facebook
    // had rows — and the Instagram inbox would be confidently empty, which is
    // the original incident surviving the guard written for it.
    const verdict = classifyMaterializationReport([
      org({
        platforms: [
          platform({ hasCurrentGenerationConversations: false }),
          platform({ platform: "facebook", hasCurrentGenerationConversations: true }),
        ],
      }),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.map((p) => [p.platform, p.kind])).toEqual([
      ["instagram", "emptyAfterMaterialising"],
    ]);
  });

  test("an org whose events are all UNLINKED still passes", () => {
    // ⚠️ REGRESSION. `syncThreadsInBackfillPage` skips every event without a
    // `customerId` and `socialInboxConversations.test.ts` pins that as correct,
    // so this org legitimately completes having materialised nothing. Failing
    // on it was UNRECOVERABLE: the fan-out skips orgs already `completed`.
    //
    // It claims zero, so the table probe is not consulted — which is exactly
    // why that probe can be a hard gate while this stays a note.
    const verdict = classifyMaterializationReport([
      org({
        platforms: [
          platform({
            expectedCount: 347,
            processedCount: 347,
            materializedCount: 0,
            hasCurrentGenerationConversations: false,
          }),
        ],
      }),
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(verdict.anomalies.map((p) => p.kind)).toEqual(["emptyMaterialization"]);
  });

  test("an org with genuinely no events raises nothing at all", () => {
    const verdict = classifyMaterializationReport([
      org({
        platforms: [
          platform({
            expectedCount: 0,
            processedCount: 0,
            materializedCount: 0,
            hasCurrentGenerationConversations: false,
          }),
        ],
      }),
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.anomalies).toEqual([]);
  });

  test("a PRE-EXISTING failure waits for its redrive; a NEW one is terminal", () => {
    // ⚠️ `startSocialConversationBackfills` redrives failed/interrupted, but it
    // only SCHEDULES the worker that resets the row — so immediately after the
    // fan-out the row still shows the OLD failure. Treating that as terminal
    // aborted the rollout mid-recovery. Treating it as in-flight forever would
    // wait out the deadline on a run that already answered.
    const failing = [org({ readerSource: "legacyEvents", platforms: [platform({ status: "failed" })] })];
    const baseline = captureRunBaseline(failing);

    const stale = classifyMaterializationReport(failing, baseline);
    expect(stale.problems).toEqual([]);
    expect(stale.inFlight[0].kind).toBe("failed-awaitingRedrive");
    expect(stale.settled).toBe(false);

    const newRun = classifyMaterializationReport(
      [org({ readerSource: "legacyEvents", platforms: [platform({ status: "failed", runId: "run-2" })] })],
      baseline
    );
    expect(newRun.problems[0].kind).toBe("failed");
    expect(newRun.settled).toBe(true);
  });

  test("a failure on a platform that was RUNNING at baseline is terminal", () => {
    // ⚠️ REGRESSION, and the subtle half. `startSocialConversationBackfills`
    // SKIPS a running platform on purpose — re-enqueuing resets its cursor and
    // fences the chain already doing the work. So nothing was scheduled to
    // repair it, and a failure that appears there is waiting for a redrive that
    // is never coming.
    //
    // The old rule asked only "is the runId different?", which is false here,
    // so this waited out the entire 45-minute deadline before reporting.
    const baseline = captureRunBaseline([
      org({ readerSource: "legacyEvents", platforms: [platform({ status: "running" })] }),
    ]);

    const verdict = classifyMaterializationReport(
      [org({ readerSource: "legacyEvents", platforms: [platform({ status: "failed" })] })],
      baseline
    );
    expect(verdict.inFlight).toEqual([]);
    expect(verdict.problems[0].kind).toBe("failed");
    expect(verdict.settled).toBe(true);
  });

  test("a NEW organization's own failure is terminal, not mistaken for pre-existing", () => {
    // ⚠️ REGRESSION, the other direction. An org created after the baseline walk
    // has no entry at all. The old guard read the missing entry as "no evidence
    // of a new run" and waited — so a tenant onboarded mid-rollout could hold
    // the release open until the deadline on its own fresh failure.
    const baseline = captureRunBaseline([org({ orgId: "org_existing" })]);

    const verdict = classifyMaterializationReport(
      [
        org({
          orgId: "org_created_during_rollout",
          readerSource: "legacyEvents",
          platforms: [platform({ status: "failed", runId: "run-9" })],
        }),
      ],
      baseline
    );
    expect(verdict.inFlight).toEqual([]);
    expect(verdict.problems[0].kind).toBe("failed");
    expect(verdict.settled).toBe(true);
  });

  test("ambiguous stays terminal, because no redrive is allowed to touch it", () => {
    const verdict = classifyMaterializationReport([
      org({ platforms: [platform({ status: "ambiguous", duplicateState: true })] }),
    ]);
    expect(verdict.problems[0].kind).toBe("ambiguous");
    expect(verdict.settled).toBe(true);
  });

  test("running and notStarted mean ASK AGAIN", () => {
    for (const status of ["running", "notStarted"]) {
      const verdict = classifyMaterializationReport([
        org({ readerSource: "legacyEvents", platforms: [platform({ status })] }),
      ]);
      expect(verdict.problems, status).toEqual([]);
      expect(verdict.inFlight[0].kind, status).toBe(status);
      expect(verdict.settled, status).toBe(false);
    }
  });

  test("unknown statuses, stale generations and reader contradictions all fail closed", () => {
    expect(
      classifyMaterializationReport([org({ platforms: [platform({ status: "reconciling" })] })]).problems[0]
        .kind
    ).toBe("unknownStatus");
    expect(
      classifyMaterializationReport([org({ platforms: [platform({ expectedGeneration: 2 })] })]).problems[0]
        .kind
    ).toBe("staleGeneration");
    expect(
      classifyMaterializationReport([org({ readerSource: "legacyEvents" })]).problems[0].kind
    ).toBe("readerSourceContradiction");
    expect(classifyMaterializationReport([org({ platforms: [] })]).problems[0].kind).toBe("noPlatforms");
  });

  test("an EMPTY report is not a pass, and neither is an empty merge", () => {
    expect(classifyMaterializationReport([]).ok).toBe(false);
    expect(mergeVerdicts([]).ok).toBe(false);
  });

  test("one bad page poisons the merged verdict", () => {
    const merged = mergeVerdicts([
      classifyMaterializationReport([org()]),
      classifyMaterializationReport([
        org({ orgId: "org_2", platforms: [platform({ status: "ambiguous", duplicateState: true })] }),
      ]),
    ]);
    expect(merged.ok).toBe(false);
    expect(merged.orgCount).toBe(2);
    expect(merged.completedOrgCount).toBe(1);
  });
});

describe("public output carries no tenant data", () => {
  // ⚠️ This repository is public, so its Actions logs and job summaries are
  // public with it. A tenant name or document id here publishes the customer
  // list of a dealership platform, and the stored failureMessage is raw backend
  // error text (SCRUM-119).
  const leaky = classifyMaterializationReport([
    org({
      orgId: "kd7abcdefghijklmnop",
      readerSource: "legacyEvents",
      platforms: [
        platform({
          status: "failed",
          runId: "run-9",
          failureMessage: "Uncaught Error: document with id kx123 exceeded read limit at socialInbox.ts:412",
        }),
      ],
    }),
  ], captureRunBaseline([org({ orgId: "kd7abcdefghijklmnop", platforms: [platform({ runId: "old" })] })]));

  test("no raw org id, and no raw backend error text, reaches a problem", () => {
    const rendered = JSON.stringify(leaky);
    expect(rendered).not.toMatch(/kd7abcdefghijklmnop/);
    expect(rendered).not.toMatch(/exceeded read limit/);
    expect(rendered).not.toMatch(/socialInbox\.ts/);
    expect(leaky.problems[0].org).toMatch(/^org-[0-9a-f]{10}$/);
  });

  test("the same org hashes the same way, and different orgs differ", () => {
    expect(opaqueOrgRef("org_1")).toBe(opaqueOrgRef("org_1"));
    expect(opaqueOrgRef("org_1")).not.toBe(opaqueOrgRef("org_2"));
    expect(opaqueOrgRef("org_1")).not.toContain("org_1");
  });

  test("the rendered summary carries neither either", () => {
    const summary = renderReleaseSummary({
      sha: TIP,
      deployment: "kindly-hound-172",
      verdict: leaky,
      outcome: "failed",
    });
    expect(summary).not.toMatch(/kd7abcdefghijklmnop/);
    expect(summary).not.toMatch(/exceeded read limit/);
    expect(summary).toMatch(/Production is deployed. The rollout is not complete./);
    expect(summary).toMatch(/stable hashes because this repository/);
  });
});

describe("polling stops for the right reasons", () => {
  test("verified, failed, continue and timeout", () => {
    expect(
      decidePollOutcome({ verdict: classifyMaterializationReport([org()]), elapsedMs: 0, timeoutMs: 1000 })
    ).toBe("verified");

    const broken = classifyMaterializationReport([
      org({ platforms: [platform({ status: "ambiguous", duplicateState: true })] }),
    ]);
    expect(decidePollOutcome({ verdict: broken, elapsedMs: 0, timeoutMs: 60_000 })).toBe("failed");

    const waiting = classifyMaterializationReport([
      org({ readerSource: "legacyEvents", platforms: [platform({ status: "running" })] }),
    ]);
    expect(decidePollOutcome({ verdict: waiting, elapsedMs: 5_000, timeoutMs: 60_000 })).toBe("continue");
    expect(decidePollOutcome({ verdict: waiting, elapsedMs: 60_000, timeoutMs: 60_000 })).toBe("timedOut");
  });

  test("an anomaly alone does not end the poll in failure", () => {
    const verdict = classifyMaterializationReport([
      org({
        platforms: [
          platform({
            expectedCount: 9,
            materializedCount: 0,
            hasCurrentGenerationConversations: false,
          }),
        ],
      }),
    ]);
    expect(decidePollOutcome({ verdict, elapsedMs: 0, timeoutMs: 60_000 })).toBe("verified");
  });

  test("the interval backs off and never decreases", () => {
    expect(pollIntervalMs(0)).toBe(15_000);
    expect(pollIntervalMs(3 * 60_000)).toBe(30_000);
    expect(pollIntervalMs(30 * 60_000)).toBe(60_000);
    let previous = 0;
    for (const m of [0, 1, 2, 5, 10, 20, 45]) {
      const interval = pollIntervalMs(m * 60_000);
      expect(interval, `${m}m`).toBeGreaterThanOrEqual(previous);
      previous = interval;
    }
  });
});

describe("convex run output is parsed strictly", () => {
  test("well-formed JSON is returned", () => {
    expect(parseConvexRunJson('\n{\n  "page": [],\n  "isDone": true\n}\n')).toEqual({
      ok: true,
      value: { page: [], isDone: true },
    });
  });

  test("empty or non-JSON stdout refuses rather than guessing", () => {
    // An empty page would classify as "no orgs", which must not be reachable
    // from "the CLI printed nothing".
    expect(parseConvexRunJson("   \n ").ok).toBe(false);
    const result = parseConvexRunJson("✔ Ran function\n{ not json }");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Refusing to guess/i);
  });

  test("NOTHING from stdout reaches the refusal — not a preview, not V8's message", () => {
    // ⚠️ REGRESSION. This stdout is the materialisation report: organization
    // rows. An earlier revision quoted its "first 200 characters" into a reason
    // that `fail()` writes to a public log and summary — reopening the exact
    // disclosure that `opaqueOrgRef` exists to close, from two functions away.
    //
    // V8's own parse error is a second door: it quotes the offending input back
    // inside the exception message, so `error.message` cannot be repeated
    // either.
    const leakyStdout = 'Ran function\n{"page":[{"orgName":"Al Zriqat Motors","orgId":"kd7abc"}]}';
    const result = parseConvexRunJson(leakyStdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toMatch(/Al Zriqat Motors/);
    expect(result.reason).not.toMatch(/kd7abc/);
    expect(result.reason).not.toMatch(/orgName/);
    expect(result.reason).toMatch(/this log is public/i);
  });
});

describe("values headed for a URL or a log are bounded first", () => {
  test("isFullSha accepts only a 40-character hex string", () => {
    expect(isFullSha(TIP)).toBe(true);
    expect(isFullSha("a".repeat(39))).toBe(false);
    expect(isFullSha("../../etc/passwd")).toBe(false);
    expect(isFullSha(undefined)).toBe(false);
  });

  test("the compare path is allowed, because its own syntax contains dots", () => {
    // ⚠️ REGRESSION, caught before it shipped. The first version of this
    // validator refused any path containing "..", which reads as a sensible
    // traversal guard and refuses `/compare/<sha>...<sha>` — the exact request
    // the ancestry check depends on.
    expect(isSafeApiPath(`/compare/${OLDER}...${TIP}`)).toBe(true);
    expect(isSafeApiPath(`/commits/${TIP}/check-runs`)).toBe(true);
    expect(isSafeApiPath("/commits/main")).toBe(true);
  });

  test("a traversal SEGMENT, a query, a fragment and a relative path are refused", () => {
    for (const path of ["/commits/../../etc", "/..", "/commits/./main", "/commits/main?x=1", "/c#f", "//evil.example/x", "commits/main", ""]) {
      expect(isSafeApiPath(path), path).toBe(false);
    }
  });

  test("forLog flattens newlines and truncates, so a log line stays one line", () => {
    expect(forLog("a\nb\tc")).toBe('"a b c"');
    const long = forLog("x".repeat(500));
    expect(long.length).toBeLessThan(140);
    expect(long.endsWith("…")).toBe(true);
  });
});
