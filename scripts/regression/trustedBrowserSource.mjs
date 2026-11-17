import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PR_E2E_CHECK } from "../intelligence/trustedPrE2eGate.mjs";
import { matchesTrustedG5Artifact, matchesTrustedRunArtifact } from "../intelligence/trustedG5Artifact.mjs";
import { ROLE_AUDIT_ROLES, isProtectedReplayBinding, isTrustedOpeningReplayBinding, isTrustedRoleReplayBinding } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { readTrustedOpeningProofArchive, readTrustedRoleSummaryArchive } from "./trustedBrowserArchive.mjs";
import { bindTrustedBrowserReplays, matchesTrustedRunIdentity, readVerifiedBrowserReceipt } from "./trustedBrowserReceipt.mjs";
import { bindTrustedRoleReplays } from "./trustedRoleAuditReceipt.mjs";

const SHA = /^[a-f0-9]{40}$/;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ROLE_ARCHIVE_BYTES = 64 * 1024;
const OPENING_PROOF_ARTIFACT = "trusted-opening-proof";
const MAX_OPENING_ARCHIVE_BYTES = 64 * 1024;
const positiveId = id => Number.isSafeInteger(id) && id > 0;
const ID = "[1-9][0-9]{0,14}";
const REF = "[a-f0-9]{40}";
const READ_ROUTES = new RegExp(`^(?:/commits/${REF}/check-runs\\?check_name=${PR_E2E_CHECK}&filter=all&per_page=100|` +
  `/actions/workflows/browser-attack-swarm\\.yml|/actions/runs/${ID}|` +
  `/actions/runs/${ID}/artifacts\\?name=(?:trusted-g5-evidence-${ID}-${ID}|trusted-candidate-role-summary-${ID}-${ID}-(?:${ROLE_AUDIT_ROLES.join("|")})|${OPENING_PROOF_ARTIFACT})&per_page=100|` +
  `/actions/runs/${ID}/attempts/${ID}/jobs\\?per_page=100|/actions/artifacts/${ID}(?:/zip)?|` +
  `/pulls/${ID}|/git/ref/pull/${ID}/merge|/git/commits/${REF})$`);

function inventory(payload, field) {
  const entries = payload?.[field];
  return Array.isArray(entries) && entries.length === payload.total_count ? entries : [];
}

function publishedAttempt(api, { headSha, prNumber }) {
  const published = api(`/commits/${headSha}/check-runs?check_name=${PR_E2E_CHECK}&filter=all&per_page=100`);
  const matches = inventory(published, "check_runs").filter(check => check?.name === PR_E2E_CHECK && check?.app?.slug === "github-actions");
  if (matches.length !== 1) return null;
  const [check] = matches;
  if (check.head_sha !== headSha || check.status !== "completed") return null;
  const match = new RegExp(`^g5:${prNumber}:([1-9][0-9]{0,14}):([1-9][0-9]{0,14})$`).exec(check.external_id ?? "");
  return match ? { check, runId: Number(match[1]), attempt: Number(match[2]) } : null;
}

function producerArtifact(api, runId, name) {
  const payload = api(`/actions/runs/${runId}/artifacts?name=${name}&per_page=100`);
  const matches = inventory(payload, "artifacts").filter(artifact => artifact?.name === name);
  const [artifact] = matches;
  return matches.length === 1 && positiveId(artifact.id) && artifact.expired === false ? api(`/actions/artifacts/${artifact.id}`) : null;
}

