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
 * 8. Live API admission verifies producer run ID, workflow path/ID, status, event,
 *    branch, the successful `unit-and-integration` job (and the attempt it really
 *    ran in, which a re-run may have reused), complete pagination, and the unique
 *    non-expired artifact created inside that job's window.
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
// The Tests job that merges the slices and uploads `coverage-report`.
const COVERAGE_JOB_NAME = "unit-and-integration";

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

async function fetchInventoryPage({ fetchImpl, headers, url, itemsKey, describeFailure }) {
  const data = await fetchGitHubJson(fetchImpl, url, headers, describeFailure);
  failIf(
    typeof data.total_count !== "number",
    `Refusing producer run: invalid ${itemsKey} API response, total_count is not a number.`,
    TypeError
  );
  failIf(
    !Array.isArray(data[itemsKey]),
    `Refusing producer run: invalid ${itemsKey} API response, ${itemsKey} array missing.`,
    TypeError
  );
  return { totalCount: data.total_count, items: data[itemsKey] };
}

/**
 * Fetches every page (bounded) of a GitHub list endpoint and refuses a
 * truncated inventory. `pageUrl(page)` builds the request for one page.
 */
async function fetchInventory({ fetchImpl, headers, pageUrl, itemsKey, noun, describeFailure }) {
  const allItems = [];
  let totalCount = null;

  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page++) {
    const current = await fetchInventoryPage({ fetchImpl, headers, url: pageUrl(page), itemsKey, describeFailure });
    totalCount ??= current.totalCount;
    allItems.push(...current.items);

    if (allItems.length >= totalCount || current.items.length < ARTIFACTS_PER_PAGE) {
      failIf(
        allItems.length < totalCount,
        `Refusing producer run: incomplete ${noun} inventory (${allItems.length} of ${totalCount} fetched).`
      );
      return allItems;
    }
  }
  throw new Error(
    `Refusing producer run: ${noun} pagination exceeded ${MAX_ARTIFACT_PAGES} pages (${allItems.length}/${totalCount} fetched).`
  );
}

function fetchArtifactInventory({ fetchImpl, repositoryPath, runId, headers }) {
  return fetchInventory({
    fetchImpl,
    headers,
    itemsKey: "artifacts",
    noun: "artifact",
    pageUrl: (page) =>
      `https://api.github.com/repos/${repositoryPath}/actions/runs/${runId}/artifacts?per_page=${ARTIFACTS_PER_PAGE}&page=${page}`,
    describeFailure: (status) => `Could not fetch artifacts for producer run ${runId} (HTTP ${status}).`,
  });
}

/**
 * Lists the jobs of EVERY attempt of the run (`filter=all`). The default
 * (`latest`) would hide the attempt in which the coverage job really ran.
 */
function fetchJobInventory({ fetchImpl, repositoryPath, runId, headers }) {
  return fetchInventory({
    fetchImpl,
    headers,
    itemsKey: "jobs",
    noun: "job",
    pageUrl: (page) =>
      `https://api.github.com/repos/${repositoryPath}/actions/runs/${runId}/jobs?filter=all&per_page=${ARTIFACTS_PER_PAGE}&page=${page}`,
    describeFailure: (status) => `Could not fetch jobs for producer run ${runId} (HTTP ${status}).`,
  });
}

/** Reads a job record's attempt number, refusing anything but a positive integer. */
function readJobAttempt(job) {
  const attempt = Number(job.run_attempt);
  failIf(
    !isPositiveInteger(attempt),
    `Refusing producer run: a '${COVERAGE_JOB_NAME}' job record has an invalid run_attempt '${job.run_attempt}'.`
  );
  return attempt;
}

