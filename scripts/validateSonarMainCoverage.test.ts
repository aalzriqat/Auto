import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LCOV_BYTES,
  checkSymlinks,
  isEntrypoint,
  main,
  runAsScript,
  safeLogValue,
  validateSonarMainCoverage,
  verifyProducerRun,
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

/** The window of the one successful `unit-and-integration` job that uploads `coverage-report`. */
const JOB_STARTED = "2026-10-31T10:00:00Z";
const JOB_COMPLETED = "2026-10-31T10:10:00Z";
const IN_WINDOW = "2026-10-31T10:09:00Z";

type MockArtifact = {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  created_at?: string | null;
};

type MockJob = {
  id: number;
  name: string;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};

/** One record of the coverage job, as the jobs API (`filter=all`) lists it for an attempt. */
function producerJob(attempt: number, overrides: Partial<MockJob> = {}): MockJob {
  return {
    id: 9000 + attempt,
    name: "unit-and-integration",
    run_attempt: attempt,
    status: "completed",
    conclusion: "success",
    started_at: JOB_STARTED,
    completed_at: JOB_COMPLETED,
    ...overrides,
  };
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
  artifacts?: MockArtifact[];
  artifactsTotalCount?: number;
  jobs?: MockJob[];
  jobsTotalCount?: number;
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
  // An artifact that states no created_at is uploaded inside the default producer job window.
  const artifacts = (
    overrides.artifacts ?? [{ id: 554433, name: "coverage-report", size_in_bytes: 12345, expired: false }]
  ).map((artifact) => ("created_at" in artifact ? artifact : { ...artifact, created_at: IN_WINDOW }));
  const totalCount = overrides.artifactsTotalCount ?? artifacts.length;
  const jobs = overrides.jobs ?? [producerJob(1)];
  const jobsTotalCount = overrides.jobsTotalCount ?? jobs.length;

  return (async (url: string | URL) => {
    const urlStr = String(url);
    if (urlStr.includes("/actions/workflows/test.yml")) {
      return {
        ok: true,
        status: 200,
        json: async () => workflowData,
      };
    }
    if (/\/actions\/runs\/\d+\/jobs/.test(urlStr)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ total_count: jobsTotalCount, jobs }),
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

  it.each([
    ["token", { token: "" }],
    ["repo", { repo: "" }],
    ["runId", { runId: 0 }],
    ["expectedSha", { expectedSha: "" }],
  ])("refuses before any request when %s is missing", async (_name, missing) => {
    const fetchImpl = vi.fn(createMockFetch());

    await expect(
      verifyProducerRun({
        token: "dummy",
        repo: "aalzriqat/Auto",
        runId: 12345,
        expectedSha: VALID_SHA,
        fetchImpl,
        ...missing,
      }),
    ).rejects.toThrow("verifyProducerRun requires token, repo, runId, and expectedSha.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the workflow definition cannot be fetched", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;

    await expect(
      verifyProducerRun({ token: "dummy", repo: "aalzriqat/Auto", runId: 12345, expectedSha: VALID_SHA, fetchImpl }),
    ).rejects.toThrow("Could not fetch workflow definition from GitHub API (HTTP 500).");
  });

  it("refuses when the workflow definition has no workflow ID", async () => {
    const mockFetch = createMockFetch({ workflow: { id: 0 } });

    await expect(
      verifyProducerRun({ token: "dummy", repo: "aalzriqat/Auto", runId: 12345, expectedSha: VALID_SHA, fetchImpl: mockFetch }),
    ).rejects.toThrow("Workflow definition returned by GitHub API missing workflow ID.");
  });

  it("refuses when the producer run cannot be fetched", async () => {
    const base = createMockFetch();
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/actions/runs/12345")) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return base(url, init);
    }) as unknown as typeof fetch;

    await expect(
      verifyProducerRun({ token: "dummy", repo: "aalzriqat/Auto", runId: 12345, expectedSha: VALID_SHA, fetchImpl }),
    ).rejects.toThrow("Could not fetch producer run 12345 from GitHub API (HTTP 503).");
  });

  it("refuses if producer run workflow name is not Tests", async () => {
    const mockFetch = createMockFetch({ run: { name: "Build" } });

    await expect(
      verifyProducerRun({ token: "dummy", repo: "aalzriqat/Auto", runId: 12345, expectedSha: VALID_SHA, fetchImpl: mockFetch }),
    ).rejects.toThrow("Refusing producer run: workflow name must be 'Tests', got 'Build'.");
  });

  it("refuses if producer run workflow path is not .github/workflows/test.yml", async () => {
    const mockFetch = createMockFetch({ run: { path: ".github/workflows/other.yml" } });

    await expect(
      verifyProducerRun({ token: "dummy", repo: "aalzriqat/Auto", runId: 12345, expectedSha: VALID_SHA, fetchImpl: mockFetch }),
    ).rejects.toThrow(
      "Refusing producer run: workflow path must be '.github/workflows/test.yml', got '.github/workflows/other.yml'.",
    );
  });

  it("refuses if producer run has not completed", async () => {
    const mockFetch = createMockFetch({ run: { status: "in_progress" } });

    await expect(
      verifyProducerRun({ token: "dummy", repo: "aalzriqat/Auto", runId: 12345, expectedSha: VALID_SHA, fetchImpl: mockFetch }),
    ).rejects.toThrow("Refusing producer run: status must be 'completed', got 'in_progress'.");
  });

  describe("artifact inventory API", () => {
    function artifactsFetch(
      respond: (page: number) => unknown,
      requests: string[] = [],
    ): typeof fetch {
      const base = createMockFetch();
      return (async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (!urlStr.includes("/artifacts")) {
          return base(url, init);
        }
        requests.push(urlStr);
        const page = Number(new URL(urlStr).searchParams.get("page"));
        const body = respond(page);
        if (typeof body === "number") {
          return { ok: false, status: body, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => body };
      }) as unknown as typeof fetch;
    }

    const filler = (count: number, firstId: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: firstId + i,
        name: "other-artifact",
        size_in_bytes: 1,
        expired: false,
      }));

    const verify = (fetchImpl: typeof fetch) =>
      verifyProducerRun({ token: "dummy", repo: "aalzriqat/Auto", runId: 12345, expectedSha: VALID_SHA, fetchImpl });

    it("refuses when the artifact listing cannot be fetched", async () => {
      await expect(verify(artifactsFetch(() => 502))).rejects.toThrow(
        "Could not fetch artifacts for producer run 12345 (HTTP 502).",
      );
    });

    it("refuses with a TypeError when total_count is not a number", async () => {
      const error = await verify(artifactsFetch(() => ({ total_count: "1", artifacts: [] }))).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        "Refusing producer run: invalid artifacts API response, total_count is not a number.",
      );
    });

    it("refuses with a TypeError when the artifacts array is missing", async () => {
      const error = await verify(artifactsFetch(() => ({ total_count: 1 }))).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        "Refusing producer run: invalid artifacts API response, artifacts array missing.",
      );
    });

    it("reads every page with the bearer token and finds the artifact on the later page", async () => {
      const requests: string[] = [];
      const wanted = { id: 777, name: "coverage-report", size_in_bytes: 4096, expired: false, created_at: IN_WINDOW };
      const fetchImpl = artifactsFetch(
        (page) => ({
          total_count: 101,
          artifacts: page === 1 ? filler(100, 1000) : [wanted],
        }),
        requests,
      );

      const res = await verify(fetchImpl);

      expect(res.artifactId).toBe(777);
      expect(res.artifactSizeBytes).toBe(4096);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain("per_page=100&page=1");
      expect(requests[1]).toContain("per_page=100&page=2");
    });

    it("sends the bearer token and GitHub API headers on every request", async () => {
      const seen: Array<Record<string, string>> = [];
      const base = createMockFetch();
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return base(url, init);
      }) as unknown as typeof fetch;

      await verify(fetchImpl);

      // workflow definition, producer run, producer jobs, artifact inventory
      expect(seen).toHaveLength(4);
      for (const headers of seen) {
        expect(headers.authorization).toBe("Bearer dummy");
        expect(headers.accept).toBe("application/vnd.github+json");
      }
    });

    it("refuses an inventory that needs more than 10 pages", async () => {
      const requests: string[] = [];
      const fetchImpl = artifactsFetch(
        (page) => ({ total_count: 5000, artifacts: filler(100, page * 1000) }),
        requests,
      );

      await expect(verify(fetchImpl)).rejects.toThrow(
        "Refusing producer run: artifact pagination exceeded 10 pages (1000/5000 fetched).",
      );
      expect(requests).toHaveLength(10);
    });
  });
});

