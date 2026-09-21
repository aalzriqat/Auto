import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_BROWSER_JEV_RESPONSE_BYTES,
  normalizeTrustedBrowserJevResponse,
  runTrustedBrowserJevExploration,
  validateTrustedBrowserJevArtifact,
} from "./trustedBrowserJevSuggestions.mjs";

const expected = {
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  testedSha: "c".repeat(40),
  prNumber: 325,
  runId: "gh-12345-1",
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    model: "jev-latest",
    answers: {
      family__RTL_PARITY: { type: "noul", noul: 0.41 },
      family__UI_BACKEND_MISMATCH: { type: "noul", noul: 0.92 },
    },
    usage: { input_tokens: 120, output_tokens: 12 },
    ...overrides,
  };
}

describe("SCRUM-350 trusted Jev browser exploration", () => {
  it("normalizes only bounded additive executable-family probabilities", () => {
    expect(normalizeTrustedBrowserJevResponse(response())).toEqual({
      model: "jev-latest",
      usage: { input_tokens: 120, output_tokens: 12 },
      suggestions: [
        { family: "UI_BACKEND_MISMATCH", probability: 0.92 },
        { family: "RTL_PARITY", probability: 0.41 },
      ],
    });
  });

  it("rejects malformed or oversized Jev mission input instead of guessing", () => {
    expect(() =>
      normalizeTrustedBrowserJevResponse({
        ...response(),
        answers: {
          ...response().answers,
          subtract__deterministic: { type: "noul", noul: 1 },
        },
      }),
    ).toThrow(/unexpected answer key/i);

    expect(() =>
      normalizeTrustedBrowserJevResponse({
        ...response(),
        padding: "x".repeat(MAX_BROWSER_JEV_RESPONSE_BYTES + 1),
      }),
    ).toThrow(/maximum|size/i);
  });

  it("rejects malformed probabilities and cannot accept caller-provided mission IDs", () => {
    expect(() =>
      normalizeTrustedBrowserJevResponse({
        ...response(),
        answers: {
          family__RTL_PARITY: { type: "noul", noul: -1 },
          family__UI_BACKEND_MISMATCH: { type: "noul", noul: 0.5 },
        },
      }),
    ).toThrow(/probability|Noul/i);

    expect(() =>
      normalizeTrustedBrowserJevResponse({
        ...response(),
        missionId: "candidate-controls-id",
      }),
    ).toThrow(/unexpected top-level/i);
  });

  it("binds the sanitized artifact to exact base/head/tested SHA, PR, and run", () => {
    const artifact = {
      version: 1,
      authority: "TRUSTED_MAIN_JEV_BROWSER_EXPLORATION",
      status: "LIVE",
      ...expected,
      model: "jev-latest",
      usage: { input_tokens: 120, output_tokens: 12 },
      suggestions: [
        { family: "UI_BACKEND_MISMATCH", probability: 0.92 },
      ],
    };
    expect(validateTrustedBrowserJevArtifact(artifact, expected)).toMatchObject(artifact);
    expect(() =>
      validateTrustedBrowserJevArtifact(
        { ...artifact, testedSha: "e".repeat(40) },
        expected,
      ),
    ).toThrow(/testedSha/);
    expect(() =>
      validateTrustedBrowserJevArtifact({ ...artifact, prNumber: 999 }, expected),
    ).toThrow(/prNumber/);
    expect(() =>
      validateTrustedBrowserJevArtifact({ ...artifact, runId: "gh-9-9" }, expected),
    ).toThrow(/runId/);
  });

  it("does not call Jev for a deterministic no-op impact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autoflow-jev-noop-"));
    const callJev = vi.fn();
    try {
      const artifact = await runTrustedBrowserJevExploration({
        repoRoot: root,
        env: {
          BASE_SHA: expected.baseSha,
          HEAD_SHA: expected.headSha,
          TESTED_SHA: expected.testedSha,
          PR_NUMBER: String(expected.prNumber),
          BROWSER_SWARM_RUN_ID: expected.runId,
          TYPESAFE_API_KEY: "secret",
        },
        impactArtifact: {
          version: 1,
          authority: "TRUSTED_MAIN_CANONICAL_GIT_IMPACT",
          baseSha: expected.baseSha,
          headSha: expected.headSha,
          changedFiles: [],
          impactedInvariants: [],
          shouldRun: false,
        },
        runtimeOverrides: { callJev },
      });
      expect(artifact.status).toBe("SKIPPED_NO_IMPACT");
      expect(artifact.suggestions).toEqual([]);
      expect(callJev).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
