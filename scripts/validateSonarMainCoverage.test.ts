import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  validateSonarMainCoverage,
  verifyProducerRun,
  main,
} from "./validateSonarMainCoverage.mjs";

const VALID_SHA = "0d6eafbb1b8d722f947bebdcba2dd7da28ef0ac1";
const OTHER_SHA = "1111111111111111111111111111111111111111";

const VALID_PRODUCER_CONTEXT = {
  runId: 12345,
  runAttempt: 1,
  headSha: VALID_SHA,
  workflowId: 998877,
  workflowPath: ".github/workflows/test.yml",
  workflowName: "Tests",
  repository: "aalzriqat/Auto",
  event: "push",
  ref: "refs/heads/main",
  artifactId: 554433,
  artifactSizeBytes: 12345,
};

function createFixtureDir(): { root: string; coverageDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonar-cov-test-"));
  const coverageDir = path.join(root, "coverage");
  fs.mkdirSync(coverageDir, { recursive: true });

  // Create an allowed candidate file in checkout root: convex/schema.ts
  const convexDir = path.join(root, "convex");
  fs.mkdirSync(convexDir, { recursive: true });
  fs.writeFileSync(path.join(convexDir, "schema.ts"), "export default {};\n");

  const cleanup = () => {
    fs.rmSync(root, { recursive: true, force: true });
  };

  return { root, coverageDir, cleanup };
}

function writeValidArtifact(
  coverageDir: string,
  sha: string = VALID_SHA,
  overrides: Record<string, unknown> = {},
): { bytes: number; sha256: string } {
  fs.writeFileSync(path.join(coverageDir, "tested-merge-sha.txt"), `${sha}\n`);
  const lcovContent = `TN:
SF:convex/schema.ts
DA:1,1
LF:1
LH:1
end_of_record
`;
  const bytes = Buffer.byteLength(lcovContent);
  const sha256 = crypto.createHash("sha256").update(lcovContent).digest("hex");

  const manifest = {
    sha,
    ref: "refs/heads/main",
    workflow: "Tests",
    event_name: "push",
    run_id: 12345,
    run_attempt: 1,
    repository: "aalzriqat/Auto",
    lcovBytes: bytes,
    lcovSha256: sha256,
    sfRecords: 1,
    daRecords: 1,
    timestamp: new Date().toISOString(),
    ...overrides,
  };

  fs.writeFileSync(
    path.join(coverageDir, "coverage-provenance.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(path.join(coverageDir, "lcov.info"), lcovContent);

  return { bytes, sha256 };
}

function createMockFetch(overrides: {
  workflow?: Partial<{ id: number; name: string; path: string; state: string }>;
  run?: Partial<{
    id: number;
    name: string;
    path: string;
    workflow_id: number;
    head_branch: string;
    event: string;
    status: string;
    conclusion: string;
    head_sha: string;
    run_attempt: number;
    head_repository: { full_name: string };
  }>;
  artifacts?: Array<{ id: number; name: string; size_in_bytes: number; expired: boolean }>;
  artifactsTotalCount?: number;
} = {}) {
  const workflowData = {
    id: 998877,
    name: "Tests",
    path: ".github/workflows/test.yml",
    state: "active",
    ...overrides.workflow,
  };
  const runData = {
    id: 12345,
    name: "Tests",
    path: ".github/workflows/test.yml",
    workflow_id: 998877,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: VALID_SHA,
    run_attempt: 1,
    head_repository: { full_name: "aalzriqat/Auto" },
    ...overrides.run,
  };
  const artifacts = overrides.artifacts ?? [
    { id: 554433, name: "coverage-report", size_in_bytes: 12345, expired: false },
  ];
  const totalCount = overrides.artifactsTotalCount ?? artifacts.length;

  return (async (url: string | URL) => {
    const urlStr = String(url);
    if (urlStr.includes("/actions/workflows/test.yml")) {
      return {
        ok: true,
        status: 200,
        json: async () => workflowData,
      };
    }
    if (urlStr.includes("/artifacts")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_count: totalCount,
          artifacts,
        }),
      };
    }
    if (urlStr.includes("/actions/runs/")) {
      return {
        ok: true,
        status: 200,
        json: async () => runData,
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ message: "Not found" }),
    };
  }) as unknown as typeof fetch;
}

