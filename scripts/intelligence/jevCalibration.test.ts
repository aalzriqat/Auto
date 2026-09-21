import { describe, expect, it, vi } from "vitest";
import { JEV_CALIBRATION_CASES } from "./jevCalibrationCases.mjs";
import { JEV_CALIBRATION_LABELS } from "./jevCalibrationLabels.mjs";
import {
  aggregateCalibration,
  buildCalibrationObservation,
  runHistoricalCalibrationCase,
  scoreCalibrationCase,
} from "./jevCalibration.mjs";
import { extraDeterministicRequirementsForFiles } from "./jevImpact.mjs";

const risks = {
  economic: 0.1,
  tenancy: 0.1,
  authorization: 0.1,
  replay: 0.1,
  concurrency: 0.1,
  reversal: 0.1,
  lifecycle: 0.1,
  completeness: 0.1,
  externalInput: 0.1,
  uiAuthority: 0.1,
};

const syntheticInvariant = {
  id: "UI-1",
  title: "UI authority",
  severity: "HIGH",
  state: "ENFORCED",
  statement: "UI uses canonical backend authority.",
  sourceAreas: ["components/**"],
  requirements: [{ obligation: "E2E", status: "REQUIRED" }],
};

type CalibrationCase = (typeof JEV_CALIBRATION_CASES)[number];

function syntheticChange(calibrationCase: CalibrationCase) {
  return {
    state: {
      task: "historical impact classification",
      baseSha: calibrationCase.baseSha,
      headSha: calibrationCase.headSha,
      changedFiles: ["components/sales/QuoteDialog.tsx"],
      patchExcerpt: "untrusted historical diff",
    },
    changedFiles: ["components/sales/QuoteDialog.tsx"],
    patchTruncated: false,
    patchCharsSent: 25,
  };
}

function provenanceOverrides(calibrationCase: CalibrationCase) {
  return {
    assertAncestorCommit: () => undefined,
    readCommitTimestamp: () =>
      new Date(calibrationCase.snapshotAt).toISOString(),
  };
}

function matrix({
  deterministicRequirements = [],
  jevAdvisoryRequirements = [],
  candidateInvariants = [],
}: {
  deterministicRequirements?: string[];
  jevAdvisoryRequirements?: string[];
  candidateInvariants?: Array<{ id: string; probability: number }>;
} = {}) {
  return {
    deterministicRequirements,
    jevAdvisoryRequirements,
    combinedRequirements: [
      ...new Set([...deterministicRequirements, ...jevAdvisoryRequirements]),
    ].sort(),
    candidateInvariants,
  };
}

function completeTrack({
  trackRisks = risks,
  invariantImpact = {},
  reviewMatrix = matrix(),
  inputTokens = 10,
  outputTokens = 2,
  latencyMs = 100,
}: {
  trackRisks?: typeof risks;
  invariantImpact?: Record<string, number>;
  reviewMatrix?: ReturnType<typeof matrix>;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
} = {}) {
  return {
    status: "COMPLETE" as const,
    model: "jev-test",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    risks: trackRisks,
    invariantImpact,
    reviewMatrix,
    latencyMs,
  };
}

function unavailableTrack(reason = "provider unavailable") {
  return {
    status: "UNAVAILABLE" as const,
    reason,
    usage: null,
    risks: null,
    invariantImpact: null,
    reviewMatrix: null,
    latencyMs: 50,
  };
}

function deterministicMatrix(requirements: string[] = []) {
  return matrix({ deterministicRequirements: requirements });
}

