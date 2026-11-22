import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { resolveScenarioCompletionContext } from "./scenarioCompletionContext.mjs";
import { readScenarioCompletionState } from "./scenarioCompletionState.mjs";
import { createScenarioCompletionApi } from "./scenarioCompletionTransport.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const POSITIVE_ID = /^[1-9][0-9]{0,14}$/u;

function environment(env) {
  const repository = env.GITHUB_REPOSITORY;
  const repositoryId = Number(env.GITHUB_REPOSITORY_ID);
  if (env.GITHUB_ACTIONS !== "true" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      !POSITIVE_ID.test(env.GITHUB_RUN_ID ?? "") || !POSITIVE_ID.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
      !SHA.test(env.GITHUB_WORKFLOW_SHA ?? "") ||
      env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/scenario-completion.yml@refs/heads/main` ||
      !["workflow_run", "pull_request_target"].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error("SCENARIO_COMPLETION_ENVIRONMENT_INVALID");
  }
  return { repository, repositoryId };
}

/** The worktree is the protected base; candidate files remain unexecuted Git objects. */
async function withBaseCheckout(root, candidate, workflowSha, operation) {
  const git = (...args) => execFileSync(resolveTrustedGitExecutable(), args, {
    cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("fetch", "--no-tags", "origin", `refs/pull/${candidate.prNumber}/merge:refs/autoflow/scenario-merge`);
  if (git("rev-parse", "HEAD") !== workflowSha || git("rev-parse", "refs/autoflow/scenario-merge") !== candidate.testedSha) {
    throw new Error("SCENARIO_COMPLETION_CONTEXT_CHANGED");
  }
  git("merge-base", "--is-ancestor", candidate.baseSha, workflowSha);
  try {
    git("cat-file", "-e", `${candidate.baseSha}:scripts/regression/scenarioCompletionCli.mjs`);
  } catch {
    // The first PR is certified by its existing base-controlled native gate.
    return { kind: "legacy" };
  }
  const temporary = mkdtempSync(path.join(tmpdir(), "autoflow-scenario-base-"));
  const checkout = path.join(temporary, "base");
  let registered = false;
  try {
    git("worktree", "add", "--detach", checkout, candidate.baseSha);
    registered = true;
    return await operation(checkout);
  } finally {
    if (registered) git("worktree", "remove", "--force", checkout);
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function runScenarioCompletionCommand({ root, args, env, transport, log = console.log }) {
  const { repository, repositoryId } = environment(env);
  const connection = transport ?? createScenarioCompletionApi({ repository, token: env.GH_TOKEN });
  if (args.length !== 1) throw new Error("SCENARIO_COMPLETION_MODE_INVALID");
  if (args[0] === "resolve") {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const result = await resolveScenarioCompletionContext({ eventName: env.GITHUB_EVENT_NAME, event,
      repository, repositoryId, api: connection.api });
    appendFileSync(env.GITHUB_OUTPUT, `targets=${JSON.stringify(result.targets)}\n`);
    log(`Scenario completion targets: ${result.targets.length}.`);
    return result;
  }
  if (args[0] !== "verify" || !POSITIVE_ID.test(env.SCENARIO_PR_NUMBER ?? "")) throw new Error("SCENARIO_COMPLETION_MODE_INVALID");
  const [{ publishScenarioCompletion }, evidence, { createGitHubReceiptTransport }] = await Promise.all([
    import("./scenarioCompletionCheck.mjs"), import("./scenarioCompletionEvidence.mjs"), import("./trustedBrowserSource.mjs"),
  ]);
  const stateArgs = { api: connection.api, repositoryId, prNumber: Number(env.SCENARIO_PR_NUMBER), includeBrowser: false };
  const initial = readScenarioCompletionState(stateArgs);
  const verdict = await withBaseCheckout(root, initial.candidate, env.GITHUB_WORKFLOW_SHA, async checkout => {
    stateArgs.includeBrowser = evidence.selectProtectedScenarioReplays({ checkout, candidate: initial.candidate }).length > 0;
    const state = readScenarioCompletionState(stateArgs);
    if (["baseSha", "headSha", "testedSha"].some(key => state.candidate[key] !== initial.candidate[key])) {
      throw new Error("SCENARIO_COMPLETION_CONTEXT_CHANGED");
    }
    const snapshot = () => {
      if (readScenarioCompletionState(stateArgs).fingerprint !== state.fingerprint) {
        throw new Error("SCENARIO_COMPLETION_CONTEXT_CHANGED");
      }
    };
    const publication = { candidate: state.candidate, api: connection.request, snapshot,
      detailsUrl: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}` };
    await publishScenarioCompletion({ ...publication, verdict: { kind: "pending", code: "WAITING_FOR_PRODUCERS" } });
    let result = { kind: "pending", code: "LOCAL_SCENARIOS_PENDING" };
    if (state.exactLocal) {
      const receipts = transport?.receipts ?? createGitHubReceiptTransport({ repository, token: env.GH_TOKEN });
      try {
        result = evidence.evaluateScenarioCompletion({ checkout, candidate: state.candidate, localRun: state.localRun, ...receipts, env });
        if (result.kind === "success" && !evidence.matchesScenarioCompletionEvidenceSnapshot(result.fingerprint, state)) {
          result = { kind: "failure", code: "SCENARIO_EVIDENCE_INVALID" };
        }
      } catch {
        result = { kind: "failure", code: "SCENARIO_CERTIFICATION_UNAVAILABLE" };
      }
    }
    await publishScenarioCompletion({ ...publication, verdict: result });
    return result;
  });
  log(`Scenario completion for PR ${initial.candidate.prNumber}: ${verdict.kind}.`);
  return verdict;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runScenarioCompletionCommand({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      args: process.argv.slice(2), env: process.env });
  } catch {
    console.error("Scenario evidence could not be published; the exact merge remains uncertified.");
    process.exitCode = 1;
  }
}