function readProducerArchive(downloadZip, artifactId, byteLimit, read) {
  const parent = realpathSync(tmpdir());
  const scratch = mkdtempSync(path.join(parent, "autoflow-receipt-"));
  if (path.dirname(scratch) !== parent) throw new Error("Receipt scratch directory is outside the runner temp root.");
  try {
    const archivePath = path.join(scratch, "receipt.zip");
    const archive = downloadZip(artifactId);
    if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > byteLimit) return null;
    writeFileSync(archivePath, archive, { flag: "wx" });
    return read(archivePath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The candidate identity comes from the hosted PR event and checked-out merge. */
export function loadPublishedBrowserReceipt({ candidate, api, downloadZip, onTerminalRefusal = () => {} }) {
  const { repositoryId, prNumber, baseSha, headSha, testedSha } = candidate;
  if (![repositoryId, prNumber].every(positiveId) ||
      ![baseSha, headSha, testedSha].every(sha => typeof sha === "string" && SHA.test(sha))) return null;
  const publication = publishedAttempt(api, candidate);
  if (!publication) return null;
  const { check, runId, attempt } = publication;
  const workflow = api("/actions/workflows/browser-attack-swarm.yml");
  const run = api(`/actions/runs/${runId}`);
  const producer = { repositoryId, workflowId: workflow?.id, controllerSha: run?.head_sha, runId, attempt };
  if (!positiveId(producer.workflowId) || !SHA.test(producer.controllerSha ?? "") ||
      !matchesTrustedRunIdentity(run, producer) || run.status !== "completed") return null;
  if (run.conclusion !== "success" || check.conclusion !== "success") {
    const summary = check.output?.summary;
    if (typeof summary === "string" && summary.split(/\r?\n/).includes(`Tested backend and frontend merge: ${testedSha}`)) {
      onTerminalRefusal();
    }
    return null;
  }
  const artifact = producerArtifact(api, runId, `trusted-g5-evidence-${runId}-${attempt}`);
  const expected = { ...candidate, workflowId: workflow.id, artifactId: artifact?.id, controllerSha: run.head_sha, runId, attempt };
  if (!positiveId(expected.artifactId) || !matchesTrustedG5Artifact(artifact, expected) ||
      !positiveId(artifact.size_in_bytes) || artifact.size_in_bytes > MAX_ARCHIVE_BYTES) return null;
  const jobs = inventory(api(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`), "jobs");
  const pull = api(`/pulls/${prNumber}`);
  const mergeRef = api(`/git/ref/pull/${prNumber}/merge`);
  const merge = api(`/git/commits/${testedSha}`);
  const receipt = readProducerArchive(downloadZip, expected.artifactId, MAX_ARCHIVE_BYTES,
    archivePath => readVerifiedBrowserReceipt({ run, jobs, artifact, check, pull, mergeRef, merge, expected, archivePath }));
  return receipt ? { ...receipt, expected, jobs } : null;
}

function verifiedWorkerSucceeded(jobs, expected, workerName, requiredSteps) {
  if (!Array.isArray(jobs)) return false;
  const workers = jobs.filter(job => job?.name === workerName);
  const [worker] = workers;
  if (workers.length !== 1 || worker.run_id !== expected.runId || worker.run_attempt !== expected.attempt ||
      worker.status !== "completed" || worker.conclusion !== "success" || !Array.isArray(worker.steps)) return false;
  return requiredSteps.every(name => {
    const steps = worker.steps.filter(step => step?.name === name);
    return steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "success";
  });
}

export function readPublishedOpeningProof({ receipt, api, downloadZip }) {
  const { expected, jobs } = receipt;
  if (!verifiedWorkerSucceeded(jobs, expected, "terminal-opening-proof", [
    "Prove browser egress containment before authenticated traffic",
    "Execute the two terminal opening browser witnesses",
    "Verify exact terminal opening evidence",
    "Verify the local backend was not changed during the run",
    "Upload checked terminal opening evidence",
  ])) return null;
  try {
    const artifact = producerArtifact(api, expected.runId, OPENING_PROOF_ARTIFACT);
    if (!positiveId(artifact?.id) ||
        !matchesTrustedRunArtifact(artifact, { ...expected, artifactId: artifact.id }, OPENING_PROOF_ARTIFACT) ||
        !positiveId(artifact.size_in_bytes) || artifact.size_in_bytes > MAX_OPENING_ARCHIVE_BYTES) return null;
    return readProducerArchive(downloadZip, artifact.id, MAX_OPENING_ARCHIVE_BYTES,
      archivePath => readTrustedOpeningProofArchive(archivePath, artifact.digest));
  } catch {
    // An unreadable opening proof supplies no opening evidence.
    return null;
  }
}

export function readPublishedRoleSummaries({ receipt, api, downloadZip }) {
  const { expected, jobs } = receipt;
  if (!ROLE_AUDIT_ROLES.every(role => verifiedWorkerSucceeded(jobs, expected,
    `candidate-role-audit-${role}`, ["Audit exact candidate role and tenant authority",
      "Verify the local backend was not changed during the run", "Upload verified candidate role summary"]))) return [];
  const summaries = [];
  for (const role of ROLE_AUDIT_ROLES) {
    const name = `trusted-candidate-role-summary-${expected.runId}-${expected.attempt}-${role}`;
    const artifact = producerArtifact(api, expected.runId, name);
    if (!positiveId(artifact?.id) || !matchesTrustedRunArtifact(artifact, { ...expected, artifactId: artifact.id }, name) ||
        !positiveId(artifact.size_in_bytes) || artifact.size_in_bytes > MAX_ROLE_ARCHIVE_BYTES) return [];
    const summary = readProducerArchive(downloadZip, artifact.id, MAX_ROLE_ARCHIVE_BYTES,
      archivePath => readTrustedRoleSummaryArchive(archivePath, artifact.digest));
    if (summary?.role !== role) return [];
    summaries.push(summary);
  }
  return summaries;
}

/** Read-only GitHub transport for the hosted runner's short-lived token. */
export function createGitHubReceiptTransport({ repository, token }) {
  if (typeof repository !== "string" || !/^[\w-]+\/[\w.-]+$/.test(repository) ||
      repository.endsWith("/.") || repository.endsWith("/..") || !token) throw new Error("GitHub receipt context is unavailable.");
  const command = (route, maxBuffer) => {
    if (!READ_ROUTES.test(route)) throw new Error("GitHub receipt route is unavailable.");
    return execFileSync("/usr/bin/gh", ["api", "--hostname", "github.com", `repos/${repository}${route}`], {
      env: { GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", HOME: process.env.HOME },
      maxBuffer, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    });
  };
  return {
    api: route => JSON.parse(command(route, 2 * 1024 * 1024).toString("utf8")),
    downloadZip: id => command(`/actions/artifacts/${id}/zip`, MAX_ARCHIVE_BYTES),
  };
}

function gitCommand(root) {
  const git = resolveTrustedGitExecutable();
  return (...args) => execFileSync(git, args, {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024, timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
  });
}

function collectRegistry(git, receipt, selected) {
  const { controllerSha, baseSha } = receipt.expected;
  git("merge-base", "--is-ancestor", controllerSha, baseSha);
  const trusted = [];
  for (const { id } of selected) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) continue;
    try {
      const record = JSON.parse(git("cat-file", "blob", `${controllerSha}:regression/scenarios/screen/${id}.scenario.json`));
      if (record?.id === id) trusted.push(record);
    } catch {
      // A candidate-new or unparseable definition has no trusted binding.
    }
  }
  return trusted;
}

export function hostedReplayCandidate(env, base) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const pull = event?.pull_request;
  const testedSha = env.GITHUB_SHA;
  const repositoryId = Number(env.GITHUB_REPOSITORY_ID);
  const workflowRunId = Number(env.GITHUB_RUN_ID);
  const workflowAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!pull || !SHA.test(testedSha ?? "") || pull.base?.sha !== base ||
      ![repositoryId, workflowRunId, workflowAttempt, pull.number].every(positiveId) ||
      event.repository?.id !== repositoryId || pull.base?.repo?.id !== repositoryId || pull.head?.repo?.id !== repositoryId ||
      env.GITHUB_REF !== `refs/pull/${pull.number}/merge`) return null;
  return { repositoryId, prNumber: pull.number, baseSha: base, headSha: pull.head.sha, testedSha, workflowRunId, workflowAttempt };
}

// No caller-provided report path or verdict file participates in the join.
export function collectHostedBrowserReplays({ root, candidate, selected, env }) {
  const supported = selected.filter(isProtectedReplayBinding);
  if (!supported.length) return { ready: true, verdicts: [] };
  try {
    const git = gitCommand(root);
    const transport = createGitHubReceiptTransport({ repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN });
    const liveRef = transport.api(`/git/ref/pull/${candidate.prNumber}/merge`);
    if (liveRef?.object?.sha !== candidate.testedSha) return { ready: true, verdicts: [] };
    let terminalRefusal = false;
    const receipt = loadPublishedBrowserReceipt({ candidate, ...transport, onTerminalRefusal: () => { terminalRefusal = true; } });
    if (!receipt) return { ready: terminalRefusal, verdicts: [] };
    const trusted = collectRegistry(git, receipt, supported);
    const opening = supported.some(isTrustedOpeningReplayBinding) ?
      readPublishedOpeningProof({ receipt, ...transport }) : undefined;
    const verdicts = bindTrustedBrowserReplays({ ...receipt, opening, selected: supported, trusted });
    if (supported.some(isTrustedRoleReplayBinding)) {
      const summaries = readPublishedRoleSummaries({ receipt, ...transport });
      verdicts.push(...bindTrustedRoleReplays({ summaries, expected: receipt.expected,
        repository: env.GITHUB_REPOSITORY, selected: supported, trusted }));
    }
    return { ready: true, verdicts };
  } catch {
    return { ready: false, verdicts: [] };
  }
}

export function readProtectedReplayDiff(root, candidate) {
  const { baseSha, headSha, testedSha } = candidate;
  if (![baseSha, headSha, testedSha].every(sha => typeof sha === "string" && SHA.test(sha))) {
    throw new Error("Exact replay candidate is unavailable.");
  }
  const git = gitCommand(root);
  if (git("rev-parse", "HEAD").trim() !== baseSha ||
      git("rev-parse", "refs/autoflow/scenario-merge").trim() !== testedSha ||
      git("show", "-s", "--format=%P", testedSha).trim() !== `${baseSha} ${headSha}`) {
    throw new Error("Fetched replay candidate is no longer current.");
  }
  return git("diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", baseSha, testedSha, "--")
    .split("\0").filter(Boolean);
}