describe("Jev historical calibration", () => {
  it("pins unique exact-SHA snapshots without embedding hindsight labels", () => {
    const ids = new Set<string>();
    const allowedKeys = ["baseSha", "headSha", "id", "prNumber", "snapshotAt"];

    for (const calibrationCase of JEV_CALIBRATION_CASES) {
      expect([...Object.keys(calibrationCase)].sort()).toEqual(allowedKeys);
      expect(calibrationCase.baseSha).toMatch(/^[0-9a-f]{40}$/);
      expect(calibrationCase.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(ids.has(calibrationCase.id)).toBe(false);
      ids.add(calibrationCase.id);
    }

    expect([...ids].sort()).toEqual(Object.keys(JEV_CALIBRATION_LABELS).sort());
    expect(
      JEV_CALIBRATION_CASES.find((entry) => entry.id === "pr309-pricing-copy")
        ?.snapshotAt,
    ).toBe("2026-09-14T21:03:13Z");

    const snapshotText = JSON.stringify(JEV_CALIBRATION_CASES);
    for (const label of Object.values(JEV_CALIBRATION_LABELS)) {
      for (const finding of label.findings) {
        expect(snapshotText).not.toContain(finding.summary);
        expect(snapshotText).not.toContain(finding.id);
        expect(snapshotText).not.toContain(finding.sourceSeverity);
      }
    }
  });

  it("keeps invariant knowledge out of the primary blind question set", () => {
    const calibrationCase = JEV_CALIBRATION_CASES[0];
    const observation = buildCalibrationObservation({
      calibrationCase,
      runtimeOverrides: {
        ...provenanceOverrides(calibrationCase),
        extractCanonicalInvariants: () => [syntheticInvariant],
        buildChangeState: () => syntheticChange(calibrationCase),
        deterministicInvariantImpact: () => [],
        extraDeterministicRequirementsForFiles: () => [],
      },
    });

    const blindInput = JSON.stringify({
      state: observation.state,
      questions: observation.blindQuestions,
    });
    const policyInput = JSON.stringify({
      state: observation.state,
      questions: observation.policyQuestions,
    });

    expect(blindInput).not.toContain("UI-1");
    expect(blindInput).not.toContain(syntheticInvariant.statement);
    expect(policyInput).toContain("UI-1");
    expect(policyInput).toContain(syntheticInvariant.statement);

    const label = JEV_CALIBRATION_LABELS[calibrationCase.id];
    for (const finding of label.findings) {
      expect(blindInput).not.toContain(finding.summary);
      expect(blindInput).not.toContain(finding.id);
      expect(policyInput).not.toContain(finding.summary);
      expect(policyInput).not.toContain(finding.id);
    }
  });

  it("fails closed when historical provenance does not match the pinned snapshot", () => {
    const calibrationCase = JEV_CALIBRATION_CASES[0];

    expect(() =>
      buildCalibrationObservation({
        calibrationCase,
        runtimeOverrides: {
          assertAncestorCommit: () => undefined,
          readCommitTimestamp: () => "2000-01-01T00:00:00.000Z",
          extractCanonicalInvariants: () => [syntheticInvariant],
          buildChangeState: () => syntheticChange(calibrationCase),
          deterministicInvariantImpact: () => [],
          extraDeterministicRequirementsForFiles: () => [],
        },
      }),
    ).toThrow(/timestamp mismatch/);

    expect(() =>
      buildCalibrationObservation({
        calibrationCase,
        runtimeOverrides: {
          assertAncestorCommit: () => {
            throw new Error("not an ancestor");
          },
          readCommitTimestamp: () =>
            new Date(calibrationCase.snapshotAt).toISOString(),
          extractCanonicalInvariants: () => [syntheticInvariant],
          buildChangeState: () => syntheticChange(calibrationCase),
          deterministicInvariantImpact: () => [],
          extraDeterministicRequirementsForFiles: () => [],
        },
      }),
    ).toThrow(/not an ancestor/);
  });

  it("executes blind Jev before policy replay and returns no raw prompt state", async () => {
    const calibrationCase = JEV_CALIBRATION_CASES[0];
    const callKinds: string[] = [];
    const callJev = vi.fn(async ({ questions }) => {
      const keys = Object.keys(questions);
      const kind = keys.some((key) => key.startsWith("invariant__"))
        ? "policy"
        : "blind";
      callKinds.push(kind);
      return { kind };
    });

    const result = await runHistoricalCalibrationCase({
      calibrationCase,
      apiKey: "synthetic-key",
      runtimeOverrides: {
        ...provenanceOverrides(calibrationCase),
        extractCanonicalInvariants: () => [syntheticInvariant],
        buildChangeState: () => syntheticChange(calibrationCase),
        deterministicInvariantImpact: () => [],
        extraDeterministicRequirementsForFiles: () => [],
        callJev,
        normalizeJevRiskResponse: () => ({
          model: "jev-test",
          usage: { input_tokens: 8, output_tokens: 2 },
          risks: { ...risks, uiAuthority: 0.8 },
          invariantImpact: {},
        }),
        normalizeJevResponse: () => ({
          model: "jev-test",
          usage: { input_tokens: 12, output_tokens: 3 },
          risks: { ...risks, uiAuthority: 0.7 },
          invariantImpact: { "UI-1": 0.75 },
        }),
      },
    });

    expect(callKinds).toEqual(["blind", "policy"]);
    expect(callJev).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty("state");
    expect(result).not.toHaveProperty("questions");
    expect(result).not.toHaveProperty("invariants");
    expect(result.blind).toMatchObject({ status: "COMPLETE" });
    expect(result.blind.invariantImpact).toEqual({});
    expect(result.policy).toMatchObject({ status: "COMPLETE" });
    expect(result.policy.invariantImpact).toEqual({ "UI-1": 0.75 });
  });

  it("preserves unavailable tracks, redacts credentials, and continues policy replay", async () => {
    const calibrationCase = JEV_CALIBRATION_CASES[0];
    let calls = 0;
    const result = await runHistoricalCalibrationCase({
      calibrationCase,
      apiKey: "synthetic-key",
      runtimeOverrides: {
        ...provenanceOverrides(calibrationCase),
        extractCanonicalInvariants: () => [syntheticInvariant],
        buildChangeState: () => syntheticChange(calibrationCase),
        deterministicInvariantImpact: () => [],
        extraDeterministicRequirementsForFiles: () => [],
        callJev: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("synthetic-key provider unavailable\nwith details");
          }
          return { kind: "policy" };
        },
        normalizeJevResponse: () => ({
          model: "jev-test",
          usage: { input_tokens: 12, output_tokens: 3 },
          risks: { ...risks, uiAuthority: 0.7 },
          invariantImpact: { "UI-1": 0.75 },
        }),
      },
    });

    expect(calls).toBe(2);
    expect(result.blind).toMatchObject({
      status: "UNAVAILABLE",
      usage: null,
      risks: null,
    });
    expect(result.blind.reason).not.toContain("synthetic-key");
    expect(result.blind.reason).toContain("[redacted]");
    expect(result.blind.reason).not.toContain("\n");
    expect(result.policy).toMatchObject({ status: "COMPLETE" });
    expect(result.deterministicReviewMatrix).toBeDefined();
  });

  it("attributes deterministic, scrutiny, and escalation hits separately", () => {
    const result = {
      caseId: "synthetic",
      deterministicImpact: [
        {
          id: "LIFE-1",
          severity: "CRITICAL",
          matchingFiles: ["convex/example.ts"],
          requiredObligations: ["STATE_TRANSITION"],
        },
      ],
      deterministicReviewMatrix: deterministicMatrix([
        "review-invariant:LIFE-1",
        "proof:STATE_TRANSITION",
      ]),
      blind: completeTrack({
        trackRisks: { ...risks, uiAuthority: 0.8 },
        reviewMatrix: matrix({
          jevAdvisoryRequirements: [
            "review:ui-backend-authority",
            "escalate-risk:uiAuthority",
          ],
        }),
      }),
      policy: completeTrack({
        trackRisks: { ...risks, uiAuthority: 0.75 },
        invariantImpact: { "UI-1": 0.72 },
        reviewMatrix: matrix({
          deterministicRequirements: [
            "review-invariant:LIFE-1",
            "proof:STATE_TRANSITION",
          ],
          jevAdvisoryRequirements: [
            "review:ui-backend-authority",
            "escalate-risk:uiAuthority",
          ],
          candidateInvariants: [{ id: "UI-1", probability: 0.72 }],
        }),
      }),
    };

    const score = scoreCalibrationCase(result, {
      findings: [
        {
          id: "deterministic",
          severity: "HIGH",
          acceptedInvariantIds: ["LIFE-1"],
          acceptedRiskKeys: [],
          acceptedRequirements: ["proof:STATE_TRANSITION"],
        },
        {
          id: "blind-and-policy",
          severity: "CRITICAL",
          acceptedInvariantIds: ["UI-1"],
          acceptedRiskKeys: ["uiAuthority"],
          acceptedRequirements: ["review:ui-backend-authority"],
        },
      ],
    });

    expect(score.findings[0]).toMatchObject({
      deterministicHit: true,
      blindJevHit: false,
      blindEscalatedHit: false,
      operationalCombinedHit: true,
      incrementalBlindJevHit: false,
    });
    expect(score.findings[1]).toMatchObject({
      deterministicHit: false,
      blindJevHit: true,
      blindEscalatedHit: true,
      policyJevHit: true,
      policyEscalatedHit: true,
      operationalCombinedHit: true,
      incrementalBlindJevHit: true,
      incrementalPolicyJevHit: true,
    });
  });

  it("counts unavailable Jev as a miss without erasing deterministic baseline evidence", () => {
    const result = {
      caseId: "unavailable",
      deterministicImpact: [
        {
          id: "LIFE-1",
          severity: "CRITICAL",
          matchingFiles: ["convex/example.ts"],
          requiredObligations: ["STATE_TRANSITION"],
        },
      ],
      deterministicReviewMatrix: deterministicMatrix(["proof:STATE_TRANSITION"]),
      blind: unavailableTrack(),
      policy: unavailableTrack(),
    };
    const score = scoreCalibrationCase(result, {
      findings: [
        {
          id: "known",
          severity: "CRITICAL",
          acceptedInvariantIds: ["LIFE-1"],
          acceptedRiskKeys: ["lifecycle"],
          acceptedRequirements: ["proof:STATE_TRANSITION"],
        },
      ],
    });

    expect(score.findings[0]).toMatchObject({
      deterministicHit: true,
      blindAvailable: false,
      policyAvailable: false,
      blindJevHit: false,
      policyJevHit: false,
      operationalCombinedHit: true,
    });
    expect(score.blindAddedRequirements).toEqual([]);
    expect(score.policyAddedRequirements).toEqual([]);
  });

  it("measures review pressure only across available low-risk controls", () => {
    const availableScore = scoreCalibrationCase(
      {
        caseId: "negative-available",
        deterministicImpact: [],
        deterministicReviewMatrix: deterministicMatrix(),
        blind: completeTrack({
          reviewMatrix: matrix({
            jevAdvisoryRequirements: [
              "proof:FUZZ",
              "escalate-risk:externalInput",
            ],
          }),
        }),
        policy: completeTrack({
          reviewMatrix: matrix({
            jevAdvisoryRequirements: ["proof:BOUNDARY"],
          }),
        }),
      },
      { control: "NEGATIVE_LOW_RISK", findings: [] },
    );
    const unavailableScore = scoreCalibrationCase(
      {
        caseId: "negative-unavailable",
        deterministicImpact: [],
        deterministicReviewMatrix: deterministicMatrix(),
        blind: unavailableTrack(),
        policy: unavailableTrack(),
      },
      { control: "NEGATIVE_LOW_RISK", findings: [] },
    );

    const metrics = aggregateCalibration(
      [availableScore, unavailableScore],
      [
        {
          blind: completeTrack({ inputTokens: 50, outputTokens: 2 }),
          policy: completeTrack({ inputTokens: 60, outputTokens: 3 }),
        },
        {
          blind: unavailableTrack(),
          policy: unavailableTrack(),
        },
      ],
    );

    expect(metrics).toMatchObject({
      negativeControlCases: 2,
      blindAvailableNegativeControlCases: 1,
      policyAvailableNegativeControlCases: 1,
      blindNegativeControlAddedReviewRate: 1,
      policyNegativeControlAddedReviewRate: 1,
      blindNegativeControlEscalationRate: 1,
      policyNegativeControlEscalationRate: 0,
      blindTrackAvailabilityRate: 0.5,
      policyTrackAvailabilityRate: 0.5,
      unavailableTracks: 2,
    });
  });

  it("aggregates recall, escalation, usage, and latency by track", () => {
    const positive = scoreCalibrationCase(
      {
        caseId: "positive",
        deterministicImpact: [
          {
            id: "LIFE-1",
            severity: "CRITICAL",
            matchingFiles: ["convex/example.ts"],
            requiredObligations: ["STATE_TRANSITION"],
          },
        ],
        deterministicReviewMatrix: deterministicMatrix([
          "proof:STATE_TRANSITION",
        ]),
        blind: completeTrack({
          trackRisks: { ...risks, uiAuthority: 0.8 },
          reviewMatrix: matrix({
            jevAdvisoryRequirements: [
              "review:ui-backend-authority",
              "escalate-risk:uiAuthority",
            ],
          }),
          inputTokens: 100,
          outputTokens: 5,
          latencyMs: 200,
        }),
        policy: completeTrack({
          trackRisks: { ...risks, uiAuthority: 0.7 },
          invariantImpact: { "UI-1": 0.7 },
          reviewMatrix: matrix({
            deterministicRequirements: ["proof:STATE_TRANSITION"],
            jevAdvisoryRequirements: [
              "review:ui-backend-authority",
              "escalate-risk:uiAuthority",
            ],
            candidateInvariants: [{ id: "UI-1", probability: 0.7 }],
          }),
          inputTokens: 120,
          outputTokens: 6,
          latencyMs: 250,
        }),
      },
      {
        findings: [
          {
            id: "a",
            severity: "CRITICAL",
            acceptedInvariantIds: ["UI-1"],
            acceptedRiskKeys: ["uiAuthority"],
            acceptedRequirements: ["review:ui-backend-authority"],
          },
          {
            id: "b",
            severity: "HIGH",
            acceptedInvariantIds: ["LIFE-1"],
            acceptedRiskKeys: [],
            acceptedRequirements: ["proof:STATE_TRANSITION"],
          },
        ],
      },
    );

    const result = {
      blind: completeTrack({
        inputTokens: 100,
        outputTokens: 5,
        latencyMs: 200,
      }),
      policy: completeTrack({
        inputTokens: 120,
        outputTokens: 6,
        latencyMs: 250,
      }),
    };

    expect(aggregateCalibration([positive], [result])).toMatchObject({
      cases: 1,
      highCriticalFindings: 2,
      currentDeterministicReplayRecall: 0.5,
      blindJevHighCriticalRecall: 0.5,
      blindJevHighCriticalEscalationRecall: 0.5,
      currentPolicyJevHighCriticalRecall: 0.5,
      currentPolicyJevHighCriticalEscalationRecall: 0.5,
      operationalCombinedHighCriticalRecall: 1,
      incrementalBlindJevHits: 1,
      incrementalPolicyJevHits: 1,
      blindTrackAvailabilityRate: 1,
      policyTrackAvailabilityRate: 1,
      unavailableTracks: 0,
      usage: {
        blind_input_tokens: 100,
        blind_output_tokens: 5,
        policy_input_tokens: 120,
        policy_output_tokens: 6,
      },
      latency: { blind_ms: 200, policy_ms: 250 },
    });
  });

  it("uses the same fail-closed governance routing in live and historical modes", () => {
    expect(
      extraDeterministicRequirementsForFiles([
        ".github/workflows/jev-historical-calibration.yml",
      ]),
    ).toEqual(["review:correctness-governance", "proof:jev-harness"]);
    expect(
      extraDeterministicRequirementsForFiles([
        "scripts/intelligence/jevCalibration.mjs",
      ]),
    ).toEqual(["review:correctness-governance", "proof:jev-harness"]);
    expect(
      extraDeterministicRequirementsForFiles(["components/home/Hero.tsx"]),
    ).toEqual([]);
  });
});