describe("validateSonarMainCoverage", () => {
  it("passes cleanly on valid artifact with complete matching trusted producerContext", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const res = validateSonarMainCoverage({
        coverageDir,
        checkoutRoot: root,
        expectedSha: VALID_SHA,
        producerContext: VALID_PRODUCER_CONTEXT,
      });

      expect(res.ok).toBe(true);
      expect(res.sfCount).toBe(1);
      expect(res.daCount).toBe(1);
      expect(res.sha).toBe(VALID_SHA);
      expect(res.runId).toBe(12345);
      expect(res.runAttempt).toBe(1);
      expect(res.artifactId).toBe(554433);
    } finally {
      cleanup();
    }
  });

  it("refuses if producerContext is omitted or null", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          // @ts-expect-error test missing producerContext
          producerContext: undefined,
        }),
      ).toThrow("valid, complete trusted producerContext is mandatory");
    } finally {
      cleanup();
    }
  });

  it("refuses if producerContext runId is not a positive integer", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: { ...VALID_PRODUCER_CONTEXT, runId: 0 },
        }),
      ).toThrow("producerContext runId must be a positive integer");
    } finally {
      cleanup();
    }
  });

  it("refuses if producerContext runAttempt is not a positive integer", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: { ...VALID_PRODUCER_CONTEXT, runAttempt: -1 },
        }),
      ).toThrow("producerContext runAttempt must be a positive integer");
    } finally {
      cleanup();
    }
  });

  it("refuses if producerContext artifactId is not a positive integer", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: { ...VALID_PRODUCER_CONTEXT, artifactId: 0 },
        }),
      ).toThrow("producerContext artifactId must be a positive integer");
    } finally {
      cleanup();
    }
  });

  it("refuses if manifest missing mandatory run_id", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA, { run_id: undefined });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("provenance manifest missing mandatory 'run_id'");
    } finally {
      cleanup();
    }
  });

  it("refuses if manifest missing mandatory run_attempt", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA, { run_attempt: undefined });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("provenance manifest missing mandatory 'run_attempt'");
    } finally {
      cleanup();
    }
  });

  it("refuses if manifest missing mandatory sfRecords", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA, { sfRecords: undefined });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("provenance manifest missing mandatory 'sfRecords'");
    } finally {
      cleanup();
    }
  });

  it("refuses if manifest missing mandatory daRecords", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA, { daRecords: undefined });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("provenance manifest missing mandatory 'daRecords'");
    } finally {
      cleanup();
    }
  });

  it("refuses if manifest run_id does not match trusted producerContext", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA, { run_id: 99999 });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("manifest run_id '99999' does not match trusted producer run_id '12345'");
    } finally {
      cleanup();
    }
  });

  it("refuses if manifest run_attempt does not match trusted producerContext", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA, { run_attempt: 2 });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("manifest run_attempt '2' does not match trusted producer run_attempt '1'");
    } finally {
      cleanup();
    }
  });

  it("refuses if provenance manifest event is not push", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA, { event_name: "pull_request" });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("manifest event 'pull_request' is not 'push'");
    } finally {
      cleanup();
    }
  });

  it("refuses if provenance manifest ref is not refs/heads/main", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA, { ref: "refs/pull/734/merge" });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("manifest ref 'refs/pull/734/merge' is not 'refs/heads/main'");
    } finally {
      cleanup();
    }
  });

  it("refuses if provenance manifest repository is missing or mismatched", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA, { repository: "fork/Auto" });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("provenance repository 'fork/Auto' does not match expected 'aalzriqat/Auto'");
    } finally {
      cleanup();
    }
  });

  it("refuses if provenance manifest SHA-256 does not match lcov.info", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.appendFileSync(path.join(coverageDir, "lcov.info"), "# extra line\n");

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("does not match manifest");
    } finally {
      cleanup();
    }
  });

  it("refuses if tested-merge-sha.txt is missing", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.unlinkSync(path.join(coverageDir, "tested-merge-sha.txt"));

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("tested-merge-sha.txt is absent");
    } finally {
      cleanup();
    }
  });

  it("refuses if coverage was produced for a different SHA", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, OTHER_SHA);

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow(`coverage was produced for SHA '${OTHER_SHA}', expected '${VALID_SHA}'`);
    } finally {
      cleanup();
    }
  });

  it("refuses if lcov.info is empty", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.writeFileSync(path.join(coverageDir, "lcov.info"), "");

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("lcov.info is empty (0 bytes)");
    } finally {
      cleanup();
    }
  });

  it("refuses if coverage contains symlinks", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      try {
        fs.symlinkSync(path.join(coverageDir, "lcov.info"), path.join(coverageDir, "lcov-symlink.info"));
      } catch {
        return; // Skip on platforms without symlink privileges
      }

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: VALID_PRODUCER_CONTEXT,
        }),
      ).toThrow("Trusted Sonar refuses symlink in coverage artifact");
    } finally {
      cleanup();
    }
  });

  it("CLI main returns 0 on success with valid context file and 1 on missing/malformed context file", async () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const contextFile = path.join(root, "producer-context.json");
      fs.writeFileSync(contextFile, JSON.stringify(VALID_PRODUCER_CONTEXT));

      const exit0 = await main([coverageDir, root, VALID_SHA, contextFile]);
      expect(exit0).toBe(0);

      // Nonexistent context file returns 1
      const exitMissingContext = await main([coverageDir, root, VALID_SHA, path.join(root, "nonexistent.json")]);
      expect(exitMissingContext).toBe(1);

      // Malformed context file returns 1
      fs.writeFileSync(contextFile, "not-valid-json");
      const exitMalformed = await main([coverageDir, root, VALID_SHA, contextFile]);
      expect(exitMalformed).toBe(1);

      const usageExit = await main([]);
      expect(usageExit).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("verifyProducerRun", () => {
  it("verifies valid producer run successfully and binds unique artifact ID", async () => {
    const mockFetch = createMockFetch();

    const res = await verifyProducerRun({
      token: "dummy",
      repo: "aalzriqat/Auto",
      runId: 12345,
      expectedSha: VALID_SHA,
      expectedEvent: "push",
      fetchImpl: mockFetch,
    });

    expect(res.verified).toBe(true);
    expect(res.runId).toBe(12345);
    expect(res.runAttempt).toBe(1);
    expect(res.headSha).toBe(VALID_SHA);
    expect(res.artifactId).toBe(554433);
    expect(res.workflowId).toBe(998877);
    expect(res.workflowPath).toBe(".github/workflows/test.yml");
    expect(res.workflowName).toBe("Tests");
  });

  it("refuses if workflow path is not .github/workflows/test.yml", async () => {
    const mockFetch = createMockFetch({
      workflow: { path: ".github/workflows/other.yml" },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("Workflow definition path '.github/workflows/other.yml' does not match expected");
  });

  it("refuses if workflow name is not Tests", async () => {
    const mockFetch = createMockFetch({
      workflow: { name: "Build" },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("Workflow definition name 'Build' does not match expected");
  });

  it("refuses if run workflow_id does not match fixed API identity", async () => {
    const mockFetch = createMockFetch({
      run: { workflow_id: 11111 },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("workflow_id '11111' does not match fixed API identity '998877'");
  });

  it("refuses if run id does not match requested run id", async () => {
    const mockFetch = createMockFetch({
      run: { id: 99999 },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("invalid run id '99999', expected '12345'");
  });

  it("refuses if run_attempt is missing or invalid", async () => {
    const mockFetch = createMockFetch({
      run: { run_attempt: 0 },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("run_attempt must be a positive integer");
  });

  it("refuses if producer run repository does not match expected repo (fork PR branch named main)", async () => {
    const mockFetch = createMockFetch({
      run: { head_repository: { full_name: "fork-user/Auto" } },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("repository 'fork-user/Auto' does not match expected 'aalzriqat/Auto'");
  });

  it("refuses if producer run branch was not main", async () => {
    const mockFetch = createMockFetch({
      run: { head_branch: "feature-branch" },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("Refusing producer run: branch must be 'main', got 'feature-branch'.");
  });

  it("refuses if producer run event was not push", async () => {
    const mockFetch = createMockFetch({
      run: { event: "pull_request" },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        expectedEvent: "push",
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("Refusing producer run: event must be 'push', got 'pull_request'.");
  });

  it("refuses if producer run conclusion was not success", async () => {
    const mockFetch = createMockFetch({
      run: { conclusion: "failure" },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("Refusing producer run: conclusion must be 'success', got 'failure'.");
  });

  it("refuses if producer run head SHA does not match expected SHA", async () => {
    const mockFetch = createMockFetch({
      run: { head_sha: OTHER_SHA },
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(`Refusing producer run: head SHA '${OTHER_SHA}' does not match expected '${VALID_SHA}'.`);
  });

  it("refuses if no non-expired coverage-report artifact found", async () => {
    const mockFetch = createMockFetch({
      artifacts: [
        { id: 111, name: "other-artifact", size_in_bytes: 500, expired: false },
        { id: 222, name: "coverage-report", size_in_bytes: 500, expired: true },
      ],
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("no non-expired 'coverage-report' artifact found for run 12345");
  });

  it("refuses if multiple non-expired coverage-report artifacts found", async () => {
    const mockFetch = createMockFetch({
      artifacts: [
        { id: 111, name: "coverage-report", size_in_bytes: 500, expired: false },
        { id: 222, name: "coverage-report", size_in_bytes: 500, expired: false },
      ],
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("multiple (2) non-expired 'coverage-report' artifacts found for run 12345; expected unique artifact");
  });

  it("refuses if artifact ID is not a positive integer", async () => {
    const mockFetch = createMockFetch({
      artifacts: [
        { id: 0, name: "coverage-report", size_in_bytes: 12345, expired: false },
      ],
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("invalid artifact ID '0'");
  });

  it("refuses if artifact size is not a positive integer", async () => {
    const mockFetch = createMockFetch({
      artifacts: [
        { id: 554433, name: "coverage-report", size_in_bytes: 0, expired: false },
      ],
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("invalid or empty artifact size '0'");
  });

  it("refuses if artifact inventory pagination is truncated / incomplete", async () => {
    const mockFetch = createMockFetch({
      artifacts: [
        { id: 554433, name: "coverage-report", size_in_bytes: 12345, expired: false },
      ],
      artifactsTotalCount: 150, // total_count is 150, but only 1 returned without further pages
    });

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow("incomplete artifact inventory (1 of 150 fetched)");
  });
});
