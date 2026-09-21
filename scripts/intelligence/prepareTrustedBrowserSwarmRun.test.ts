import { describe, expect, it } from "vitest";
import { previewNameForRef } from "../e2ePreviewBootstrap.mjs";
import { assembleTrustedBrowserSwarmRun } from "./prepareTrustedBrowserSwarmRun.mjs";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
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
    version: 1,
    previewName: PREVIEW_NAME,
    convexCloudUrl: "https://example-preview.convex.cloud",
    headSha: HEAD_SHA,
    prNumber: PR_NUMBER,
    ...overrides,
  };
}

function assemble(options: {
  impactArtifact?: unknown;
  descriptorArtifact?: unknown;
} = {}) {
  return assembleTrustedBrowserSwarmRun({
    impactArtifact: options.impactArtifact ?? impact(),
    descriptorArtifact: options.descriptorArtifact ?? descriptor(),
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    prNumber: PR_NUMBER,
    runId: "gh-12345-1",
  });
}

describe("trusted browser swarm run assembly", () => {
  it("creates the executable UI Phase-A manifest from trusted impact + descriptor", () => {
    const payload = assemble();

    expect(payload.shouldRun).toBe(true);
    expect(payload.workerCount).toBe(2);
    expect(payload.missionCount).toBe(2);
    expect(payload.impactedInvariants).toEqual([
      { id: "UI-1", severity: "HIGH" },
    ]);
    expect(payload.manifest?.previewName).toBe(PREVIEW_NAME);
    expect(payload.manifest?.expectedCloudUrl).toBe(
      "https://example-preview.convex.cloud",
    );
    expect(
      payload.manifest?.workers
        .flatMap((worker) => worker.missions)
        .map((mission) => mission.family)
        .sort(),
    ).toEqual(["RTL_PARITY", "UI_BACKEND_MISMATCH"]);
  });

  it("produces an explicit trusted no-op when canonical impact is empty", () => {
    const payload = assemble({ impactArtifact: impact([]) });

    expect(payload.shouldRun).toBe(false);
    expect(payload.workerCount).toBe(0);
    expect(payload.missionCount).toBe(0);
    expect(payload.manifest).toBeNull();
  });

  it("fails before workers when a deterministic impacted family lacks a Phase-A handler", () => {
    expect(() =>
      assemble({
        impactArtifact: impact([
          { id: "TEN-1", severity: "CRITICAL" },
        ]),
      }),
    ).toThrow(/no executable handler.*TENANT_ESCAPE/i);
  });

  it("refuses a candidate descriptor from a different exact head", () => {
    expect(() =>
      assemble({
        descriptorArtifact: descriptor({ headSha: "c".repeat(40) }),
      }),
    ).toThrow(/head SHA/);
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
