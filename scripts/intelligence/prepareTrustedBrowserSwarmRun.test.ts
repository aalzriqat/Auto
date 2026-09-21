import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewNameForRef } from "../e2ePreviewBootstrap.mjs";
import {
  assembleTrustedBrowserSwarmRun,
  prepareTrustedBrowserSwarmRun,
} from "./prepareTrustedBrowserSwarmRun.mjs";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const TESTED_SHA = "c".repeat(40);
const PR_NUMBER = 325;
const RUN_ID = "gh-12345-1";
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

function jev(
  status: "LIVE" | "SKIPPED_NO_IMPACT" = "LIVE",
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    authority: "TRUSTED_MAIN_JEV_BROWSER_EXPLORATION",
    status,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    testedSha: TESTED_SHA,
    prNumber: PR_NUMBER,
    runId: RUN_ID,
    model: status === "LIVE" ? "jev-latest" : null,
    usage:
      status === "LIVE"
        ? { input_tokens: 100, output_tokens: 10 }
        : null,
    suggestions:
      status === "LIVE"
        ? [{ family: "UI_BACKEND_MISMATCH", probability: 0.82 }]
        : [],
    ...overrides,
  };
}

function assemble(options: {
  impactArtifact?: unknown;
  descriptorArtifact?: unknown;
  authorityArtifact?: unknown;
  jevArtifact?: unknown;
} = {}) {
  const impactArtifact = options.impactArtifact ?? impact();
  const shouldRun =
    Boolean(
      impactArtifact &&
        typeof impactArtifact === "object" &&
        !Array.isArray(impactArtifact) &&
        (impactArtifact as { shouldRun?: unknown }).shouldRun === true,
    );

  return assembleTrustedBrowserSwarmRun({
    impactArtifact,
    descriptorArtifact: options.descriptorArtifact ?? descriptor(),
    authorityArtifact: options.authorityArtifact ?? authority(),
    jevArtifact:
      options.jevArtifact ??
      jev(shouldRun ? "LIVE" : "SKIPPED_NO_IMPACT"),
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    testedSha: TESTED_SHA,
    prNumber: PR_NUMBER,
    runId: RUN_ID,
  });
}