/** Returns the job's execution window in epoch milliseconds, refusing a missing or inverted one. */
function readJobWindow(job) {
  const startMs = typeof job.started_at === "string" ? Date.parse(job.started_at) : Number.NaN;
  const endMs = typeof job.completed_at === "string" ? Date.parse(job.completed_at) : Number.NaN;
  failIf(
    Number.isNaN(startMs) || Number.isNaN(endMs) || startMs > endMs,
    `Refusing producer run: the '${COVERAGE_JOB_NAME}' job has no valid started_at/completed_at window.`
  );
  return { startMs, endMs, startedAt: job.started_at, completedAt: job.completed_at };
}

/**
 * Finds the execution of the `unit-and-integration` job that produced
 * `coverage-report` and the attempt it ran in (SCRUM-764 M1).
 *
 * "Re-run failed jobs" lists a reused copy of a passed job in the new attempt
 * with the same started_at/completed_at as the original, so the run's own
 * `run_attempt` is not the attempt that uploaded the artifact. The execution is
 * the newest job record, which must have succeeded; its attempt is the oldest
 * record that shares its window. Anything ambiguous is refused.
 */
function selectCoverageProducerJob(allJobs, runId, runAttempt) {
  const records = allJobs
    .filter((job) => job.name === COVERAGE_JOB_NAME)
    .map((job) => ({ job, attempt: readJobAttempt(job) }));
  failIf(
    records.length === 0,
    `Refusing producer run: no '${COVERAGE_JOB_NAME}' job found for producer run ${runId}.`
  );
  const newestAttempt = Math.max(...records.map((record) => record.attempt));
  const newest = records.filter((record) => record.attempt === newestAttempt);
  failIf(
    newest.length > 1,
    `Refusing producer run: more than one '${COVERAGE_JOB_NAME}' job record for attempt ${newestAttempt}; expected exactly one.`
  );
  failIf(
    newestAttempt > runAttempt,
    `Refusing producer run: '${COVERAGE_JOB_NAME}' job attempt ${newestAttempt} is newer than the run attempt ${runAttempt}.`
  );
  const { job: latest } = newest[0];
  failIf(
    latest.status !== "completed" || latest.conclusion !== "success",
    `Refusing producer run: the latest '${COVERAGE_JOB_NAME}' job (attempt ${newestAttempt}) must be completed with conclusion 'success', got status '${latest.status}' and conclusion '${latest.conclusion}'.`
  );
  const window = readJobWindow(latest);
  const sameExecution = records.filter(
    (record) => record.job.started_at === latest.started_at && record.job.completed_at === latest.completed_at
  );
  return { producerAttempt: Math.min(...sameExecution.map((record) => record.attempt)), window };
}

function isCreatedInsideWindow(artifact, window) {
  const createdMs = typeof artifact.created_at === "string" ? Date.parse(artifact.created_at) : Number.NaN;
  return createdMs >= window.startMs && createdMs <= window.endMs;
}

/**
 * Returns the id and size of the one unique, non-expired coverage-report
 * artifact that was created while the successful coverage job ran. Artifacts
 * of the same name from other attempts fall outside that window.
 */
