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

function writeValidArtifact(coverageDir: string, sha: string = VALID_SHA): void {
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

  fs.writeFileSync(
    path.join(coverageDir, "coverage-provenance.json"),
    JSON.stringify({
      sha,
      ref: "refs/heads/main",
      workflow: "Tests",
      event_name: "push",
      repository: "aalzriqat/Auto",
      lcovBytes: bytes,
      lcovSha256: sha256,
      sfRecords: 1,
      daRecords: 1,
      timestamp: new Date().toISOString(),
    }),
  );
  fs.writeFileSync(path.join(coverageDir, "lcov.info"), lcovContent);
}

describe("validateSonarMainCoverage", () => {
  it("passes cleanly on valid artifact matching expected SHA and provenance", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const res = validateSonarMainCoverage({
        coverageDir,
        checkoutRoot: root,
        expectedSha: VALID_SHA,
        minRecords: 1,
        minDaRecords: 1,
      });

      expect(res.ok).toBe(true);
      expect(res.sfCount).toBe(1);
      expect(res.daCount).toBe(1);
      expect(res.sha).toBe(VALID_SHA);
      expect(res.bytes).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it("refuses if expectedSha is invalid", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: "not-a-sha",
        }),
      ).toThrow("Refusing coverage validation: invalid expected SHA 'not-a-sha'.");
    } finally {
      cleanup();
    }
  });

  it("refuses if coverage-provenance.json is absent", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.unlinkSync(path.join(coverageDir, "coverage-provenance.json"));

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("coverage-provenance.json manifest is mandatory but absent");
    } finally {
      cleanup();
    }
  });

  it("refuses if provenance manifest SHA-256 does not match lcov.info", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      // Tamper with lcov.info without updating manifest hash
      fs.appendFileSync(path.join(coverageDir, "lcov.info"), "# extra line\n");

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
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
        }),
      ).toThrow("tested-merge-sha.txt is absent");
    } finally {
      cleanup();
    }
  });

  it("refuses if tested-merge-sha.txt has malformed content", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.writeFileSync(path.join(coverageDir, "tested-merge-sha.txt"), "short-sha\n");

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("tested-merge-sha.txt contains malformed SHA 'short-sha'.");
    } finally {
      cleanup();
    }
  });

  it("refuses if tested-merge-sha.txt does not match expected SHA", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, OTHER_SHA);

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow(`coverage was produced for SHA '${OTHER_SHA}', expected '${VALID_SHA}'.`);
    } finally {
      cleanup();
    }
  });

  it("refuses if provenance manifest names wrong workflow", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const provPath = path.join(coverageDir, "coverage-provenance.json");
      const prov = JSON.parse(fs.readFileSync(provPath, "utf8"));
      prov.workflow = "UntrustedWorkflow";
      fs.writeFileSync(provPath, JSON.stringify(prov));

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("provenance manifest names workflow 'UntrustedWorkflow', expected 'Tests'.");
    } finally {
      cleanup();
    }
  });

  it("refuses if provenance manifest names wrong SHA", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const provPath = path.join(coverageDir, "coverage-provenance.json");
      const prov = JSON.parse(fs.readFileSync(provPath, "utf8"));
      prov.sha = OTHER_SHA;
      fs.writeFileSync(provPath, JSON.stringify(prov));

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow(`provenance manifest names SHA '${OTHER_SHA}', expected '${VALID_SHA}'.`);
    } finally {
      cleanup();
    }
  });

  it("refuses if provenance manifest names wrong event", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const provPath = path.join(coverageDir, "coverage-provenance.json");
      const prov = JSON.parse(fs.readFileSync(provPath, "utf8"));
      prov.event_name = "issue_comment";
      fs.writeFileSync(provPath, JSON.stringify(prov));

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("provenance manifest event 'issue_comment' is not push or pull_request.");
    } finally {
      cleanup();
    }
  });

  it("refuses if lcov.info is missing", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.unlinkSync(path.join(coverageDir, "lcov.info"));

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("lcov.info is absent");
    } finally {
      cleanup();
    }
  });

  it("refuses if lcov.info is 0 bytes", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.writeFileSync(path.join(coverageDir, "lcov.info"), "");

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("lcov.info is empty (0 bytes)");
    } finally {
      cleanup();
    }
  });

  it("refuses if lcov.info names an out-of-scope path", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      const outOfScopeContent = "TN:\nSF:.github/workflows/test.yml\nDA:1,1\nend_of_record\n";
      const bytes = Buffer.byteLength(outOfScopeContent);
      const sha256 = crypto.createHash("sha256").update(outOfScopeContent).digest("hex");

      fs.writeFileSync(path.join(coverageDir, "tested-merge-sha.txt"), `${VALID_SHA}\n`);
      fs.writeFileSync(
        path.join(coverageDir, "coverage-provenance.json"),
        JSON.stringify({
          sha: VALID_SHA,
          ref: "refs/heads/main",
          workflow: "Tests",
          event_name: "push",
          repository: "aalzriqat/Auto",
          lcovBytes: bytes,
          lcovSha256: sha256,
          sfRecords: 1,
          daRecords: 1,
        }),
      );
      fs.writeFileSync(path.join(coverageDir, "lcov.info"), outOfScopeContent);

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("Trusted Sonar refuses out-of-scope LCOV source path");
    } finally {
      cleanup();
    }
  });

  it("CLI main returns 0 on success and 1 on failure", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const exit0 = main([coverageDir, root, VALID_SHA]);
      expect(exit0).toBe(0);

      const exit1 = main([coverageDir, root, OTHER_SHA]);
      expect(exit1).toBe(1);

      const usageExit = main([]);
      expect(usageExit).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("verifyProducerRun", () => {
  it("verifies valid producer run successfully", async () => {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 12345,
        name: "Tests",
        head_branch: "main",
        event: "push",
        status: "completed",
        conclusion: "success",
        head_sha: VALID_SHA,
        run_attempt: 1,
        head_repository: { full_name: "aalzriqat/Auto" },
      }),
    })) as unknown as typeof fetch;

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
    expect(res.headSha).toBe(VALID_SHA);
  });

  it("refuses if producer run conclusion was not success", async () => {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 12345,
        name: "Tests",
        head_branch: "main",
        event: "push",
        status: "completed",
        conclusion: "failure",
        head_sha: VALID_SHA,
        head_repository: { full_name: "aalzriqat/Auto" },
      }),
    })) as unknown as typeof fetch;

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

  it("refuses if producer run branch was not main", async () => {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 12345,
        name: "Tests",
        head_branch: "feature-branch",
        event: "push",
        status: "completed",
        conclusion: "success",
        head_sha: VALID_SHA,
        head_repository: { full_name: "aalzriqat/Auto" },
      }),
    })) as unknown as typeof fetch;

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

  it("refuses if producer run head SHA does not match expected SHA", async () => {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 12345,
        name: "Tests",
        head_branch: "main",
        event: "push",
        status: "completed",
        conclusion: "success",
        head_sha: OTHER_SHA,
        head_repository: { full_name: "aalzriqat/Auto" },
      }),
    })) as unknown as typeof fetch;

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
});