describe("trusted browser swarm run assembly", () => {
  it("writes the trusted run artifact and GitHub outputs from bounded handoff files", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "autoflow-swarm-run-"));
    try {
      const artifactsDir = path.join(repoRoot, "artifacts");
      const descriptorPath = path.join(repoRoot, "descriptor.json");
      const githubOutput = path.join(repoRoot, "github-output.txt");
      await mkdir(artifactsDir, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(artifactsDir, "browser-swarm-trusted-impact.json"),
          JSON.stringify(impact()),
          "utf8",
        ),
        writeFile(
          path.join(artifactsDir, "browser-swarm-convex-authority.json"),
          JSON.stringify(authority()),
          "utf8",
        ),
        writeFile(
          path.join(artifactsDir, "browser-swarm-jev-suggestions.json"),
          JSON.stringify(jev()),
          "utf8",
        ),
        writeFile(descriptorPath, JSON.stringify(descriptor()), "utf8"),
        writeFile(githubOutput, "", "utf8"),
      ]);

      const payload = await prepareTrustedBrowserSwarmRun({
        repoRoot,
        env: {
          BASE_SHA,
          HEAD_SHA,
          TESTED_SHA,
          PR_NUMBER: String(PR_NUMBER),
          BROWSER_SWARM_RUN_ID: RUN_ID,
          PREVIEW_DESCRIPTOR_PATH: descriptorPath,
          GITHUB_OUTPUT: githubOutput,
        },
      });

      const persisted = JSON.parse(
        await readFile(
          path.join(artifactsDir, "browser-swarm-trusted-run.json"),
          "utf8",
        ),
      );
      expect(persisted).toEqual(payload);
      expect(persisted.testedSha).toBe(TESTED_SHA);

      const outputs = await readFile(githubOutput, "utf8");
      expect(outputs).toContain("should_run=true");
      expect(outputs).toContain('worker_matrix={"worker_index":[1,2]}');
      expect(outputs).toContain("tested_sha=" + TESTED_SHA);
      expect(outputs).toContain(
        'jev_suggestions_json=[{"family":"UI_BACKEND_MISMATCH","probability":0.82}]',
      );
      expect(outputs).toContain("preview_name=" + PREVIEW_NAME);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a trusted handoff file is not valid JSON", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "autoflow-swarm-invalid-"));
    try {
      const artifactsDir = path.join(repoRoot, "artifacts");
      const descriptorPath = path.join(repoRoot, "descriptor.json");
      await mkdir(artifactsDir, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(artifactsDir, "browser-swarm-trusted-impact.json"),
          JSON.stringify(impact()),
          "utf8",
        ),
        writeFile(
          path.join(artifactsDir, "browser-swarm-convex-authority.json"),
          JSON.stringify(authority()),
          "utf8",
        ),
        writeFile(
          path.join(artifactsDir, "browser-swarm-jev-suggestions.json"),
          JSON.stringify(jev()),
          "utf8",
        ),
        writeFile(descriptorPath, "{not-json", "utf8"),
      ]);

      await expect(
        prepareTrustedBrowserSwarmRun({
          repoRoot,
          env: {
            BASE_SHA,
            HEAD_SHA,
            TESTED_SHA,
            PR_NUMBER: String(PR_NUMBER),
            BROWSER_SWARM_RUN_ID: RUN_ID,
            PREVIEW_DESCRIPTOR_PATH: descriptorPath,
          },
        }),
      ).rejects.toThrow(/valid JSON/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("hands exact deterministic impact, bounded Jev additions, and preview authority to workers", () => {
    const payload = assemble();

    expect(payload.shouldRun).toBe(true);
    expect(payload.workerCount).toBe(2);
    expect(payload.workerMatrix).toEqual({ worker_index: [1, 2] });
    expect(payload.planningMode).toBe(
      "TRUSTED_DETERMINISTIC_PLUS_BOUNDED_JEV",
    );
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.impactedInvariants).toEqual([
      { id: "UI-1", severity: "HIGH" },
    ]);
    expect(payload.jevExploration).toMatchObject({
      status: "LIVE",
      suggestions: [
        { family: "UI_BACKEND_MISMATCH", probability: 0.82 },
      ],
    });
    expect(payload.testedSha).toBe(TESTED_SHA);
    expect(payload.previewName).toBe(PREVIEW_NAME);
    expect(payload.convexCloudUrl).toBe(
      "https://trusted-preview.convex.cloud",
    );
    expect(payload.convexDeploymentName).toBe("trusted-preview");
  });

  it("produces an explicit trusted no-op and does not admit Jev work when canonical impact is empty", () => {
    const payload = assemble({ impactArtifact: impact([]) });

    expect(payload.shouldRun).toBe(false);
    expect(payload.workerCount).toBe(0);
    expect(payload.workerMatrix).toEqual({ worker_index: [] });
    expect(payload.planningMode).toBe(
      "TRUSTED_DETERMINISTIC_PLUS_BOUNDED_JEV",
    );
    expect(payload.jevExploration).toEqual({
      status: "SKIPPED_NO_IMPACT",
      model: null,
      usage: null,
      suggestions: [],
    });
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

  it("refuses candidate-supplied tested SHA authority in the descriptor", () => {
    expect(() =>
      assemble({
        descriptorArtifact: descriptor({
          testedSha: TESTED_SHA,
        }),
      }),
    ).toThrow(/unexpected fields/);
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

  it("refuses Jev exploration from another tested SHA, PR, or run", () => {
    expect(() =>
      assemble({
        jevArtifact: jev("LIVE", { testedSha: "e".repeat(40) }),
      }),
    ).toThrow(/testedSha/);
    expect(() =>
      assemble({
        jevArtifact: jev("LIVE", { prNumber: 999 }),
      }),
    ).toThrow(/prNumber/);
    expect(() =>
      assemble({
        jevArtifact: jev("LIVE", { runId: "gh-999-9" }),
      }),
    ).toThrow(/runId/);
  });

  it("refuses live Jev on a deterministic no-op and skipped Jev on impacted work", () => {
    expect(() =>
      assemble({
        impactArtifact: impact([]),
        jevArtifact: jev("LIVE"),
      }),
    ).toThrow(/must skip Jev/);
    expect(() =>
      assemble({
        impactArtifact: impact(),
        jevArtifact: jev("SKIPPED_NO_IMPACT"),
      }),
    ).toThrow(/requires live trusted Jev/);
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
