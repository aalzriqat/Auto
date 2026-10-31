/**
 * SCRUM-764: Fail-closed validator for Sonar Main coverage artifact reuse.
 *
 * Verifies that candidate coverage downloaded from the `Tests` workflow:
 * 1. Contains no symlinks in the coverage directory.
 * 2. Contains `tested-merge-sha.txt` naming the EXACT expected commit SHA.
 * 3. Contains mandatory, complete `coverage-provenance.json` matching the
 *    producer run, attempt, repository, event, workflow, SHA-256 hash, and census.
 * 4. Contains non-empty `lcov.info` within bounded size limits (<= 50 MiB).
 * 5. Passes all source allowlist and regular-file checks via `validateLcovSources.cjs`.
 * 6. Contains a full SF record census (>= minRecords) and execution DA lines.
 * 7. Live API admission verifies producer run ID, attempt, workflow path/ID, status,
 *    event, branch, and unique non-expired artifact binding.
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
 * @param {string} [options.expectedWorkflowPath]
 * @param {string} [options.expectedWorkflowName]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function verifyProducerRun({
  token,
  repo,
  runId,
  expectedSha,
  expectedEvent = "push",
  expectedWorkflowPath = ".github/workflows/test.yml",
  expectedWorkflowName = "Tests",
  fetchImpl = fetch,
}) {
  if (!token || !repo || !runId || !expectedSha) {
    throw new Error("verifyProducerRun requires token, repo, runId, and expectedSha.");
  }
  const repositoryPath = repo.split("/").map(encodeURIComponent).join("/");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "autoflow-sonar-main",
  };

  // 1. Fetch and verify fixed workflow definition identity
  const workflowUrl = `https://api.github.com/repos/${repositoryPath}/actions/workflows/test.yml`;
  const workflowRes = await fetchImpl(workflowUrl, { headers });
  if (!workflowRes.ok) {
    throw new Error(`Could not fetch workflow definition from GitHub API (HTTP ${workflowRes.status}).`);
  }
  const workflowData = await workflowRes.json();
  const expectedWorkflowId = workflowData.id;
  if (!expectedWorkflowId) {
    throw new Error("Workflow definition returned by GitHub API missing workflow ID.");
  }
  if (workflowData.path !== expectedWorkflowPath) {
    throw new Error(
      `Workflow definition path '${workflowData.path}' does not match expected '${expectedWorkflowPath}'.`
    );
  }
  if (workflowData.name !== expectedWorkflowName) {
    throw new Error(
      `Workflow definition name '${workflowData.name}' does not match expected '${expectedWorkflowName}'.`
    );
  }

  // 2. Fetch and verify run identity
  const runUrl = `https://api.github.com/repos/${repositoryPath}/actions/runs/${runId}`;
  const runRes = await fetchImpl(runUrl, { headers });
  if (!runRes.ok) {
    throw new Error(`Could not fetch producer run ${runId} from GitHub API (HTTP ${runRes.status}).`);
  }
  const run = await runRes.json();

  if (run.id !== Number(runId)) {
    throw new Error(`Refusing producer run: run id '${run.id}' does not match requested '${runId}'.`);
  }
  if (run.run_attempt == null || Number(run.run_attempt) < 1) {
    throw new Error(`Refusing producer run: run_attempt must be present, got '${run.run_attempt}'.`);
  }
  if (run.name !== expectedWorkflowName) {
    throw new Error(`Refusing producer run: workflow name must be '${expectedWorkflowName}', got '${run.name}'.`);
  }
  if (run.path !== expectedWorkflowPath) {
    throw new Error(`Refusing producer run: workflow path must be '${expectedWorkflowPath}', got '${run.path}'.`);
  }
  if (run.workflow_id !== expectedWorkflowId) {
    throw new Error(
      `Refusing producer run: workflow_id '${run.workflow_id}' does not match fixed API identity '${expectedWorkflowId}'.`
    );
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

  // 3. Fetch and verify unique non-expired coverage-report artifact
  const artifactsUrl = `https://api.github.com/repos/${repositoryPath}/actions/runs/${runId}/artifacts`;
  const artifactsRes = await fetchImpl(artifactsUrl, { headers });
  if (!artifactsRes.ok) {
    throw new Error(`Could not fetch artifacts for producer run ${runId} (HTTP ${artifactsRes.status}).`);
  }
  const artifactsData = await artifactsRes.json();
  const matchingArtifacts = (artifactsData.artifacts || []).filter(
    (a) => a.name === "coverage-report" && !a.expired
  );
  if (matchingArtifacts.length === 0) {
    throw new Error(`Refusing producer run: no non-expired 'coverage-report' artifact found for run ${runId}.`);
  }
  if (matchingArtifacts.length > 1) {
    throw new Error(
      `Refusing producer run: multiple (${matchingArtifacts.length}) non-expired 'coverage-report' artifacts found for run ${runId}; expected unique artifact.`
    );
  }
  const verifiedArtifact = matchingArtifacts[0];

  return {
    verified: true,
    runId: run.id,
    runAttempt: run.run_attempt,
    headSha: normalizedRunSha,
    workflowId: run.workflow_id,
    workflowPath: run.path,
    workflowName: run.name,
    repository: run.head_repository.full_name,
    event: run.event,
    ref: "refs/heads/main",
    artifactId: verifiedArtifact.id,
    artifactSizeBytes: verifiedArtifact.size_in_bytes,
  };
}

/**
 * Validates coverage artifact for reuse in Sonar Main scan.
 * @param {object} options
 * @param {string} options.coverageDir
 * @param {string} options.checkoutRoot
 * @param {string} options.expectedSha
 * @param {object} [options.producerContext]
 * @param {number} [options.minRecords]
 * @param {number} [options.minDaRecords]
 * @param {string} [options.expectedRepo]
 */