describe("verifyProducerRun producer job and attempt binding (SCRUM-764 M1)", () => {
  const SECOND_STARTED = "2026-10-31T11:00:00Z";
  const SECOND_COMPLETED = "2026-10-31T11:10:00Z";
  const SECOND_IN_WINDOW = "2026-10-31T11:09:00Z";

  const coverage = (id: number, createdAt: string | null = IN_WINDOW): MockArtifact => ({
    id,
    name: "coverage-report",
    size_in_bytes: 4096,
    expired: false,
    created_at: createdAt,
  });

  const verify = (overrides: Parameters<typeof createMockFetch>[0]) =>
    verifyProducerRun({
      token: "dummy",
      repo: "aalzriqat/Auto",
      runId: 12345,
      expectedSha: VALID_SHA,
      fetchImpl: createMockFetch(overrides),
    });

  it("binds to the attempt that executed the coverage job after Re-run failed jobs reused it", async () => {
    // Live shape (run 40799037554): attempt 2 lists a reused copy of the attempt-1 job with the same window.
    const res = await verify({
      run: { run_attempt: 2 },
      jobs: [producerJob(1), producerJob(2)],
      artifacts: [coverage(701)],
    });

    expect(res.runAttempt).toBe(1);
    expect(res.artifactId).toBe(701);
  });

  it("binds to the original attempt when the job was reused more than once", async () => {
    const res = await verify({
      run: { run_attempt: 3 },
      jobs: [producerJob(1), producerJob(2), producerJob(3)],
      artifacts: [coverage(701)],
    });

    expect(res.runAttempt).toBe(1);
  });

  it("selects the new artifact after Re-run all jobs left one artifact per attempt", async () => {
    const res = await verify({
      run: { run_attempt: 2 },
      jobs: [
        producerJob(1),
        producerJob(2, { started_at: SECOND_STARTED, completed_at: SECOND_COMPLETED }),
      ],
      artifacts: [coverage(701), coverage(702, SECOND_IN_WINDOW)],
    });

    expect(res.runAttempt).toBe(2);
    expect(res.artifactId).toBe(702);
  });

  it("ignores the artifact a failed first attempt uploaded before the job was re-run", async () => {
    const res = await verify({
      run: { run_attempt: 2 },
      jobs: [
        producerJob(1, { conclusion: "failure" }),
        producerJob(2, { started_at: SECOND_STARTED, completed_at: SECOND_COMPLETED }),
      ],
      artifacts: [coverage(701), coverage(702, SECOND_IN_WINDOW)],
    });

    expect(res.runAttempt).toBe(2);
    expect(res.artifactId).toBe(702);
  });

  it("accepts an artifact created exactly at the start or the end of the job window", async () => {
    for (const edge of [JOB_STARTED, JOB_COMPLETED]) {
      const res = await verify({ jobs: [producerJob(1)], artifacts: [coverage(701, edge)] });
      expect(res.artifactId).toBe(701);
    }
  });

  it("ignores the per-slice jobs and other jobs whose name only starts with the coverage job name", async () => {
    const res = await verify({
      jobs: [
        producerJob(1, { id: 1, name: "unit-and-integration slice 1/4", conclusion: "failure" }),
        producerJob(1, { id: 2, name: "unit-and-integration-extra", conclusion: "failure" }),
        producerJob(1),
      ],
    });

    expect(res.runAttempt).toBe(1);
  });

  it("still refuses two coverage-report artifacts uploaded inside the same job window", async () => {
    await expect(verify({ artifacts: [coverage(701), coverage(702)] })).rejects.toThrow(
      "multiple (2) non-expired 'coverage-report' artifacts found for run 12345",
    );
  });

  it("refuses when the only artifact predates the successful job (a stale attempt)", async () => {
    await expect(
      verify({
        run: { run_attempt: 2 },
        jobs: [
          producerJob(1),
          producerJob(2, { started_at: SECOND_STARTED, completed_at: SECOND_COMPLETED }),
        ],
        artifacts: [coverage(701)],
      }),
    ).rejects.toThrow("no non-expired 'coverage-report' artifact found for run 12345");
  });

  it("refuses an artifact created after the job completed", async () => {
    await expect(verify({ artifacts: [coverage(701, "2026-10-31T10:10:01Z")] })).rejects.toThrow(
      "no non-expired 'coverage-report' artifact found for run 12345",
    );
  });

  it("refuses an artifact that carries no usable creation time", async () => {
    for (const createdAt of [null, "not-a-date", ""]) {
      await expect(verify({ artifacts: [coverage(701, createdAt)] })).rejects.toThrow(
        "no non-expired 'coverage-report' artifact found for run 12345",
      );
    }
  });

  it("refuses when the run has no coverage job at all", async () => {
    await expect(
      verify({ jobs: [producerJob(1, { name: "unit-and-integration slice 1/4" })] }),
    ).rejects.toThrow("no 'unit-and-integration' job found for producer run 12345");
  });

  it.each([
    ["failed", { conclusion: "failure" }],
    ["cancelled", { conclusion: "cancelled" }],
    ["skipped", { conclusion: "skipped" }],
    ["unfinished", { status: "in_progress", conclusion: null }],
  ])("refuses when the newest coverage job record is %s", async (_label, jobOverride) => {
    await expect(verify({ jobs: [producerJob(1, jobOverride)] })).rejects.toThrow(
      "Refusing producer run: the latest 'unit-and-integration' job (attempt 1) must be completed with conclusion 'success'",
    );
  });

  it("refuses when a later attempt failed the coverage job even though an earlier attempt passed it", async () => {
    await expect(
      verify({
        run: { run_attempt: 2 },
        jobs: [producerJob(1), producerJob(2, { conclusion: "failure", started_at: SECOND_STARTED, completed_at: SECOND_COMPLETED })],
        artifacts: [coverage(701)],
      }),
    ).rejects.toThrow("the latest 'unit-and-integration' job (attempt 2) must be completed with conclusion 'success'");
  });

  it("refuses two coverage job records for the same attempt (ambiguous)", async () => {
    await expect(verify({ jobs: [producerJob(1), producerJob(1, { id: 9999 })] })).rejects.toThrow(
      "more than one 'unit-and-integration' job record for attempt 1",
    );
  });

  it("refuses a coverage job from an attempt newer than the run's attempt", async () => {
    await expect(verify({ run: { run_attempt: 1 }, jobs: [producerJob(2)] })).rejects.toThrow(
      "'unit-and-integration' job attempt 2 is newer than the run attempt 1",
    );
  });

  it.each([
    ["no start time", { started_at: null }],
    ["no completion time", { completed_at: null }],
    ["an unparseable start time", { started_at: "yesterday" }],
    ["a window that ends before it starts", { started_at: JOB_COMPLETED, completed_at: JOB_STARTED }],
  ])("refuses a coverage job with %s", async (_label, jobOverride) => {
    await expect(verify({ jobs: [producerJob(1, jobOverride)] })).rejects.toThrow(
      "the 'unit-and-integration' job has no valid started_at/completed_at window",
    );
  });

  it.each([
    ["a non-integer attempt", { run_attempt: 1.5 }],
    ["a zero attempt", { run_attempt: 0 }],
    ["a missing attempt", { run_attempt: undefined as unknown as number }],
  ])("refuses a coverage job record with %s", async (_label, jobOverride) => {
    await expect(verify({ jobs: [producerJob(1, jobOverride)] })).rejects.toThrow(
      "'unit-and-integration' job record has an invalid run_attempt",
    );
  });

  describe("jobs inventory API", () => {
    function jobsFetch(respond: (page: number) => unknown, requests: string[] = []): typeof fetch {
      const base = createMockFetch();
      return (async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (!/\/actions\/runs\/\d+\/jobs/.test(urlStr)) {
          return base(url, init);
        }
        requests.push(urlStr);
        const body = respond(Number(new URL(urlStr).searchParams.get("page")));
        if (typeof body === "number") {
          return { ok: false, status: body, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => body };
      }) as unknown as typeof fetch;
    }

    const run = (fetchImpl: typeof fetch) =>
      verifyProducerRun({ token: "dummy", repo: "aalzriqat/Auto", runId: 12345, expectedSha: VALID_SHA, fetchImpl });

    it("asks for the jobs of every attempt, not only the latest", async () => {
      const requests: string[] = [];
      await run(jobsFetch(() => ({ total_count: 1, jobs: [producerJob(1)] }), requests));

      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("/actions/runs/12345/jobs?filter=all&per_page=100&page=1");
    });

    it("refuses when the job listing cannot be fetched", async () => {
      await expect(run(jobsFetch(() => 502))).rejects.toThrow(
        "Could not fetch jobs for producer run 12345 (HTTP 502).",
      );
    });

    it("refuses with a TypeError when the job listing is malformed", async () => {
      const noCount = await run(jobsFetch(() => ({ total_count: "1", jobs: [] }))).catch((e: unknown) => e);
      expect(noCount).toBeInstanceOf(TypeError);
      expect((noCount as Error).message).toBe(
        "Refusing producer run: invalid jobs API response, total_count is not a number.",
      );

      const noJobs = await run(jobsFetch(() => ({ total_count: 1 }))).catch((e: unknown) => e);
      expect(noJobs).toBeInstanceOf(TypeError);
      expect((noJobs as Error).message).toBe("Refusing producer run: invalid jobs API response, jobs array missing.");
    });

    it("refuses a truncated job inventory", async () => {
      await expect(run(jobsFetch(() => ({ total_count: 150, jobs: [producerJob(1)] })))).rejects.toThrow(
        "incomplete job inventory (1 of 150 fetched)",
      );
    });

    it("reads every job page and finds the coverage job on the later page", async () => {
      const requests: string[] = [];
      const filler = Array.from({ length: 100 }, (_, i) => producerJob(1, { id: 100 + i, name: `other-${i}` }));
      const res = await run(
        jobsFetch((page) => ({ total_count: 101, jobs: page === 1 ? filler : [producerJob(1)] }), requests),
      );

      expect(res.runAttempt).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toContain("per_page=100&page=2");
    });
  });

  it("hands the producer attempt to coverage validation, so a reused coverage job still admits its manifest", async () => {
    const producer = await verify({
      run: { run_attempt: 2 },
      jobs: [producerJob(1), producerJob(2)],
      artifacts: [coverage(701)],
    });
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      // The manifest records GITHUB_RUN_ATTEMPT of the attempt that actually ran the job.
      writeValidArtifact(coverageDir, VALID_SHA, { run_attempt: 1 });
      const res = validateSonarMainCoverage({
        coverageDir,
        checkoutRoot: root,
        expectedSha: VALID_SHA,
        producerContext: { ...producer },
      });
      expect(res.runAttempt).toBe(1);

      // A manifest that names the re-run attempt did not come from the reused job.
      writeValidArtifact(coverageDir, VALID_SHA, { run_attempt: 2 });
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
          producerContext: { ...producer },
        }),
      ).toThrow("manifest run_attempt '2' does not match trusted producer run_attempt '1'");
    } finally {
      cleanup();
    }
  });
});

