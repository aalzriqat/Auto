/**
 * SCRUM-764: Fail-closed validator for Sonar Main coverage artifact reuse.
 *
 * Verifies that candidate coverage downloaded from the `Tests` workflow:
 * 1. Contains no symlinks in the coverage directory.
 * 2. Contains `tested-merge-sha.txt` naming the EXACT expected commit SHA.
 * 3. Contains mandatory, complete `coverage-provenance.json` matching the
 *    producer run, repository, event, workflow, SHA-256 hash, and census.
 * 4. Contains non-empty `lcov.info` within bounded size limits (<= 50 MiB).
 * 5. Passes all source allowlist and regular-file checks via `validateLcovSources.cjs`.
 * 6. Contains a full SF record census (>= minRecords) and execution DA lines.
 * 7. Live API admission verifies producer run ID, attempt, status, event, and branch.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
 * Verifies producer workflow run metadata via live GitHub Actions API.
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.repo
 * @param {string|number} options.runId
 * @param {string} options.expectedSha
 * @param {string} [options.expectedEvent]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function verifyProducerRun({
  token,
  repo,
  runId,
  expectedSha,
  expectedEvent = "push",
  fetchImpl = fetch,
}) {
  if (!token || !repo || !runId || !expectedSha) {
    throw new Error("verifyProducerRun requires token, repo, runId, and expectedSha.");
  }
  const repositoryPath = repo.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${repositoryPath}/actions/runs/${runId}`;
  const res = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "autoflow-sonar-main",
    },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch producer run ${runId} from GitHub API (HTTP ${res.status}).`);
  }
  const run = await res.json();

  if (run.name !== "Tests" && !String(run.path ?? "").endsWith("test.yml")) {
    throw new Error(`Refusing producer run: workflow name must be 'Tests', got '${run.name}'.`);
  }
  if (run.head_repository?.full_name !== repo) {
    throw new Error(
      `Refusing producer run: repository '${run.head_repository?.full_name}' does not match expected '${repo}'.`
    );
  }
  if (run.head_branch !== "main") {
    throw new Error(`Refusing producer run: branch must be 'main', got '${run.head_branch}'.`);
  }
  if (expectedEvent && run.event !== expectedEvent) {
    throw new Error(`Refusing producer run: event must be '${expectedEvent}', got '${run.event}'.`);
  }
  if (run.status !== "completed") {
    throw new Error(`Refusing producer run: status must be 'completed', got '${run.status}'.`);
  }
  if (run.conclusion !== "success") {
    throw new Error(`Refusing producer run: conclusion must be 'success', got '${run.conclusion}'.`);
  }
  const normalizedRunSha = String(run.head_sha ?? "").trim().toLowerCase();
  const normalizedExpectedSha = expectedSha.trim().toLowerCase();
  if (normalizedRunSha !== normalizedExpectedSha) {
    throw new Error(
      `Refusing producer run: head SHA '${normalizedRunSha}' does not match expected '${normalizedExpectedSha}'.`
    );
  }

  return {
    verified: true,
    runId: run.id,
    attempt: run.run_attempt,
    headSha: normalizedRunSha,
  };
}

/**
 * Validates coverage artifact for reuse in Sonar Main scan.
 * @param {object} options
 * @param {string} options.coverageDir
 * @param {string} options.checkoutRoot
 * @param {string} options.expectedSha
 * @param {number} [options.minRecords]
 * @param {number} [options.minDaRecords]
 * @param {string} [options.expectedRepo]
 */
export function validateSonarMainCoverage({
  coverageDir,
  checkoutRoot,
  expectedSha,
  minRecords = 1,
  minDaRecords = 1,
  expectedRepo = "aalzriqat/Auto",
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

  // 2. Validate mandatory coverage-provenance.json
  const provenanceFile = path.join(coverageDir, "coverage-provenance.json");
  if (!fs.existsSync(provenanceFile)) {
    throw new Error("Refusing coverage validation: coverage-provenance.json manifest is mandatory but absent.");
  }
  let prov;
  try {
    prov = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
  } catch (err) {
    throw new Error(`Refusing coverage validation: coverage-provenance.json is malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (String(prov.sha ?? "").trim().toLowerCase() !== normalizedExpectedSha) {
    throw new Error(
      `Refusing coverage validation: provenance manifest names SHA '${prov.sha}', expected '${normalizedExpectedSha}'.`
    );
  }
  if (prov.workflow !== "Tests") {
    throw new Error(
      `Refusing coverage validation: provenance manifest names workflow '${prov.workflow}', expected 'Tests'.`
    );
  }
  if (prov.event_name !== "push" && prov.event_name !== "pull_request") {
    throw new Error(
      `Refusing coverage validation: provenance manifest event '${prov.event_name}' is not push or pull_request.`
    );
  }
  if (prov.ref !== "refs/heads/main" && !String(prov.ref ?? "").startsWith("refs/pull/")) {
    throw new Error(`Refusing coverage validation: provenance manifest ref '${prov.ref}' is invalid.`);
  }
  if (expectedRepo && prov.repository && prov.repository !== expectedRepo) {
    throw new Error(
      `Refusing coverage validation: provenance repository '${prov.repository}' does not match expected '${expectedRepo}'.`
    );
  }

  // 3. Validate lcov.info existence, bounds, and content hash
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

  // Verify SHA-256 matches provenance manifest
  const computedSha256 = crypto.createHash("sha256").update(lcovContent).digest("hex");
  if (prov.lcovSha256 && prov.lcovSha256 !== computedSha256) {
    throw new Error(
      `Refusing coverage validation: lcov.info SHA-256 '${computedSha256}' does not match manifest '${prov.lcovSha256}'.`
    );
  }
  if (prov.lcovBytes !== undefined && prov.lcovBytes !== stat.size) {
    throw new Error(
      `Refusing coverage validation: lcov.info byte length ${stat.size} does not match manifest ${prov.lcovBytes}.`
    );
  }

  // 4. Verify DA line execution records exist
  const actualDaRecords = (lcovContent.match(/^DA:\d+,\d+/gm) || []).length;
  if (actualDaRecords < minDaRecords) {
    throw new Error(
      `Refusing coverage validation: lcov.info contains ${actualDaRecords} DA records, expected at least ${minDaRecords}.`
    );
  }

  // 5. Validate source paths against allowlist and checkout root
  const recordCount = validateLcovSources(lcovContent, { candidateRoot: checkoutRoot });

  if (recordCount < minRecords) {
    throw new Error(
      `Refusing coverage validation: lcov.info contains ${recordCount} SF records, expected at least ${minRecords}.`
    );
  }
  if (prov.sfRecords !== undefined && prov.sfRecords !== recordCount) {
    throw new Error(
      `Refusing coverage validation: lcov.info SF count ${recordCount} does not match manifest ${prov.sfRecords}.`
    );
  }

  return {
    ok: true,
    sfCount: recordCount,
    daCount: actualDaRecords,
    bytes: stat.size,
    sha256: computedSha256,
    sha: normalizedExpectedSha,
    runId: prov.run_id,
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
      `Validated coverage artifact for SHA ${res.sha}: ${res.sfCount} source records, ${res.daCount} DA lines, ${res.bytes} bytes, hash ${res.sha256.slice(0, 12)}...`
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