function selectCoverageArtifact(allArtifacts, runId, window) {
  const matchingArtifacts = allArtifacts.filter(
    (a) => a.name === "coverage-report" && !a.expired && isCreatedInsideWindow(a, window)
  );
  const windowText = `created inside the successful '${COVERAGE_JOB_NAME}' job window (${window.startedAt} to ${window.completedAt})`;
  failIf(
    matchingArtifacts.length === 0,
    `Refusing producer run: no non-expired 'coverage-report' artifact found for run ${runId} ${windowText}.`
  );
  failIf(
    matchingArtifacts.length > 1,
    `Refusing producer run: multiple (${matchingArtifacts.length}) non-expired 'coverage-report' artifacts found for run ${runId}; expected unique artifact ${windowText}.`
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

  // 3. Find the execution of the coverage job and the attempt it ran in. A re-run reuses a passed
  //    job, so the run's latest attempt is not necessarily the attempt that produced the artifact.
  const allJobs = await fetchJobInventory({ fetchImpl, repositoryPath, runId, headers });
  const { producerAttempt, window } = selectCoverageProducerJob(allJobs, runId, numericRunAttempt);

  // 4. Fetch and verify the unique non-expired coverage-report artifact created inside that job's
  //    window, with complete pagination
  const allArtifacts = await fetchArtifactInventory({ fetchImpl, repositoryPath, runId, headers });
  const { artifactId, artifactSizeBytes } = selectCoverageArtifact(allArtifacts, runId, window);

  return {
    verified: true,
    runId: numericRunId,
    // The attempt in which the coverage job executed; the manifest's run_attempt must equal it.
    runAttempt: producerAttempt,
    latestRunAttempt: numericRunAttempt,
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

/** Writes one error line to stderr with CR/LF neutralised (OWASP log injection; Sonar S5145). */
function logError(err) {
  console.error(safeLogValue(errorText(err)));
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
    logError(err);
    return 1;
  }
}

/**
 * Reads the producer context file. The outcome is a tagged result, not a bare
 * value, because valid JSON can itself be `null`: a null return would be
 * indistinguishable from "could not be read" and would skip the validator's own
 * refusal message (SCRUM-764). `{ ok: false }` means the reason was already
 * reported; `{ ok: true, value }` carries whatever the file parsed to, which the
 * validator then accepts or refuses with its message.
 */
function readProducerContextFile(contextFile) {
  if (!fs.existsSync(contextFile)) {
    logError(`Refusing coverage validation: producerContext file '${contextFile}' does not exist.`);
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(contextFile, "utf8")) };
  } catch (err) {
    logError(`Refusing coverage validation: producerContext file '${contextFile}' is invalid JSON: ${errorText(err)}`);
    return { ok: false };
  }
}

function runValidateArtifact(args) {
  const [coverageDir, checkoutRoot, expectedSha, contextFile] = args;
  if (!coverageDir || !checkoutRoot || !expectedSha || !contextFile) {
    console.error(USAGE_VALIDATE);
    return 1;
  }

  const contextRead = readProducerContextFile(contextFile);
  if (!contextRead.ok) {
    return 1;
  }

  try {
    const res = validateSonarMainCoverage({ coverageDir, checkoutRoot, expectedSha, producerContext: contextRead.value });
    console.log(
      `Validated coverage artifact for SHA ${safeLogValue(res.sha)}: ${safeLogValue(res.sfCount)} source records, ${safeLogValue(res.daCount)} DA lines, ${safeLogValue(res.bytes)} bytes, hash ${safeLogValue(res.sha256.slice(0, 12))}...`
    );
    return 0;
  } catch (err) {
    logError(err);
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

/** Resolves links in a path; a path that cannot be resolved (for example one that does not exist) stays as given. */
function realPathOrSelf(absolutePath) {
  try {
    return fs.realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * True when this module is the script node was started with (not an import).
 *
 * Node resolves links in `import.meta.url` but leaves `process.argv[1]` as the
 * caller typed it, so a script launched through a symlink or junction must be
 * compared by its real path. Comparing only the unresolved path made the CLI a
 * silent no-op (exit 0) behind a link (SCRUM-764 B1). The unresolved path is
 * still accepted, which is what `--preserve-symlinks-main` produces.
 */
export function isEntrypoint(scriptPath, moduleUrl) {
  if (!scriptPath) {
    return false;
  }
  const absolutePath = path.resolve(scriptPath);
  return [absolutePath, realPathOrSelf(absolutePath)].some((candidate) => pathToFileURL(candidate).href === moduleUrl);
}

/** Runs the CLI and turns an unexpected rejection into exit code 1. */
export async function runAsScript(run = main) {
  try {
    return await run();
  } catch (err) {
    logError(err instanceof Error && err.stack ? err.stack : err);
    return 1;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  process.exitCode = await runAsScript();
}