describe("validateSonarMainCoverage refusal branches", () => {
  type Fixture = ReturnType<typeof createFixtureDir>;

  function withArtifact(
    run: (fixture: Fixture) => void,
    manifestOverrides: Record<string, unknown> = {},
  ): void {
    const fixture = createFixtureDir();
    try {
      writeValidArtifact(fixture.coverageDir, VALID_SHA, manifestOverrides);
      run(fixture);
    } finally {
      fixture.cleanup();
    }
  }

  function validate(fixture: Fixture, extra: Record<string, unknown> = {}) {
    return validateSonarMainCoverage({
      coverageDir: fixture.coverageDir,
      checkoutRoot: fixture.root,
      expectedSha: VALID_SHA,
      producerContext: VALID_PRODUCER_CONTEXT,
      ...extra,
    });
  }

  it.each([
    ["an empty expected SHA", ""],
    ["an abbreviated expected SHA", "0d6eafb"],
    ["a non-hex expected SHA", "z".repeat(40)],
  ])("refuses %s before reading anything", (_name, expectedSha) => {
    withArtifact((fixture) => {
      expect(() => validate(fixture, { expectedSha })).toThrow(
        `Refusing coverage validation: invalid expected SHA '${expectedSha}'.`,
      );
    });
  });

  it.each([
    ["headSha", { headSha: OTHER_SHA }, `producerContext headSha '${OTHER_SHA}' does not match expected SHA '${VALID_SHA}'`],
    ["workflowName", { workflowName: "Build" }, "producerContext workflowName must be 'Tests', got 'Build'"],
    ["repository", { repository: "fork-user/Auto" }, "producerContext repository 'fork-user/Auto' does not match expected 'aalzriqat/Auto'"],
    ["event", { event: "pull_request" }, "producerContext event must be 'push', got 'pull_request'"],
    ["ref", { ref: "refs/heads/feature" }, "producerContext ref must be 'refs/heads/main', got 'refs/heads/feature'"],
  ])("refuses a producerContext with the wrong %s", (_field, override, message) => {
    withArtifact((fixture) => {
      expect(() => validate(fixture, { producerContext: { ...VALID_PRODUCER_CONTEXT, ...override } })).toThrow(
        message,
      );
    });
  });

  it("refuses a producerContext that is not an object with a TypeError", () => {
    withArtifact((fixture) => {
      let error: unknown;
      try {
        validate(fixture, { producerContext: "not-an-object" });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        "Refusing coverage validation: valid, complete trusted producerContext is mandatory.",
      );
    });
  });

  it("refuses a coverage directory that does not exist", () => {
    withArtifact((fixture) => {
      const missing = path.join(fixture.root, "no-such-dir");

      expect(() => validate(fixture, { coverageDir: missing })).toThrow(
        `Refusing coverage validation: coverage directory '${missing}' does not exist.`,
      );
    });
  });

  it("refuses a coverage path that is a file, not a directory", () => {
    withArtifact((fixture) => {
      const asFile = path.join(fixture.coverageDir, "lcov.info");

      expect(() => validate(fixture, { coverageDir: asFile })).toThrow(
        `Refusing coverage validation: coverage directory '${asFile}' does not exist.`,
      );
    });
  });

  it("refuses a malformed tested-merge-sha.txt", () => {
    withArtifact((fixture) => {
      fs.writeFileSync(path.join(fixture.coverageDir, "tested-merge-sha.txt"), "not-a-sha\n");

      expect(() => validate(fixture)).toThrow(
        "Refusing coverage validation: tested-merge-sha.txt contains malformed SHA 'not-a-sha'.",
      );
    });
  });

  it("refuses a missing coverage-provenance.json", () => {
    withArtifact((fixture) => {
      fs.rmSync(path.join(fixture.coverageDir, "coverage-provenance.json"));

      expect(() => validate(fixture)).toThrow(
        "Refusing coverage validation: coverage-provenance.json manifest is mandatory but absent.",
      );
    });
  });

  it("refuses a coverage-provenance.json that is not valid JSON", () => {
    withArtifact((fixture) => {
      fs.writeFileSync(path.join(fixture.coverageDir, "coverage-provenance.json"), "{ nope");

      expect(() => validate(fixture)).toThrow(
        /Refusing coverage validation: coverage-provenance\.json is malformed JSON: .+/,
      );
    });
  });

  it.each([
    ["run_id is not a positive integer", { run_id: 0 }, "manifest run_id must be a positive integer, got '0'"],
    ["run_attempt is not a positive integer", { run_attempt: -3 }, "manifest run_attempt must be a positive integer, got '-3'"],
    ["sha names another commit", { sha: OTHER_SHA }, `provenance manifest names SHA '${OTHER_SHA}', expected '${VALID_SHA}'`],
    ["sha is empty", { sha: "" }, `provenance manifest names SHA '', expected '${VALID_SHA}'`],
    ["workflow is not Tests", { workflow: "Build" }, "provenance manifest names workflow 'Build', expected 'Tests'"],
    ["lcovBytes disagrees with the file", { lcovBytes: 1 }, "does not match manifest 1."],
    ["lcovBytes is absent", { lcovBytes: undefined }, "does not match manifest undefined."],
    ["daRecords disagrees with the file", { daRecords: 7 }, "DA record count 1 does not match manifest 7"],
    ["sfRecords disagrees with the file", { sfRecords: 7 }, "SF count 1 does not match manifest 7"],
  ])("refuses a manifest whose %s", (_name, override, message) => {
    withArtifact(
      (fixture) => {
        expect(() => validate(fixture)).toThrow(message);
      },
      override,
    );
  });

  it("refuses lcov.info content of the same byte length through the SHA-256 check alone", () => {
    withArtifact((fixture) => {
      const lcovPath = path.join(fixture.coverageDir, "lcov.info");
      const original = fs.readFileSync(lcovPath, "utf8");
      // Same length, same SF and DA counts, different content: only the digest can see it.
      const substituted = original.replace("DA:1,1", "DA:1,9");
      expect(Buffer.byteLength(substituted)).toBe(Buffer.byteLength(original));
      expect(substituted).not.toBe(original);
      fs.writeFileSync(lcovPath, substituted);

      expect(() => validate(fixture)).toThrow(/lcov\.info SHA-256 '[0-9a-f]{64}' does not match manifest '[0-9a-f]{64}'/);
    });
  });

  it("refuses a missing lcov.info", () => {
    withArtifact((fixture) => {
      fs.rmSync(path.join(fixture.coverageDir, "lcov.info"));

      expect(() => validate(fixture)).toThrow("Refusing coverage validation: lcov.info is absent from coverage-report.");
    });
  });

  it("refuses an lcov.info larger than 50 MiB before reading it", () => {
    withArtifact((fixture) => {
      fs.truncateSync(path.join(fixture.coverageDir, "lcov.info"), MAX_LCOV_BYTES + 1);

      expect(() => validate(fixture)).toThrow(
        `Refusing coverage validation: lcov.info (${MAX_LCOV_BYTES + 1} bytes) exceeds 50 MiB limit.`,
      );
    });
  });

  it("refuses fewer DA records than the required minimum", () => {
    withArtifact((fixture) => {
      expect(() => validate(fixture, { minDaRecords: 5 })).toThrow(
        "Refusing coverage validation: lcov.info contains 1 DA records, expected at least 5.",
      );
    });
  });

  it("refuses fewer SF records than the required minimum", () => {
    withArtifact((fixture) => {
      expect(() => validate(fixture, { minRecords: 5 })).toThrow(
        "Refusing coverage validation: lcov.info contains 1 SF records, expected at least 5.",
      );
    });
  });

  it("accepts a nested directory tree that contains no symlink", () => {
    withArtifact((fixture) => {
      const nested = path.join(fixture.coverageDir, "reports", "unit");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "note.txt"), "plain file\n");

      expect(validate(fixture).ok).toBe(true);
    });
  });

  it("refuses a symlink hidden in a nested directory", () => {
    withArtifact((fixture) => {
      const nested = path.join(fixture.coverageDir, "reports", "unit");
      fs.mkdirSync(nested, { recursive: true });
      const link = path.join(nested, "linked-dir");
      const linkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "sonar-cov-link-target-"));
      try {
        // A directory junction needs no elevated privilege on Windows; POSIX ignores the type.
        fs.symlinkSync(linkTarget, link, "junction");

        expect(() => validate(fixture)).toThrow(`Trusted Sonar refuses symlink in coverage artifact: ${link}`);
        expect(() => checkSymlinks(fixture.coverageDir)).toThrow(link);
      } finally {
        fs.rmSync(link, { force: true, recursive: false });
        fs.rmSync(linkTarget, { recursive: true, force: true });
      }
    });
  });
});

