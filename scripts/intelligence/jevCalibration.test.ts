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
    const snapshotText = JSON.stringify(JEV_CALIBRATION_CASES);
    for (const label of Object.values(JEV_CALIBRATION_LABELS)) {
      for (const finding of label.findings) {
        expect(snapshotText).not.toContain(finding.summary);
        expect(snapshotText).not.toContain(finding.id);
      }
    }
  });

  it("builds model input without hindsight findings", () => {
    const calibrationCase = JEV_CALIBRATION_CASES[0];
    const observation = buildCalibrationObservation({
      calibrationCase,
      runtimeOverrides: {
        extractCanonicalInvariants: () => [
          {
            id: "UI-1",
            title: "UI authority",
            severity: "HIGH",
            state: "ENFORCED",
            statement: "UI uses canonical backend authority.",
            sourceAreas: ["components/**"],
            requirements: [{ obligation: "E2E", status: "REQUIRED" }],
          },
        ],
        buildChangeState: () => ({
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
        }),
        deterministicInvariantImpact: () => [],
        extraDeterministicRequirementsForFiles: () => [],
        buildJevQuestions: () => ({ q: { type: "noul" } }),
      },
    });

    const modelInput = JSON.stringify({
      state: observation.state,
      questions: observation.questions,
    });
    const label = JEV_CALIBRATION_LABELS[calibrationCase.id];
    for (const finding of label.findings) {
      expect(modelInput).not.toContain(finding.summary);
      expect(modelInput).not.toContain(finding.id);
      expect(modelInput).not.toContain(finding.severity);
    }
  });

  it("runs Jev before scoring and returns only sanitized observation evidence", async () => {
    const calibrationCase = JEV_CALIBRATION_CASES[0];
    let capturedState: unknown;
    const callJev = vi.fn(async ({ state }) => {
      capturedState = state;
      return { opaque: true };
    });

    const result = await runHistoricalCalibrationCase({
      calibrationCase,
      apiKey: "synthetic-key",
      runtimeOverrides: {
        extractCanonicalInvariants: () => [{ id: "UI-1" }],
        buildChangeState: () => ({
          state: {
            task: "historical impact classification",
            baseSha: calibrationCase.baseSha,
            headSha: calibrationCase.headSha,
            changedFiles: ["convex/quotes.ts"],
            patchExcerpt: "diff",
          },
          changedFiles: ["convex/quotes.ts"],
          patchTruncated: false,
          patchCharsSent: 4,
        }),
        deterministicInvariantImpact: () => [],
        extraDeterministicRequirementsForFiles: () => [],
        buildJevQuestions: () => ({ q: { type: "noul" } }),
        callJev,
        normalizeJevResponse: () => ({
          model: "jev-test",
          usage: { input_tokens: 10, output_tokens: 2 },
          risks: { ...risks, uiAuthority: 0.8 },
          invariantImpact: { "UI-1": 0.7 },
        }),
        deriveReviewMatrix: () => ({
          deterministicRequirements: [],
          jevAdvisoryRequirements: ["review:ui-backend-authority"],
          combinedRequirements: ["review:ui-backend-authority"],
          candidateInvariants: [{ id: "UI-1", probability: 0.7 }],
        }),
      },
    });

    expect(callJev).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(capturedState)).not.toContain("caller-contract-break");
    expect(result).not.toHaveProperty("state");
    expect(result).not.toHaveProperty("questions");
    expect(result).not.toHaveProperty("invariants");
    expect(result.reviewMatrix.jevAdvisoryRequirements).toContain(
      "review:ui-backend-authority",
    );
  });

  it("attributes deterministic and incremental Jev hits separately", () => {
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
      risks: { ...risks, uiAuthority: 0.8 },
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
          id: "jev-only",
          severity: "CRITICAL",
          acceptedInvariantIds: ["UI-1"],
          acceptedRiskKeys: ["uiAuthority"],
          acceptedRequirements: ["review:ui-backend-authority"],
        },
      ],
    });

    expect(score.findings[0]).toMatchObject({
      deterministicHit: true,
      combinedHit: true,
      incrementalJevHit: false,
    });
    expect(score.findings[1]).toMatchObject({
      deterministicHit: false,
      jevHit: true,
      combinedHit: true,
      incrementalJevHit: true,
    });
    expect(score.addedRequirements).toEqual(["review:ui-backend-authority"]);
  });

  it("aggregates High/Critical recall, incremental hits, tokens, and added load", () => {
    const scoredCases = [
      {
        caseId: "one",
        findings: [
          {
            id: "a",
            severity: "CRITICAL",
            deterministicHit: false,
            jevHit: true,
            combinedHit: true,
            incrementalJevHit: true,
          },
          {
            id: "b",
            severity: "HIGH",
            deterministicHit: true,
            jevHit: false,
            combinedHit: true,
            incrementalJevHit: false,
          },
        ],
        addedRequirements: ["proof:BOUNDARY"],
      },
    ];
    const caseResults = [
      {
        usage: { input_tokens: 100, output_tokens: 5 },
        latencyMs: 200,
      },
    ];

    expect(aggregateCalibration(scoredCases, caseResults)).toMatchObject({
      cases: 1,
      highCriticalFindings: 2,
      deterministicHighCriticalRecall: 0.5,
      jevHighCriticalRecall: 0.5,
      combinedHighCriticalRecall: 1,
      incrementalJevHits: 1,
      extraReviewRequirements: 1,
      uniqueExtraReviewRequirements: ["proof:BOUNDARY"],
      usage: { input_tokens: 100, output_tokens: 5 },
      totalLatencyMs: 200,
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
