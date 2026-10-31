import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { validateSonarMainCoverage, main } from "./validateSonarMainCoverage.mjs";

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
  fs.writeFileSync(
    path.join(coverageDir, "coverage-provenance.json"),
    JSON.stringify({
      sha,
      ref: "refs/heads/main",
      workflow: "Tests",
      event_name: "push",
    }),
  );
  fs.writeFileSync(
    path.join(coverageDir, "lcov.info"),
    `TN:
SF:convex/schema.ts
DA:1,1
LF:1
LH:1
end_of_record
`,
  );
}

describe("validateSonarMainCoverage", () => {
  it("passes cleanly on valid artifact matching expected SHA", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      const res = validateSonarMainCoverage({
        coverageDir,
        checkoutRoot: root,
        expectedSha: VALID_SHA,
        minRecords: 1,
      });

      expect(res.ok).toBe(true);
      expect(res.sfCount).toBe(1);
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

  it("refuses if coverage directory does not exist", () => {
    const { root, cleanup } = createFixtureDir();
    try {
      expect(() =>
        validateSonarMainCoverage({
          coverageDir: path.join(root, "nonexistent"),
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("Refusing coverage validation: coverage directory");
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
      fs.writeFileSync(
        path.join(coverageDir, "coverage-provenance.json"),
        JSON.stringify({ sha: VALID_SHA, workflow: "UntrustedWorkflow" }),
      );

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
      fs.writeFileSync(
        path.join(coverageDir, "coverage-provenance.json"),
        JSON.stringify({ sha: OTHER_SHA, workflow: "Tests" }),
      );

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

  it("refuses if lcov.info contains no DA execution lines", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.writeFileSync(
        path.join(coverageDir, "lcov.info"),
        "TN:\nSF:convex/schema.ts\nend_of_record\n",
      );

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("lcov.info contains no execution line (DA) records.");
    } finally {
      cleanup();
    }
  });

  it("refuses if lcov.info has 0 SF records", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.writeFileSync(
        path.join(coverageDir, "lcov.info"),
        "TN:\nDA:1,1\nend_of_record\n",
      );

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("lcov.info contains 0 SF records, expected at least 1.");
    } finally {
      cleanup();
    }
  });

  it("refuses if lcov.info names an out-of-scope path", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      fs.writeFileSync(
        path.join(coverageDir, "lcov.info"),
        "TN:\nSF:.github/workflows/test.yml\nDA:1,1\nend_of_record\n",
      );

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

  it("refuses if coverage directory contains symlinks", () => {
    const { root, coverageDir, cleanup } = createFixtureDir();
    try {
      writeValidArtifact(coverageDir, VALID_SHA);
      // Create a symlink inside coverageDir
      const target = path.join(coverageDir, "tested-merge-sha.txt");
      const link = path.join(coverageDir, "symlink-sha.txt");
      try {
        fs.symlinkSync(target, link);
      } catch {
        // Skip if symlinks cannot be created on OS without elevation
        return;
      }

      expect(() =>
        validateSonarMainCoverage({
          coverageDir,
          checkoutRoot: root,
          expectedSha: VALID_SHA,
        }),
      ).toThrow("Trusted Sonar refuses symlink in coverage artifact");
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
