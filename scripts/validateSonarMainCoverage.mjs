/**
 * SCRUM-764: Fail-closed validator for Sonar Main coverage artifact reuse.
 *
 * Verifies that candidate coverage downloaded from the `Tests` workflow:
 * 1. Contains no symlinks in the coverage directory.
 * 2. Contains `tested-merge-sha.txt` naming the EXACT expected commit SHA.
 * 3. Contains mandatory, complete `coverage-provenance.json` matching the
 *    producer run, attempt, repository, event, workflow, SHA-256 hash, and census.
 * 4. Cross-verifies all manifest fields against mandatory, verified trusted producerContext.
 * 5. Contains non-empty `lcov.info` within bounded size limits (<= 50 MiB).
 * 6. Passes all source allowlist and regular-file checks via `validateLcovSources.cjs`.
 * 7. Contains a full SF record census (>= minRecords) and execution DA lines.
 * 8. Live API admission verifies producer run ID, attempt, workflow path/ID, status,
 *    event, branch, complete pagination, and unique non-expired artifact binding.
 *
 * Each admission rule is a small named helper so that every refusal stays
 * individually readable and testable (SonarSource S3776: extract function).
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

const ARTIFACTS_PER_PAGE = 100;
const MAX_ARTIFACT_PAGES = 10;
const SHA40 = /^[0-9a-f]{40}$/;

const VERIFY_PRODUCER_FLAGS = new Map([
  ["--token", "token"],
  ["--repo", "repo"],
  ["--run-id", "runId"],
  ["--expected-sha", "expectedSha"],
  ["--context-file", "contextFile"],
]);

const USAGE_VERIFY_AND_VALIDATE =
  "usage:\n  node validateSonarMainCoverage.mjs verify-producer --token <token> --repo <repo> --run-id <runId> --expected-sha <sha> [--context-file <path>]\n  node validateSonarMainCoverage.mjs <coverageDir> <checkoutRoot> <expectedSha> <producerContextFile>";
const USAGE_VALIDATE =
  "usage: node validateSonarMainCoverage.mjs <coverageDir> <checkoutRoot> <expectedSha> <producerContextFile>";

/** Throws `new ErrorType(message)` when the refusal condition holds. */
function failIf(condition, message, ErrorType = Error) {
  if (condition) {
    throw new ErrorType(message);
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isMissing(value) {
  return value === undefined || value === null;
}

function normalizeSha(value) {
  return String(value ?? "").trim().toLowerCase();
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recursively asserts that no symlinks exist in dirPath.
 * @param {string} dirPath
 */
export function checkSymlinks(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    failIf(entry.isSymbolicLink(), `Trusted Sonar refuses symlink in coverage artifact: ${fullPath}`);
    if (entry.isDirectory()) {
      checkSymlinks(fullPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Live producer-run admission (GitHub Actions API)
// ---------------------------------------------------------------------------

async function fetchGitHubJson(fetchImpl, url, headers, describeFailure) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(describeFailure(response.status));
  }
  return response.json();
}

/** Returns the fixed workflow id after checking the definition path and name. */
function assertWorkflowDefinition(workflowData, expectedPath, expectedName) {
  const workflowId = workflowData.id;
  failIf(!workflowId, "Workflow definition returned by GitHub API missing workflow ID.");
  failIf(
    workflowData.path !== expectedPath,
    `Workflow definition path '${workflowData.path}' does not match expected '${expectedPath}'.`
  );
  failIf(
    workflowData.name !== expectedName,
    `Workflow definition name '${workflowData.name}' does not match expected '${expectedName}'.`
  );
  return workflowId;
}

function assertRunNumbers(run, runId) {
  const numericRunId = Number(run.id);
  failIf(
    !Number.isInteger(numericRunId) || numericRunId !== Number(runId) || numericRunId <= 0,
    `Refusing producer run: invalid run id '${run.id}', expected '${runId}'.`
  );
  const numericRunAttempt = Number(run.run_attempt);
  failIf(
    !Number.isInteger(numericRunAttempt) || numericRunAttempt < 1,
    `Refusing producer run: run_attempt must be a positive integer, got '${run.run_attempt}'.`
  );
  return { numericRunId, numericRunAttempt };
}

function assertRunWorkflow(run, { expectedWorkflowId, expectedWorkflowName, expectedWorkflowPath }) {
  failIf(
    run.name !== expectedWorkflowName,
    `Refusing producer run: workflow name must be '${expectedWorkflowName}', got '${run.name}'.`
  );
  failIf(
    run.path !== expectedWorkflowPath,
    `Refusing producer run: workflow path must be '${expectedWorkflowPath}', got '${run.path}'.`
  );
  failIf(
    run.workflow_id !== expectedWorkflowId,
    `Refusing producer run: workflow_id '${run.workflow_id}' does not match fixed API identity '${expectedWorkflowId}'.`
  );
}

function assertRunOrigin(run, { repo, expectedEvent }) {
  failIf(
    run.head_repository?.full_name !== repo,
    `Refusing producer run: repository '${run.head_repository?.full_name}' does not match expected '${repo}'.`
  );
  failIf(run.head_branch !== "main", `Refusing producer run: branch must be 'main', got '${run.head_branch}'.`);
  failIf(
    Boolean(expectedEvent) && run.event !== expectedEvent,
    `Refusing producer run: event must be '${expectedEvent}', got '${run.event}'.`
  );
}

/** Returns the normalized head SHA after checking status, conclusion and SHA. */
function assertRunOutcome(run, expectedSha) {
  failIf(run.status !== "completed", `Refusing producer run: status must be 'completed', got '${run.status}'.`);
  failIf(run.conclusion !== "success", `Refusing producer run: conclusion must be 'success', got '${run.conclusion}'.`);
  const normalizedRunSha = normalizeSha(run.head_sha);
  failIf(
    !SHA40.test(normalizedRunSha),
    `Refusing producer run: head SHA must be exactly 40 lowercase hex characters, got '${safeLogValue(normalizedRunSha)}'.`
  );
  const normalizedExpectedSha = expectedSha.trim().toLowerCase();
  failIf(
    normalizedRunSha !== normalizedExpectedSha,
    `Refusing producer run: head SHA '${normalizedRunSha}' does not match expected '${normalizedExpectedSha}'.`
  );
  return normalizedRunSha;
}

async function fetchArtifactsPage({ fetchImpl, repositoryPath, runId, headers, page }) {
  const url = `https://api.github.com/repos/${repositoryPath}/actions/runs/${runId}/artifacts?per_page=${ARTIFACTS_PER_PAGE}&page=${page}`;
  const data = await fetchGitHubJson(
    fetchImpl,
    url,
    headers,
    (status) => `Could not fetch artifacts for producer run ${runId} (HTTP ${status}).`
  );
  failIf(
    typeof data.total_count !== "number",
    "Refusing producer run: invalid artifacts API response, total_count is not a number.",
    TypeError
  );
  failIf(
    !Array.isArray(data.artifacts),
    "Refusing producer run: invalid artifacts API response, artifacts array missing.",
    TypeError
  );
  return { totalCount: data.total_count, artifacts: data.artifacts };
}

/** Fetches every artifact page (bounded) and refuses a truncated inventory. */
async function fetchArtifactInventory(request) {
  const allArtifacts = [];
  let totalCount = null;

  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page++) {
    const current = await fetchArtifactsPage({ ...request, page });
    totalCount ??= current.totalCount;
    allArtifacts.push(...current.artifacts);

    if (allArtifacts.length >= totalCount || current.artifacts.length < ARTIFACTS_PER_PAGE) {
      failIf(
        allArtifacts.length < totalCount,
        `Refusing producer run: incomplete artifact inventory (${allArtifacts.length} of ${totalCount} fetched).`
      );
      return allArtifacts;
    }
  }
  throw new Error(
    `Refusing producer run: artifact pagination exceeded ${MAX_ARTIFACT_PAGES} pages (${allArtifacts.length}/${totalCount} fetched).`
  );
}

/** Returns the id and size of the one unique, non-expired coverage-report artifact. */
function selectCoverageArtifact(allArtifacts, runId) {
  const matchingArtifacts = allArtifacts.filter((a) => a.name === "coverage-report" && !a.expired);
  failIf(
    matchingArtifacts.length === 0,
    `Refusing producer run: no non-expired 'coverage-report' artifact found for run ${runId}.`
  );
  failIf(
    matchingArtifacts.length > 1,
    `Refusing producer run: multiple (${matchingArtifacts.length}) non-expired 'coverage-report' artifacts found for run ${runId}; expected unique artifact.`
  );
  const verifiedArtifact = matchingArtifacts[0];

  const artifactId = Number(verifiedArtifact.id);
  const artifactSizeBytes = Number(verifiedArtifact.size_in_bytes);
  failIf(!isPositiveInteger(artifactId), `Refusing producer run: invalid artifact ID '${verifiedArtifact.id}'.`);
  failIf(
    !isPositiveInteger(artifactSizeBytes),
    `Refusing producer run: invalid or empty artifact size '${verifiedArtifact.size_in_bytes}'.`
  );
  return { artifactId, artifactSizeBytes };
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
  failIf(!token || !repo || !runId || !expectedSha, "verifyProducerRun requires token, repo, runId, and expectedSha.");
  const repositoryPath = repo.split("/").map(encodeURIComponent).join("/");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "autoflow-sonar-main",
  };

  // 1. Fetch and verify fixed workflow definition identity
  const workflowData = await fetchGitHubJson(
    fetchImpl,
    `https://api.github.com/repos/${repositoryPath}/actions/workflows/test.yml`,
    headers,
    (status) => `Could not fetch workflow definition from GitHub API (HTTP ${status}).`
  );
  const expectedWorkflowId = assertWorkflowDefinition(workflowData, expectedWorkflowPath, expectedWorkflowName);

  // 2. Fetch and verify run identity
  const run = await fetchGitHubJson(
    fetchImpl,
    `https://api.github.com/repos/${repositoryPath}/actions/runs/${runId}`,
    headers,
    (status) => `Could not fetch producer run ${runId} from GitHub API (HTTP ${status}).`
  );
  const { numericRunId, numericRunAttempt } = assertRunNumbers(run, runId);
  assertRunWorkflow(run, { expectedWorkflowId, expectedWorkflowName, expectedWorkflowPath });
  assertRunOrigin(run, { repo, expectedEvent });
  const normalizedRunSha = assertRunOutcome(run, expectedSha);

  // 3. Fetch and verify unique non-expired coverage-report artifact with complete pagination
  const allArtifacts = await fetchArtifactInventory({ fetchImpl, repositoryPath, runId, headers });
  const { artifactId, artifactSizeBytes } = selectCoverageArtifact(allArtifacts, runId);

  return {
    verified: true,
    runId: numericRunId,
    runAttempt: numericRunAttempt,
    headSha: normalizedRunSha,
    workflowId: run.workflow_id,
    workflowPath: run.path,
    workflowName: run.name,
    repository: run.head_repository.full_name,
    event: run.event,
    ref: "refs/heads/main",
    artifactId,
    artifactSizeBytes,
  };
}

// ---------------------------------------------------------------------------
// Coverage artifact admission (files on disk)
// ---------------------------------------------------------------------------

/** Checks the trusted producer context and returns its numeric identities. */
function assertProducerContext(producerContext, normalizedExpectedSha, expectedRepo) {
  failIf(
    !producerContext || typeof producerContext !== "object",
    "Refusing coverage validation: valid, complete trusted producerContext is mandatory.",
    TypeError
  );
  const runId = Number(producerContext.runId);
  failIf(
    !isPositiveInteger(runId),
    `Refusing coverage validation: producerContext runId must be a positive integer, got '${producerContext.runId}'.`
  );
  const runAttempt = Number(producerContext.runAttempt);
  failIf(
    !isPositiveInteger(runAttempt),
    `Refusing coverage validation: producerContext runAttempt must be a positive integer, got '${producerContext.runAttempt}'.`
  );
  failIf(
    normalizeSha(producerContext.headSha) !== normalizedExpectedSha,
    `Refusing coverage validation: producerContext headSha '${producerContext.headSha}' does not match expected SHA '${normalizedExpectedSha}'.`
  );
  failIf(
    producerContext.workflowName !== "Tests",
    `Refusing coverage validation: producerContext workflowName must be 'Tests', got '${producerContext.workflowName}'.`
  );
  failIf(
    producerContext.repository !== expectedRepo,
    `Refusing coverage validation: producerContext repository '${producerContext.repository}' does not match expected '${expectedRepo}'.`
  );
  failIf(
    producerContext.event !== "push",
    `Refusing coverage validation: producerContext event must be 'push', got '${producerContext.event}'.`
  );
  failIf(
    producerContext.ref !== "refs/heads/main",
    `Refusing coverage validation: producerContext ref must be 'refs/heads/main', got '${producerContext.ref}'.`
  );
  const artifactId = Number(producerContext.artifactId);
  failIf(
    !isPositiveInteger(artifactId),
    `Refusing coverage validation: producerContext artifactId must be a positive integer, got '${producerContext.artifactId}'.`
  );
  return { runId, runAttempt, artifactId };
}

function assertTestedMergeSha(coverageDir, normalizedExpectedSha) {
  const shaFile = path.join(coverageDir, "tested-merge-sha.txt");
  failIf(!fs.existsSync(shaFile), "Refusing coverage validation: tested-merge-sha.txt is absent from coverage-report.");
  const recordedSha = fs.readFileSync(shaFile, "utf8").trim().toLowerCase();
  failIf(
    !SHA40.test(recordedSha),
    `Refusing coverage validation: tested-merge-sha.txt contains malformed SHA '${recordedSha}'.`
  );
  failIf(
    recordedSha !== normalizedExpectedSha,
    `Refusing coverage validation: coverage was produced for SHA '${recordedSha}', expected '${normalizedExpectedSha}'.`
  );
}

function readProvenance(coverageDir) {
  const provenanceFile = path.join(coverageDir, "coverage-provenance.json");
  failIf(
    !fs.existsSync(provenanceFile),
    "Refusing coverage validation: coverage-provenance.json manifest is mandatory but absent."
  );
  try {
    return JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
  } catch (err) {
    throw new Error(`Refusing coverage validation: coverage-provenance.json is malformed JSON: ${errorText(err)}`);
  }
}

/** Reads a mandatory positive-integer manifest field and returns it as a number. */
function readManifestCounter(prov, field) {
  failIf(isMissing(prov[field]), `Refusing coverage validation: provenance manifest missing mandatory '${field}'.`);
  const value = Number(prov[field]);
  failIf(
    !isPositiveInteger(value),
    `Refusing coverage validation: manifest ${field} must be a positive integer, got '${prov[field]}'.`
  );
  return value;
}

/** Cross-checks the manifest run identity against the trusted producer context. */
function assertManifestRunIdentity(prov, producer) {
  const manifestRunId = readManifestCounter(prov, "run_id");
  failIf(
    manifestRunId !== producer.runId,
    `Refusing coverage validation: manifest run_id '${prov.run_id}' does not match trusted producer run_id '${producer.runId}'.`
  );
  const manifestRunAttempt = readManifestCounter(prov, "run_attempt");
  failIf(
    manifestRunAttempt !== producer.runAttempt,
    `Refusing coverage validation: manifest run_attempt '${prov.run_attempt}' does not match trusted producer run_attempt '${producer.runAttempt}'.`
  );
  return { manifestRunId, manifestRunAttempt };
}

/** Checks the manifest names the expected SHA, workflow, event, ref and repository. */
function assertManifestOrigin(prov, normalizedExpectedSha, expectedRepo) {
  const manifestSha = normalizeSha(prov.sha);
  failIf(
    !manifestSha || manifestSha !== normalizedExpectedSha,
    `Refusing coverage validation: provenance manifest names SHA '${prov.sha}', expected '${normalizedExpectedSha}'.`
  );
  failIf(
    prov.workflow !== "Tests",
    `Refusing coverage validation: provenance manifest names workflow '${prov.workflow}', expected 'Tests'.`
  );
  failIf(
    prov.event_name !== "push",
    `Refusing coverage validation: provenance manifest event '${prov.event_name}' is not 'push'.`
  );
  failIf(
    prov.ref !== "refs/heads/main",
    `Refusing coverage validation: provenance manifest ref '${prov.ref}' is not 'refs/heads/main'.`
  );
  failIf(
    !prov.repository || prov.repository !== expectedRepo,
    `Refusing coverage validation: provenance repository '${prov.repository}' does not match expected '${expectedRepo}'.`
  );
}

/** Reads lcov.info after the existence and size-bound checks. */
function readBoundedLcov(coverageDir) {
  const lcovPath = path.join(coverageDir, "lcov.info");
  failIf(!fs.existsSync(lcovPath), "Refusing coverage validation: lcov.info is absent from coverage-report.");
  const { size } = fs.statSync(lcovPath);
  failIf(size === 0, "Refusing coverage validation: lcov.info is empty (0 bytes).");
  failIf(size > MAX_LCOV_BYTES, `Refusing coverage validation: lcov.info (${size} bytes) exceeds 50 MiB limit.`);
  return { lcovContent: fs.readFileSync(lcovPath, "utf8"), size };
}

/** Returns the lcov SHA-256 after matching hash and byte length to the manifest. */
function assertLcovMatchesManifest(prov, lcovContent, size) {
  const computedSha256 = crypto.createHash("sha256").update(lcovContent).digest("hex");
  failIf(
    !prov.lcovSha256 || typeof prov.lcovSha256 !== "string" || prov.lcovSha256 !== computedSha256,
    `Refusing coverage validation: lcov.info SHA-256 '${computedSha256}' does not match manifest '${prov.lcovSha256}'.`
  );
  failIf(
    prov.lcovBytes === undefined || Number(prov.lcovBytes) !== size,
    `Refusing coverage validation: lcov.info byte length ${size} does not match manifest ${prov.lcovBytes}.`
  );
  return computedSha256;
}

/** Returns the DA record count after checking the minimum and the manifest census. */
function assertDaRecords(prov, lcovContent, minDaRecords) {
  const actualDaRecords = (lcovContent.match(/^DA:\d+,\d+/gm) || []).length;
  failIf(
    actualDaRecords < minDaRecords,
    `Refusing coverage validation: lcov.info contains ${actualDaRecords} DA records, expected at least ${minDaRecords}.`
  );
  failIf(isMissing(prov.daRecords), "Refusing coverage validation: provenance manifest missing mandatory 'daRecords'.");
  failIf(
    Number(prov.daRecords) !== actualDaRecords,
    `Refusing coverage validation: lcov.info DA record count ${actualDaRecords} does not match manifest ${prov.daRecords}.`
  );
  return actualDaRecords;
}

/** Returns the SF record count after the source allowlist, minimum and manifest census. */
function assertSfRecords(prov, lcovContent, checkoutRoot, minRecords) {
  const recordCount = validateLcovSources(lcovContent, { candidateRoot: checkoutRoot });
  failIf(
    recordCount < minRecords,
    `Refusing coverage validation: lcov.info contains ${recordCount} SF records, expected at least ${minRecords}.`
  );
  failIf(isMissing(prov.sfRecords), "Refusing coverage validation: provenance manifest missing mandatory 'sfRecords'.");
  failIf(
    Number(prov.sfRecords) !== recordCount,
    `Refusing coverage validation: lcov.info SF count ${recordCount} does not match manifest ${prov.sfRecords}.`
  );
  return recordCount;
}

/**
 * Validates coverage artifact for reuse in Sonar Main scan.
 * @param {object} options
 * @param {string} options.coverageDir
 * @param {string} options.checkoutRoot
 * @param {string} options.expectedSha
 * @param {object} options.producerContext
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
  failIf(
    !expectedSha || !/^[0-9a-f]{40}$/i.test(expectedSha),
    `Refusing coverage validation: invalid expected SHA '${expectedSha}'.`
  );
  const normalizedExpectedSha = expectedSha.trim().toLowerCase();

  // Producer context is strictly mandatory
  const producer = assertProducerContext(producerContext, normalizedExpectedSha, expectedRepo);

  failIf(
    !fs.existsSync(coverageDir) || !fs.statSync(coverageDir).isDirectory(),
    `Refusing coverage validation: coverage directory '${coverageDir}' does not exist.`
  );

  // Guard against symlinks inside coverage artifact
  checkSymlinks(coverageDir);

  // 1. Validate tested-merge-sha.txt
  assertTestedMergeSha(coverageDir, normalizedExpectedSha);

  // 2. Validate mandatory coverage-provenance.json (every required manifest field)
  const prov = readProvenance(coverageDir);
  const { manifestRunId, manifestRunAttempt } = assertManifestRunIdentity(prov, producer);
  assertManifestOrigin(prov, normalizedExpectedSha, expectedRepo);

  // 3. Validate lcov.info existence, bounds, and content hash
  const { lcovContent, size } = readBoundedLcov(coverageDir);
  const computedSha256 = assertLcovMatchesManifest(prov, lcovContent, size);

  // 4. Verify DA line execution records exist
  const actualDaRecords = assertDaRecords(prov, lcovContent, minDaRecords);

  // 5. Validate source paths against allowlist and checkout root
  const recordCount = assertSfRecords(prov, lcovContent, checkoutRoot, minRecords);

  return {
    ok: true,
    sfCount: recordCount,
    daCount: actualDaRecords,
    bytes: size,
    sha256: computedSha256,
    sha: normalizedExpectedSha,
    runId: manifestRunId,
    runAttempt: manifestRunAttempt,
    artifactId: producer.artifactId,
  };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/** Parses `--flag value` pairs; a flag with no following value is ignored. */
function parseVerifyProducerArgs(args) {
  const options = { token: "", repo: "", runId: "", expectedSha: "", contextFile: "" };
  for (let i = 0; i < args.length; i++) {
    const key = VERIFY_PRODUCER_FLAGS.get(args[i]);
    if (key && i + 1 < args.length) {
      options[key] = args[++i];
    }
  }
  return options;
}

function writeProducerContext(contextFile, verified) {
  fs.mkdirSync(path.dirname(path.resolve(contextFile)), { recursive: true });
  fs.writeFileSync(contextFile, JSON.stringify(verified, null, 2), "utf8");
}

/**
 * Replaces every CR and LF with "_" so a value taken from the GitHub API cannot
 * start a new log line or a new GITHUB_OUTPUT key (OWASP log injection; Sonar
 * S5145 compliant form). Text without a line break comes back unchanged.
 */
export function safeLogValue(value) {
  return String(value).replace(/[\r\n]/g, "_");
}

function appendGithubOutput(outputFile, verified) {
  const runId = safeLogValue(verified.runId);
  const runAttempt = safeLogValue(verified.runAttempt);
  const artifactId = safeLogValue(verified.artifactId);
  const headSha = safeLogValue(verified.headSha);
  fs.appendFileSync(
    outputFile,
    `run_id=${runId}\nrun_attempt=${runAttempt}\nartifact_id=${artifactId}\ntarget_sha=${headSha}\n`
  );
}

async function runVerifyProducer(args, fetchImpl) {
  const { token, repo, runId, expectedSha, contextFile } = parseVerifyProducerArgs(args);
  try {
    const verified = await verifyProducerRun({ token, repo, runId, expectedSha, fetchImpl });
    console.log(
      `Producer run ${safeLogValue(verified.runId)} (attempt ${safeLogValue(verified.runAttempt)}) verified successfully for SHA ${safeLogValue(verified.headSha)}. Unique artifact ID: ${safeLogValue(verified.artifactId)}.`
    );
    if (contextFile) {
      writeProducerContext(contextFile, verified);
    }
    if (process.env.GITHUB_OUTPUT) {
      appendGithubOutput(process.env.GITHUB_OUTPUT, verified);
    }
    return 0;
  } catch (err) {
    console.error(errorText(err));
    return 1;
  }
}

/** Returns the parsed producer context, or null after reporting why it cannot be read. */
function readProducerContextFile(contextFile) {
  if (!fs.existsSync(contextFile)) {
    console.error(`Refusing coverage validation: producerContext file '${contextFile}' does not exist.`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(contextFile, "utf8"));
  } catch (err) {
    console.error(
      `Refusing coverage validation: producerContext file '${contextFile}' is invalid JSON: ${errorText(err)}`
    );
    return null;
  }
}

function runValidateArtifact(args) {
  const [coverageDir, checkoutRoot, expectedSha, contextFile] = args;
  if (!coverageDir || !checkoutRoot || !expectedSha || !contextFile) {
    console.error(USAGE_VALIDATE);
    return 1;
  }

  const producerContext = readProducerContextFile(contextFile);
  if (producerContext === null) {
    return 1;
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

export async function main(argv = process.argv.slice(2), fetchImpl = fetch) {
  if (argv.length === 0) {
    console.error(USAGE_VERIFY_AND_VALIDATE);
    return 1;
  }
  if (argv[0] === "verify-producer") {
    return runVerifyProducer(argv.slice(1), fetchImpl);
  }
  // Artifact validation mode, with or without the explicit subcommand:
  return runValidateArtifact(argv[0] === "validate-artifact" ? argv.slice(1) : argv);
}

/** True when this module is the script node was started with (not an import). */
export function isEntrypoint(scriptPath, moduleUrl) {
  return Boolean(scriptPath) && moduleUrl === pathToFileURL(path.resolve(scriptPath)).href;
}

/** Runs the CLI and turns an unexpected rejection into exit code 1. */
export async function runAsScript(run = main) {
  try {
    return await run();
  } catch (err) {
    console.error(err);
    return 1;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  process.exitCode = await runAsScript();
}
