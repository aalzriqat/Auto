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

describe("Jev historical calibration", () => {
  it("pins unique exact-SHA snapshots without embedding hindsight labels", () => {
    const ids = new Set();
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
        deriveReviewMatrix: ({ invariantImpact }: { invariantImpact: Record<string, number> }) =>
          Object.keys(invariantImpact).length === 0
            ? {
                deterministicRequirements: [],
                jevAdvisoryRequirements: ["review:ui-backend-authority"],
                combinedRequirements: ["review:ui-backend-authority"],
                candidateInvariants: [],
              }
            : {
                deterministicRequirements: [],
                jevAdvisoryRequirements: ["review:ui-backend-authority"],
                combinedRequirements: ["review:ui-backend-authority"],
                candidateInvariants: [{ id: "UI-1", probability: 0.75 }],
              },
      },
    });

    expect(callKinds).toEqual(["blind", "policy"]);
    expect(callJev).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty("state");
    expect(result).not.toHaveProperty("questions");
    expect(result).not.toHaveProperty("invariants");
    expect(result.blind).not.toHaveProperty("invariantImpact");
    expect(result.policy.invariantImpact).toEqual({ "UI-1": 0.75 });
  });

  it("attributes deterministic, blind Jev, and current-policy hits separately", () => {
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
      blind: {
        risks: { ...risks, uiAuthority: 0.8 },
        reviewMatrix: {
          deterministicRequirements: [],
          jevAdvisoryRequirements: ["review:ui-backend-authority"],
          combinedRequirements: ["review:ui-backend-authority"],
          candidateInvariants: [],
        },
      },
      policy: {
        risks: { ...risks, uiAuthority: 0.75 },
        reviewMatrix: {
          deterministicRequirements: [
            "review-invariant:LIFE-1",
            "proof:STATE_TRANSITION",
          ],
          jevAdvisoryRequirements: ["review:ui-backend-authority"],
          combinedRequirements: [
            "proof:STATE_TRANSITION",
            "review-invariant:LIFE-1",
            "review:ui-backend-authority",
          ],
          candidateInvariants: [{ id: "UI-1", probability: 0.72 }],
        },
      },
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
      operationalCombinedHit: true,
      incrementalBlindJevHit: false,
    });
    expect(score.findings[1]).toMatchObject({
      deterministicHit: false,
      blindJevHit: true,
      policyJevHit: true,
      operationalCombinedHit: true,
      incrementalBlindJevHit: true,
      incrementalPolicyJevHit: true,
    });
  });

  it("measures blind and policy review pressure on hidden low-risk controls", () => {
    const result = {
      caseId: "negative-control",
      deterministicImpact: [],
      blind: {
        risks,
        reviewMatrix: {
          deterministicRequirements: [],
          jevAdvisoryRequirements: ["proof:FUZZ", "escalate-risk:externalInput"],
          combinedRequirements: ["proof:FUZZ", "escalate-risk:externalInput"],
          candidateInvariants: [],
        },
      },
      policy: {
        risks,
        reviewMatrix: {
          deterministicRequirements: [],
          jevAdvisoryRequirements: ["proof:BOUNDARY"],
          combinedRequirements: ["proof:BOUNDARY"],
          candidateInvariants: [],
        },
      },
    };
    const score = scoreCalibrationCase(result, {
      control: "NEGATIVE_LOW_RISK",
      findings: [],
    });

    expect(score).toMatchObject({
      negativeControl: true,
      blindAddedRequirements: ["proof:FUZZ", "escalate-risk:externalInput"],
      policyAddedRequirements: ["proof:BOUNDARY"],
      blindEscalationRequirements: ["escalate-risk:externalInput"],
      policyEscalationRequirements: [],
    });
  });

  it("aggregates recall, false-positive pressure, usage, and latency by track", () => {
    const scoredCases = [
      {
        caseId: "positive",
        negativeControl: false,
        findings: [
          {
            id: "a",
            severity: "CRITICAL",
            deterministicHit: false,
            blindJevHit: true,
            policyJevHit: true,
            operationalCombinedHit: true,
            incrementalBlindJevHit: true,
            incrementalPolicyJevHit: true,
          },
          {
            id: "b",
            severity: "HIGH",
            deterministicHit: true,
            blindJevHit: false,
            policyJevHit: false,
            operationalCombinedHit: true,
            incrementalBlindJevHit: false,
            incrementalPolicyJevHit: false,
          },
        ],
        blindAddedRequirements: ["proof:BOUNDARY"],
        policyAddedRequirements: ["proof:BOUNDARY"],
        blindEscalationRequirements: [],
        policyEscalationRequirements: [],
      },
      {
        caseId: "negative",
        negativeControl: true,
        findings: [],
        blindAddedRequirements: ["proof:FUZZ", "escalate-risk:externalInput"],
        policyAddedRequirements: [],
        blindEscalationRequirements: ["escalate-risk:externalInput"],
        policyEscalationRequirements: [],
      },
    ];
    const caseResults = [
      {
        blind: { usage: { input_tokens: 100, output_tokens: 5 }, latencyMs: 200 },
        policy: { usage: { input_tokens: 120, output_tokens: 6 }, latencyMs: 250 },
      },
      {
        blind: { usage: { input_tokens: 50, output_tokens: 2 }, latencyMs: 100 },
        policy: { usage: { input_tokens: 60, output_tokens: 3 }, latencyMs: 120 },
      },
    ];

    expect(aggregateCalibration(scoredCases, caseResults)).toMatchObject({
      cases: 2,
      highCriticalFindings: 2,
      currentDeterministicReplayRecall: 0.5,
      blindJevHighCriticalRecall: 0.5,
      currentPolicyJevHighCriticalRecall: 0.5,
      operationalCombinedHighCriticalRecall: 1,
      incrementalBlindJevHits: 1,
      incrementalPolicyJevHits: 1,
      negativeControlCases: 1,
      blindNegativeControlAddedReviewRate: 1,
      policyNegativeControlAddedReviewRate: 0,
      blindNegativeControlEscalationRate: 1,
      policyNegativeControlEscalationRate: 0,
      usage: {
        blind_input_tokens: 150,
        blind_output_tokens: 7,
        policy_input_tokens: 180,
        policy_output_tokens: 9,
      },
      latency: { blind_ms: 300, policy_ms: 370 },
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
    expect(extraDeterministicRequirementsForFiles(["components/home/Hero.tsx"])).toEqual([]);
  });
});