describe("validateSonarMainCoverage command line", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function silence() {
    return {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  }

  const verifyArgs = (extra: string[] = []) => [
    "verify-producer",
    "--token",
    "dummy",
    "--repo",
    "aalzriqat/Auto",
    "--run-id",
    "12345",
    "--expected-sha",
    VALID_SHA,
    ...extra,
  ];

  it("verify-producer prints the verdict, writes the context file and appends GITHUB_OUTPUT", async () => {
    const { log, error } = silence();
    const { root, cleanup } = createFixtureDir();
    const outputFile = path.join(root, "github-output.txt");
    const contextFile = path.join(root, "nested", "producer-context.json");
    vi.stubEnv("GITHUB_OUTPUT", outputFile);
    try {
      const code = await main(verifyArgs(["--context-file", contextFile]), createMockFetch());

      expect(code).toBe(0);
      expect(error).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        `Producer run 12345 (attempt 1) verified successfully for SHA ${VALID_SHA}. Unique artifact ID: 554433.`,
      );
      expect(JSON.parse(fs.readFileSync(contextFile, "utf8"))).toMatchObject({
        verified: true,
        runId: 12345,
        runAttempt: 1,
        headSha: VALID_SHA,
        artifactId: 554433,
        artifactSizeBytes: 12345,
        ref: "refs/heads/main",
      });
      expect(fs.readFileSync(outputFile, "utf8")).toBe(
        `run_id=12345\nrun_attempt=1\nartifact_id=554433\ntarget_sha=${VALID_SHA}\n`,
      );
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it.each([
    ["a CR/LF-bearing SHA", `${VALID_SHA}\r\nrun_id=999\ntarget_sha=${OTHER_SHA}`],
    ["a short SHA", "0d6eafb"],
    ["a non-hex SHA", "z".repeat(40)],
    ["a 41-character SHA", `${VALID_SHA}0`],
  ])("verify-producer refuses a producer run whose head SHA is %s (SCRUM-764)", async (_label, badSha) => {
    const { log, error } = silence();
    const { root, cleanup } = createFixtureDir();
    const outputFile = path.join(root, "github-output.txt");
    vi.stubEnv("GITHUB_OUTPUT", outputFile);
    try {
      const args = verifyArgs();
      args[args.indexOf("--expected-sha") + 1] = badSha;
      const code = await main(args, createMockFetch({ run: { head_sha: badSha } }));

      expect(code).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(fs.existsSync(outputFile)).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      const refusal = String(error.mock.calls[0][0]);
      expect(refusal).toContain("head SHA must be exactly 40 lowercase hex characters");
      expect(refusal).not.toMatch(/[\r\n]/);
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it("verify-producer logs an API-derived refusal on one line when the workflow name carries a CR/LF (Sonar S5145)", async () => {
    const { log, error } = silence();

    const code = await main(
      verifyArgs(),
      createMockFetch({ workflow: { name: "Tests\r\nInjected: forged log line" } }),
    );

    expect(code).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "Workflow definition name 'Tests__Injected: forged log line' does not match expected 'Tests'.",
    );
    expect(String(error.mock.calls[0][0])).not.toMatch(/[\r\n]/);
  });

  it("validate-artifact logs a missing producerContext path on one line when it carries a CR/LF (Sonar S5145)", async () => {
    const { error } = silence();

    const code = await main(["validate-artifact", "cov", "root", VALID_SHA, "ctx\r\nInjected.json"]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "Refusing coverage validation: producerContext file 'ctx__Injected.json' does not exist.",
    );
  });

  it("safeLogValue neutralises CR and LF so a value cannot forge a log line or GITHUB_OUTPUT key (Sonar S5145)", () => {
    expect(safeLogValue(`${VALID_SHA}\r\nrun_id=999\ntarget_sha=${OTHER_SHA}`)).toBe(
      `${VALID_SHA}__run_id=999_target_sha=${OTHER_SHA}`,
    );
    expect(safeLogValue("a\nb\rc")).not.toMatch(/[\r\n]/);
    // Valid values pass through byte-identical.
    expect(safeLogValue(VALID_SHA)).toBe(VALID_SHA);
    expect(safeLogValue(12345)).toBe("12345");
  });
  it("verify-producer writes neither file when no context file or GITHUB_OUTPUT is given", async () => {
    silence();
    vi.stubEnv("GITHUB_OUTPUT", "");

    try {
      expect(await main(verifyArgs(), createMockFetch())).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("verify-producer returns 1 and prints the refusal when the producer run is wrong", async () => {
    const { error } = silence();

    const code = await main(verifyArgs(), createMockFetch({ run: { conclusion: "failure" } }));

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith("Refusing producer run: conclusion must be 'success', got 'failure'.");
  });

  it("verify-producer ignores a trailing flag with no value and refuses the missing input", async () => {
    const { error } = silence();

    const code = await main(["verify-producer", "--repo", "aalzriqat/Auto", "--token"], createMockFetch());

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith("verifyProducerRun requires token, repo, runId, and expectedSha.");
  });

  it("verify-producer reports a non-Error failure by its string form", async () => {
    const { error } = silence();
    const failingFetch = (async () => {
      throw "network down";
    }) as unknown as typeof fetch;

    expect(await main(verifyArgs(), failingFetch)).toBe(1);
    expect(error).toHaveBeenCalledWith("network down");
  });

  it("validates an artifact when the validate-artifact subcommand is given", async () => {
    const { log } = silence();
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const contextFile = path.join(root, "producer-context.json");
      fs.writeFileSync(contextFile, JSON.stringify(VALID_PRODUCER_CONTEXT));

      const code = await main(["validate-artifact", coverageDir, root, VALID_SHA, contextFile]);

      expect(code).toBe(0);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`Validated coverage artifact for SHA ${VALID_SHA}: 1 source records, 1 DA lines`),
      );
    } finally {
      cleanup();
    }
  });

  it("prints the usage line and returns 1 when a validation argument is missing", async () => {
    const { error } = silence();

    const code = await main(["coverage", "root", VALID_SHA]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "usage: node validateSonarMainCoverage.mjs <coverageDir> <checkoutRoot> <expectedSha> <producerContextFile>",
    );
  });

  it("prints both usage lines when called with no arguments", async () => {
    const { error } = silence();

    expect(await main([])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("verify-producer --token <token>"));
  });

  it("names the missing or malformed producer context file", async () => {
    const { error } = silence();
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const missing = path.join(root, "absent.json");
      expect(await main([coverageDir, root, VALID_SHA, missing])).toBe(1);
      expect(error).toHaveBeenLastCalledWith(
        `Refusing coverage validation: producerContext file '${missing}' does not exist.`,
      );

      const malformed = path.join(root, "malformed.json");
      fs.writeFileSync(malformed, "not-valid-json");
      expect(await main([coverageDir, root, VALID_SHA, malformed])).toBe(1);
      expect(error).toHaveBeenLastCalledWith(
        expect.stringContaining(`Refusing coverage validation: producerContext file '${malformed}' is invalid JSON: `),
      );
    } finally {
      cleanup();
    }
  });

  it("returns 1 and prints the refusal when the artifact does not match the producer context", async () => {
    const { error } = silence();
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const contextFile = path.join(root, "producer-context.json");
      fs.writeFileSync(contextFile, JSON.stringify({ ...VALID_PRODUCER_CONTEXT, runId: 999 }));

      expect(await main([coverageDir, root, VALID_SHA, contextFile])).toBe(1);
      expect(error).toHaveBeenCalledWith(
        "Refusing coverage validation: manifest run_id '12345' does not match trusted producer run_id '999'.",
      );
    } finally {
      cleanup();
    }
  });
});

describe("validateSonarMainCoverage entrypoint", () => {
  const script = path.resolve(__dirname, "validateSonarMainCoverage.mjs");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recognises only its own script path as the entrypoint", () => {
    const moduleUrl = pathToFileURL(script).href;

    expect(isEntrypoint(script, moduleUrl)).toBe(true);
    expect(isEntrypoint(path.resolve(__dirname, "other.mjs"), moduleUrl)).toBe(false);
    expect(isEntrypoint(undefined, moduleUrl)).toBe(false);
  });

  /**
   * Makes a directory link (a junction on Windows, a symlink elsewhere) that
   * points at the real scripts directory. Node resolves links in
   * `import.meta.url` but leaves `process.argv[1]` unresolved, so a script
   * launched through a link is a different string from its own module URL.
   */
  function withScriptsDirectoryLink(run: (linkedScript: string) => void): void {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), "sonar-entry-link-"));
    try {
      const link = path.join(holder, "linked-scripts");
      fs.symlinkSync(__dirname, link, "junction");
      run(path.join(link, "validateSonarMainCoverage.mjs"));
    } finally {
      fs.rmSync(holder, { recursive: true, force: true });
    }
  }

  it("B1: recognises its own script when it is launched through a directory link", () => {
    withScriptsDirectoryLink((linkedScript) => {
      // import.meta.url always carries the resolved real path.
      const moduleUrl = pathToFileURL(fs.realpathSync(script)).href;

      expect(path.resolve(linkedScript)).not.toBe(fs.realpathSync(script));
      expect(isEntrypoint(linkedScript, moduleUrl)).toBe(true);
    });
  });

  it("B1: a link to a different script is still not the entrypoint", () => {
    withScriptsDirectoryLink((linkedScript) => {
      const otherUrl = pathToFileURL(path.resolve(__dirname, "validateLcovSources.cjs")).href;

      expect(isEntrypoint(linkedScript, otherUrl)).toBe(false);
    });
  });

  it("B1: a script path that does not exist is not the entrypoint and does not throw", () => {
    const missing = path.join(os.tmpdir(), "sonar-entry-missing", "validateSonarMainCoverage.mjs");

    expect(isEntrypoint(missing, pathToFileURL(script).href)).toBe(false);
  });

  it("B1: the script launched through a directory link still runs and exits 1 with usage", () => {
    withScriptsDirectoryLink((linkedScript) => {
      const noArguments = spawnSync(process.execPath, [linkedScript], { encoding: "utf8" });
      expect(noArguments.status).toBe(1);
      expect(noArguments.stderr).toContain("usage:");

      const verify = spawnSync(process.execPath, [linkedScript, "verify-producer"], { encoding: "utf8" });
      expect(verify.status).toBe(1);
      expect(verify.stderr).toContain("verifyProducerRun requires token, repo, runId, and expectedSha.");
    });
  });

  it("runAsScript passes the exit code through", async () => {
    expect(await runAsScript(async () => 0)).toBe(0);
    expect(await runAsScript(async () => 1)).toBe(1);
  });

  it("runAsScript reports an unexpected rejection and returns 1", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");

    expect(
      await runAsScript(async () => {
        throw boom;
      }),
    ).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(safeLogValue(boom.stack));
    expect(String(error.mock.calls[0][0])).not.toMatch(/[\r\n]/);
  });

  it("the script run directly exits 1 with usage when given no arguments", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
    expect(result.stderr).toContain("verify-producer --token <token>");
  });

  it("the script run directly exits 0 for a valid artifact and 1 for a refused one", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const contextFile = path.join(root, "producer-context.json");
      fs.writeFileSync(contextFile, JSON.stringify(VALID_PRODUCER_CONTEXT));

      const ok = spawnSync(process.execPath, [script, coverageDir, root, VALID_SHA, contextFile], { encoding: "utf8" });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain(`Validated coverage artifact for SHA ${VALID_SHA}`);

      fs.writeFileSync(contextFile, JSON.stringify({ ...VALID_PRODUCER_CONTEXT, event: "pull_request" }));
      const refused = spawnSync(process.execPath, [script, coverageDir, root, VALID_SHA, contextFile], {
        encoding: "utf8",
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("producerContext event must be 'push', got 'pull_request'");
    } finally {
      cleanup();
    }
  });

  describe("the script run directly prints its refusal for every unusable producer context", () => {
    const MANDATORY_REFUSAL =
      "Refusing coverage validation: valid, complete trusted producerContext is mandatory.";

    /** Runs the real CLI against a valid artifact and the given context file path. */
    function runCliWithContext(prepare: (root: string) => string) {
      const { root, coverageDir, cleanup } = createFixtureDir();
      try {
        writeValidArtifact(coverageDir, VALID_SHA);
        const contextFile = prepare(root);
        return {
          contextFile,
          result: spawnSync(process.execPath, [script, coverageDir, root, VALID_SHA, contextFile], {
            encoding: "utf8",
          }),
        };
      } finally {
        cleanup();
      }
    }

    it.each([
      ["literal JSON null", "null"],
      ["literal JSON false", "false"],
      ["literal JSON zero", "0"],
      ["an empty JSON string", '""'],
    ])("%s exits 1 with the mandatory-context refusal on stderr", (_label, content) => {
      const { result } = runCliWithContext((root) => {
        const contextFile = path.join(root, "producer-context.json");
        fs.writeFileSync(contextFile, content);
        return contextFile;
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(MANDATORY_REFUSAL);
    });

    it("a missing context file exits 1 and names the file", () => {
      const { contextFile, result } = runCliWithContext((root) => path.join(root, "absent.json"));

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(
        safeLogValue(`Refusing coverage validation: producerContext file '${contextFile}' does not exist.`),
      );
    });

    it("a context path that exists but cannot be read as a file exits 1 and names the file", () => {
      const { contextFile, result } = runCliWithContext((root) => {
        const directory = path.join(root, "context-is-a-directory.json");
        fs.mkdirSync(directory);
        return directory;
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `Refusing coverage validation: producerContext file '${contextFile}' is invalid JSON: `,
      );
    });

    it("a context file that is not JSON exits 1 and names the file", () => {
      const { contextFile, result } = runCliWithContext((root) => {
        const malformed = path.join(root, "producer-context.json");
        fs.writeFileSync(malformed, "not-valid-json");
        return malformed;
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Refusing coverage validation: producerContext file '${contextFile}' is invalid JSON: `,
      );
    });
  });
});
