#!/usr/bin/env node
/**
 * SCRUM-764: Fail-closed validator for Sonar Main coverage artifact reuse.
 *
 * Verifies that candidate coverage downloaded from the `Tests` workflow:
 * 1. Contains no symlinks in the coverage directory.
 * 2. Contains `tested-merge-sha.txt` naming the EXACT expected commit SHA.
 * 3. Contains non-empty `lcov.info` within bounded size limits (<= 50 MiB).
 * 4. Passes all source allowlist and regular-file checks via `validateLcovSources.cjs`.
 * 5. Contains a non-zero SF record census (>= 1, ensuring no empty or truncated report).
 * 6. Contains DA execution line records.
 * 7. Matches `coverage-provenance.json` metadata if present.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateLcovSources } = require("./validateLcovSources.cjs");

export const MAX_LCOV_BYTES = 52428800; // 50 MiB limit matching trusted PR Sonar

/**
 * Recursively asserts that no symlinks exist in dirPath.
 * @param {string} dirPath
 */
export function checkSymlinks(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Trusted Sonar refuses symlink in coverage artifact: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      checkSymlinks(fullPath);
    }
  }
}

/**
 * Validates coverage artifact for reuse in Sonar Main scan.
 * @param {object} options
 * @param {string} options.coverageDir
 * @param {string} options.checkoutRoot
 * @param {string} options.expectedSha
 * @param {number} [options.minRecords]
 */
export function validateSonarMainCoverage({
  coverageDir,
  checkoutRoot,
  expectedSha,
  minRecords = 1,
}) {
  if (!expectedSha || !/^[0-9a-f]{40}$/i.test(expectedSha)) {
    throw new Error(`Refusing coverage validation: invalid expected SHA '${expectedSha}'.`);
  }

  const normalizedExpectedSha = expectedSha.trim().toLowerCase();

  if (!fs.existsSync(coverageDir) || !fs.statSync(coverageDir).isDirectory()) {
    throw new Error(`Refusing coverage validation: coverage directory '${coverageDir}' does not exist.`);
  }

  // Guard against symlinks inside coverage artifact
  checkSymlinks(coverageDir);

  // 1. Validate tested-merge-sha.txt
  const shaFile = path.join(coverageDir, "tested-merge-sha.txt");
  if (!fs.existsSync(shaFile)) {
    throw new Error("Refusing coverage validation: tested-merge-sha.txt is absent from coverage-report.");
  }
  const recordedSha = fs.readFileSync(shaFile, "utf8").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(recordedSha)) {
    throw new Error(`Refusing coverage validation: tested-merge-sha.txt contains malformed SHA '${recordedSha}'.`);
  }
  if (recordedSha !== normalizedExpectedSha) {
    throw new Error(
      `Refusing coverage validation: coverage was produced for SHA '${recordedSha}', expected '${normalizedExpectedSha}'.`
    );
  }

  // 2. Validate coverage-provenance.json if present
  const provenanceFile = path.join(coverageDir, "coverage-provenance.json");
  if (fs.existsSync(provenanceFile)) {
    try {
      const prov = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
      if (prov.sha && prov.sha.trim().toLowerCase() !== normalizedExpectedSha) {
        throw new Error(
          `Refusing coverage validation: provenance manifest names SHA '${prov.sha}', expected '${normalizedExpectedSha}'.`
        );
      }
      if (prov.workflow && prov.workflow !== "Tests") {
        throw new Error(
          `Refusing coverage validation: provenance manifest names workflow '${prov.workflow}', expected 'Tests'.`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Refusing")) throw err;
      throw new Error(`Refusing coverage validation: coverage-provenance.json is malformed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Validate lcov.info
  const lcovPath = path.join(coverageDir, "lcov.info");
  if (!fs.existsSync(lcovPath)) {
    throw new Error("Refusing coverage validation: lcov.info is absent from coverage-report.");
  }
  const stat = fs.statSync(lcovPath);
  if (stat.size === 0) {
    throw new Error("Refusing coverage validation: lcov.info is empty (0 bytes).");
  }
  if (stat.size > MAX_LCOV_BYTES) {
    throw new Error(`Refusing coverage validation: lcov.info (${stat.size} bytes) exceeds 50 MiB limit.`);
  }

  const lcovContent = fs.readFileSync(lcovPath, "utf8");

  // Verify DA execution records exist
  if (!/^DA:\d+,\d+/m.test(lcovContent)) {
    throw new Error("Refusing coverage validation: lcov.info contains no execution line (DA) records.");
  }

  // 4. Validate source paths against allowlist and checkout root
  const recordCount = validateLcovSources(lcovContent, { candidateRoot: checkoutRoot });

  if (recordCount < minRecords) {
    throw new Error(
      `Refusing coverage validation: lcov.info contains ${recordCount} SF records, expected at least ${minRecords}.`
    );
  }

  return {
    ok: true,
    sfCount: recordCount,
    bytes: stat.size,
    sha: normalizedExpectedSha,
  };
}

export function main(argv = process.argv.slice(2)) {
  const [coverageDir, checkoutRoot, expectedSha] = argv;
  if (!coverageDir || !checkoutRoot || !expectedSha) {
    console.error("usage: node validateSonarMainCoverage.mjs <coverageDir> <checkoutRoot> <expectedSha>");
    return 1;
  }
  try {
    const res = validateSonarMainCoverage({ coverageDir, checkoutRoot, expectedSha });
    console.log(
      `Validated coverage artifact for SHA ${res.sha}: ${res.sfCount} source records, ${res.bytes} bytes.`
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