export function validateSonarMainCoverage({
  coverageDir,
  checkoutRoot,
  expectedSha,
  producerContext,
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
  if (producerContext?.headSha && recordedSha !== producerContext.headSha.toLowerCase()) {
    throw new Error(
      `Refusing coverage validation: tested-merge-sha.txt '${recordedSha}' does not match producer context head SHA '${producerContext.headSha}'.`
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
    throw new Error(
      `Refusing coverage validation: coverage-provenance.json is malformed JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const manifestSha = String(prov.sha ?? "").trim().toLowerCase();
  if (manifestSha !== normalizedExpectedSha) {
    throw new Error(
      `Refusing coverage validation: provenance manifest names SHA '${prov.sha}', expected '${normalizedExpectedSha}'.`
    );
  }
  if (prov.workflow !== "Tests") {
    throw new Error(
      `Refusing coverage validation: provenance manifest names workflow '${prov.workflow}', expected 'Tests'.`
    );
  }
  if (prov.event_name !== "push") {
    throw new Error(
      `Refusing coverage validation: provenance manifest event '${prov.event_name}' is not 'push'.`
    );
  }
  if (prov.ref !== "refs/heads/main") {
    throw new Error(
      `Refusing coverage validation: provenance manifest ref '${prov.ref}' is not 'refs/heads/main'.`
    );
  }
  if (!prov.repository || prov.repository !== expectedRepo) {
    throw new Error(
      `Refusing coverage validation: provenance repository '${prov.repository}' does not match expected '${expectedRepo}'.`
    );
  }

  // Strict cross-comparison against trusted producerContext if provided
  if (producerContext) {
    if (String(prov.run_id) !== String(producerContext.runId)) {
      throw new Error(
        `Refusing coverage validation: manifest run_id '${prov.run_id}' does not match trusted producer run_id '${producerContext.runId}'.`
      );
    }
    if (String(prov.run_attempt) !== String(producerContext.runAttempt)) {
      throw new Error(
        `Refusing coverage validation: manifest run_attempt '${prov.run_attempt}' does not match trusted producer run_attempt '${producerContext.runAttempt}'.`
      );
    }
    if (prov.repository !== producerContext.repository) {
      throw new Error(
        `Refusing coverage validation: manifest repository '${prov.repository}' does not match trusted producer repository '${producerContext.repository}'.`
      );
    }
    if (prov.event_name !== producerContext.event) {
      throw new Error(
        `Refusing coverage validation: manifest event '${prov.event_name}' does not match trusted producer event '${producerContext.event}'.`
      );
    }
    if (prov.ref !== producerContext.ref) {
      throw new Error(
        `Refusing coverage validation: manifest ref '${prov.ref}' does not match trusted producer ref '${producerContext.ref}'.`
      );
    }
    if (prov.workflow !== producerContext.workflowName) {
      throw new Error(
        `Refusing coverage validation: manifest workflow '${prov.workflow}' does not match trusted producer workflow '${producerContext.workflowName}'.`
      );
    }
    if (manifestSha !== producerContext.headSha.toLowerCase()) {
      throw new Error(
        `Refusing coverage validation: manifest sha '${manifestSha}' does not match trusted producer headSha '${producerContext.headSha}'.`
      );
    }
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
  if (!prov.lcovSha256 || prov.lcovSha256 !== computedSha256) {
    throw new Error(
      `Refusing coverage validation: lcov.info SHA-256 '${computedSha256}' does not match manifest '${prov.lcovSha256}'.`
    );
  }
  if (prov.lcovBytes === undefined || prov.lcovBytes !== stat.size) {
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
  if (prov.daRecords !== undefined && prov.daRecords !== actualDaRecords) {
    throw new Error(
      `Refusing coverage validation: lcov.info DA record count ${actualDaRecords} does not match manifest ${prov.daRecords}.`
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
    runAttempt: prov.run_attempt,
    artifactId: producerContext?.artifactId,
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    console.error(
      "usage:\n  node validateSonarMainCoverage.mjs verify-producer --token <token> --repo <repo> --run-id <runId> --expected-sha <sha> [--context-file <path>]\n  node validateSonarMainCoverage.mjs <coverageDir> <checkoutRoot> <expectedSha> [producerContextFile]"
    );
    return 1;
  }

  if (argv[0] === "verify-producer") {
    const args = argv.slice(1);
    let token = "";
    let repo = "";
    let runId = "";
    let expectedSha = "";
    let contextFile = "";

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--token" && i + 1 < args.length) token = args[++i];
      else if (args[i] === "--repo" && i + 1 < args.length) repo = args[++i];
      else if (args[i] === "--run-id" && i + 1 < args.length) runId = args[++i];
      else if (args[i] === "--expected-sha" && i + 1 < args.length) expectedSha = args[++i];
      else if (args[i] === "--context-file" && i + 1 < args.length) contextFile = args[++i];
    }

    try {
      const verified = await verifyProducerRun({ token, repo, runId, expectedSha });
      console.log(
        `Producer run ${verified.runId} (attempt ${verified.runAttempt}) verified successfully for SHA ${verified.headSha}. Unique artifact ID: ${verified.artifactId}.`
      );

      if (contextFile) {
        fs.mkdirSync(path.dirname(path.resolve(contextFile)), { recursive: true });
        fs.writeFileSync(contextFile, JSON.stringify(verified, null, 2), "utf8");
      }

      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `run_id=${verified.runId}\nrun_attempt=${verified.runAttempt}\nartifact_id=${verified.artifactId}\ntarget_sha=${verified.headSha}\n`
        );
      }
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  // Artifact validation mode:
  const coverageDir = argv[0] === "validate-artifact" ? argv[1] : argv[0];
  const checkoutRoot = argv[0] === "validate-artifact" ? argv[2] : argv[1];
  const expectedSha = argv[0] === "validate-artifact" ? argv[3] : argv[2];
  const contextFile = argv[0] === "validate-artifact" ? argv[4] : argv[3];

  if (!coverageDir || !checkoutRoot || !expectedSha) {
    console.error(
      "usage: node validateSonarMainCoverage.mjs <coverageDir> <checkoutRoot> <expectedSha> [producerContextFile]"
    );
    return 1;
  }

  let producerContext;
  if (contextFile && fs.existsSync(contextFile)) {
    try {
      producerContext = JSON.parse(fs.readFileSync(contextFile, "utf8"));
    } catch (err) {
      console.error(
        `Refusing coverage validation: producerContext file '${contextFile}' is invalid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return 1;
    }
  }

  try {
    const res = validateSonarMainCoverage({ coverageDir, checkoutRoot, expectedSha, producerContext });
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
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
