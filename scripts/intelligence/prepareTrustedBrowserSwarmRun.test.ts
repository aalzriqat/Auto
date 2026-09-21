import { describe, expect, it } from "vitest";
import { previewNameForRef } from "../e2ePreviewBootstrap.mjs";
import { assembleTrustedBrowserSwarmRun } from "./prepareTrustedBrowserSwarmRun.mjs";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const TESTED_SHA = "c".repeat(40);
const PR_NUMBER = 325;
const PREVIEW_NAME = previewNameForRef({
  ref: "refs/pull/325/merge",
  prNumber: "325",
});

function impact(
  impactedInvariants: Array<{
    id: string;
    severity: "CRITICAL" | "HIGH";
  }> = [{ id: "UI-1", severity: "HIGH" }],
) {
  return {
    version: 1,
    authority: "TRUSTED_MAIN_CANONICAL_GIT_IMPACT",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    changedFiles: ["components/applications/cockpit/Foo.tsx"],
    impactedInvariants,
    shouldRun: impactedInvariants.length > 0,
  };
}

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    previewName: PREVIEW_NAME,
    headSha: HEAD_SHA,
    testedSha: TESTED_SHA,
    prNumber: PR_NUMBER,
    ...overrides,
  };
}

function authority(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    authority: "CONVEX_CONTROL_PLANE_AUTHORIZE_PREVIEW",
    previewName: PREVIEW_NAME,
    convexCloudUrl: "https://trusted-preview.convex.cloud",
    deploymentName: "trusted-preview",
    ...overrides,
  };
}

function assemble(options: {
  impactArtifact?: unknown;
  descriptorArtifact?: unknown;
  authorityArtifact?: unknown;
} = {}) {
  return assembleTrustedBrowserSwarmRun({
    impactArtifact: options.impactArtifact ?? impact(),
    descriptorArtifact: options.descriptorArtifact ?? descriptor(),
    authorityArtifact: options.authorityArtifact ?? authority(),
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    prNumber: PR_NUMBER,
  });
}

describe("trusted browser swarm run assembly", () => {
  it("hands exact trusted impact and control-plane preview authority to bounded workers", () => {
    const payload = assemble();

    expect(payload.shouldRun).toBe(true);
    expect(payload.workerCount).toBe(2);
    expect(payload.workerMatrix).toEqual({ worker_index: [1, 2] });
    expect(payload.planningMode).toBe("TRUSTED_WORKER_RECONSTRUCTION");
    expect(payload.impactedInvariants).toEqual([
      { id: "UI-1", severity: "HIGH" },
    ]);
    expect(payload.testedSha).toBe(TESTED_SHA);
    expect(payload.previewName).toBe(PREVIEW_NAME);
    expect(payload.convexCloudUrl).toBe(
      "https://trusted-preview.convex.cloud",
    );
    expect(payload.convexDeploymentName).toBe("trusted-preview");
  });

  it("produces an explicit trusted no-op when canonical impact is empty", () => {
    const payload = assemble({ impactArtifact: impact([]) });

    expect(payload.shouldRun).toBe(false);
    expect(payload.workerCount).toBe(0);
    expect(payload.workerMatrix).toEqual({ worker_index: [] });
    expect(payload.planningMode).toBe("TRUSTED_WORKER_RECONSTRUCTION");
  });

  it("preserves unsupported deterministic impact for the trusted worker planner to reject", () => {
    const payload = assemble({
      impactArtifact: impact([
        { id: "TEN-1", severity: "CRITICAL" },
      ]),
    });

    expect(payload.shouldRun).toBe(true);
    expect(payload.impactedInvariants).toEqual([
      { id: "TEN-1", severity: "CRITICAL" },
    ]);
    expect(payload.workerCount).toBe(2);
    expect(payload.workerMatrix).toEqual({ worker_index: [1, 2] });
  });

  it("refuses a candidate descriptor from a different exact head", () => {
    expect(() =>
      assemble({
        descriptorArtifact: descriptor({ headSha: "c".repeat(40) }),
      }),
    ).toThrow(/head SHA/);
  });

  it("refuses candidate-supplied deployment authority in the descriptor", () => {
    expect(() =>
      assemble({
        descriptorArtifact: descriptor({
          convexCloudUrl: "https://candidate-choice.convex.cloud",
        }),
      }),
    ).toThrow(/unexpected fields/);
  });

  it("refuses a descriptor whose preview name does not match the PR merge ref", () => {
    expect(() =>
      assemble({
        descriptorArtifact: descriptor({
          previewName: "e2e-pr-999-deadbeef00",
        }),
      }),
    ).toThrow(/preview name/);
  });

  it("refuses Convex authority for a different preview name", () => {
    expect(() =>
      assemble({
        authorityArtifact: authority({
          previewName: "e2e-pr-999-deadbeef00",
        }),
      }),
    ).toThrow(/trusted preview name/);
  });

  it("refuses forged Convex authority metadata", () => {
    expect(() =>
      assemble({
        authorityArtifact: authority({
          authority: "CANDIDATE_DESCRIPTOR",
        }),
      }),
    ).toThrow(/metadata/);
  });

  it("refuses an impact artifact whose authority metadata is candidate-controlled", () => {
    expect(() =>
      assemble({
        impactArtifact: {
          ...impact(),
          authority: "CALLER_SUPPLIED",
        },
      }),
    ).toThrow(/invalid authority metadata/);
  });

  it("refuses impact artifacts from another base/head pair", () => {
    expect(() =>
      assemble({
        impactArtifact: {
          ...impact(),
          headSha: "c".repeat(40),
        },
      }),
    ).toThrow(/exact base\/head/);
  });

  it("refuses a forged shouldRun flag that contradicts deterministic impact", () => {
    expect(() =>
      assemble({
        impactArtifact: {
          ...impact([]),
          shouldRun: true,
        },
      }),
    ).toThrow(/shouldRun/);
  });
});
