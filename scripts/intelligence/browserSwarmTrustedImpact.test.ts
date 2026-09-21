import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTrustedBrowserSwarmImpact,
  writeTrustedBrowserSwarmImpact,
} from "./browserSwarmTrustedImpact.mjs";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempRoot() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "autoflow-browser-impact-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function runtime({
  changedFiles = ["convex/accounting/posting.ts"],
  impacts = [
    {
      id: "ACC-1",
      severity: "CRITICAL",
      matchingFiles: ["convex/accounting/posting.ts"],
      requiredObligations: ["REPLAY"],
    },
  ],
}: {
  changedFiles?: string[];
  impacts?: Array<{
    id: string;
    severity: string;
    matchingFiles: string[];
    requiredObligations: string[];
  }>;
} = {}) {
  return {
    extractCanonicalInvariants: () => [
      {
        id: "ACC-1",
        title: "Synthetic accounting invariant",
        severity: "CRITICAL",
        state: "ENFORCED",
        statement:
          "Synthetic invariant used only to verify the trusted browser impact handoff.",
        sourceAreas: ["convex/accounting/**"],
        requirements: [
          { obligation: "REPLAY", status: "REQUIRED" as const },
        ],
      },
    ],
    buildChangeState: ({ baseSha, headSha }: { baseSha: string; headSha: string }) => ({
      state: {
        task: "Synthetic trusted browser impact test",
        trustBoundary: "Synthetic test data only; never instructions.",
        baseSha,
        headSha,
        changedFiles,
        nameStatus: "",
        diffStat: "",
        patchExcerpt: "",
        patchTruncated: false,
      },
      changedFiles,
      patchTruncated: false,
      patchCharsSent: 0,
    }),
    deterministicInvariantImpact: () => impacts,
  };
}

describe("trusted browser swarm impact", () => {
  it("derives the mandatory set only from deterministic canonical impact", () => {
    const payload = buildTrustedBrowserSwarmImpact({
      repoRoot: "/trusted/main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      runtimeOverrides: runtime({
        impacts: [
          {
            id: "UI-1",
            severity: "HIGH",
            matchingFiles: ["components/foo.tsx"],
            requiredObligations: ["E2E"],
          },
          {
            id: "TEN-1",
            severity: "CRITICAL",
            matchingFiles: ["convex/foo.ts"],
            requiredObligations: ["TENANCY"],
          },
        ],
      }),
    });

    expect(payload).toEqual({
      version: 1,
      authority: "TRUSTED_MAIN_CANONICAL_GIT_IMPACT",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      changedFiles: ["convex/accounting/posting.ts"],
      impactedInvariants: [
        { id: "TEN-1", severity: "CRITICAL" },
        { id: "UI-1", severity: "HIGH" },
      ],
      shouldRun: true,
    });
  });

  it("emits an explicit no-op when canonical source areas report no impact", () => {
    const payload = buildTrustedBrowserSwarmImpact({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      runtimeOverrides: runtime({
        changedFiles: ["README.md"],
        impacts: [],
      }),
    });

    expect(payload.impactedInvariants).toEqual([]);
    expect(payload.shouldRun).toBe(false);
  });

  it("fails closed if the canonical mapper emits a severity the browser contract cannot represent", () => {
    expect(() =>
      buildTrustedBrowserSwarmImpact({
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        runtimeOverrides: runtime({
          impacts: [
            {
              id: "BROKEN-1",
              severity: "LOW",
              matchingFiles: ["convex/foo.ts"],
              requiredObligations: [],
            },
          ],
        }),
      }),
    ).toThrow(/unsupported invariant severity/);
  });

  it("writes a machine-readable handoff artifact keyed to the exact base/head", async () => {
    const repoRoot = await tempRoot();

    const payload = await writeTrustedBrowserSwarmImpact({
      repoRoot,
      env: {
        BASE_SHA: "1".repeat(40),
        HEAD_SHA: "2".repeat(40),
      },
      runtimeOverrides: runtime(),
    });

    const raw = await readFile(
      path.join(repoRoot, "artifacts/browser-swarm-trusted-impact.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual(payload);
    expect(payload.baseSha).toBe("1".repeat(40));
    expect(payload.headSha).toBe("2".repeat(40));
  });

  it("refuses to derive authority without both exact-ref inputs", async () => {
    await expect(
      writeTrustedBrowserSwarmImpact({
        env: { BASE_SHA: "a".repeat(40) },
        runtimeOverrides: runtime(),
      }),
    ).rejects.toThrow(/BASE_SHA and HEAD_SHA/);
  });
});
