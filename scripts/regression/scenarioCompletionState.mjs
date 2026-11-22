import { createHash } from "node:crypto";
import { resolveLocalScenarioCandidate } from "./scenarioCompletionContext.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const sourcePath = ".github/workflows/scenario-runner.yml";

function complete(payload, field) {
  const rows = payload?.[field];
  if (!Array.isArray(rows) || rows.length !== payload.total_count) throw new Error("SCENARIO_COMPLETION_INVENTORY_INVALID");
  return rows;
}

/** Read the exact publication destination independently of both producers. */
export function readScenarioCompletionCandidate({ api, repositoryId, prNumber }) {
  if (!positiveId(repositoryId) || !positiveId(prNumber)) throw new Error("SCENARIO_COMPLETION_CONTEXT_INVALID");
  const pull = api(`/pulls/${prNumber}`);
  if (pull?.number !== prNumber || pull.state !== "open" || pull.base?.ref !== "main" ||
      pull.head?.repo?.id !== repositoryId || pull.base?.repo?.id !== repositoryId ||
      !SHA.test(pull.base.sha ?? "") || !SHA.test(pull.head.sha ?? "")) throw new Error("SCENARIO_COMPLETION_CONTEXT_INVALID");
  const mergeRef = api(`/git/ref/pull/${prNumber}/merge`);
  const testedSha = mergeRef?.object?.sha;
  if (mergeRef?.ref !== `refs/pull/${prNumber}/merge` || mergeRef.object?.type !== "commit" || !SHA.test(testedSha ?? "")) {
    throw new Error("SCENARIO_COMPLETION_CONTEXT_INVALID");
  }
  const merge = api(`/git/commits/${testedSha}`);
  if (merge?.sha !== testedSha || merge.parents?.length !== 2 ||
      merge.parents[0]?.sha !== pull.base.sha || merge.parents[1]?.sha !== pull.head.sha) {
    throw new Error("SCENARIO_COMPLETION_CONTEXT_INVALID");
  }
  return { pull, mergeRef, merge,
    candidate: { repositoryId, prNumber, baseSha: pull.base.sha, headSha: pull.head.sha, testedSha } };
}

/** Re-sample before publishing; callbacks never carry a verdict from an earlier attempt. */
export function readScenarioCompletionState({ api, repositoryId, prNumber, includeBrowser = true }) {
  if (typeof includeBrowser !== "boolean") throw new Error("SCENARIO_COMPLETION_CONTEXT_INVALID");
  const { pull, mergeRef, merge, candidate: mergeCandidate } = readScenarioCompletionCandidate({ api, repositoryId, prNumber });
  let candidate = mergeCandidate;
  const workflow = api("/actions/workflows/scenario-runner.yml");
  if (!positiveId(workflow?.id) || workflow.path !== sourcePath) throw new Error("SCENARIO_COMPLETION_WORKFLOW_INVALID");
  const runs = complete(api(`/actions/workflows/scenario-runner.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`), "workflow_runs");
  if (new Set(runs.map(run => run.id)).size !== runs.length || runs.some(run => !positiveId(run.id))) {
    throw new Error("SCENARIO_COMPLETION_INVENTORY_INVALID");
  }
  const matching = runs.filter(run => run.path === sourcePath && run.workflow_id === workflow.id &&
    run.event === "pull_request" && run.head_sha === pull.head.sha &&
    run.repository?.id === repositoryId && run.head_repository?.id === repositoryId &&
    run.pull_requests?.some(pr => pr.number === prNumber)).sort((left, right) => right.id - left.id);
  const localRun = matching.length ? api(`/actions/runs/${matching[0].id}`) : null;
  let exactLocal = false;
  if (localRun) {
    if (localRun.id !== matching[0].id) throw new Error("SCENARIO_COMPLETION_RUN_INVALID");
    try {
      candidate = resolveLocalScenarioCandidate({ pull, run: localRun, mergeRef, merge, repositoryId, workflowId: workflow.id });
      exactLocal = true;
    } catch {
      // An older base or malformed source cannot supply this merge's evidence.
    }
  }
  let publication = null;
  let producerRun = null;
  if (includeBrowser) {
    const publications = complete(api(`/commits/${pull.head.sha}/check-runs?check_name=authenticated-pr-e2e&filter=all&per_page=100`), "check_runs")
      .filter(check => check?.name === "authenticated-pr-e2e" && check.app?.slug === "github-actions");
    if (publications.length > 1) throw new Error("SCENARIO_COMPLETION_CHECKS_AMBIGUOUS");
    publication = publications[0] ?? null;
    const source = new RegExp(`^g5:${prNumber}:([1-9][0-9]{0,14}):([1-9][0-9]{0,14})$`, "u").exec(publication?.external_id ?? "");
    producerRun = source ? api(`/actions/runs/${source[1]}`) : null;
  }
  const identity = run => run ? [run.id, run.run_attempt, run.status, run.conclusion, run.head_sha, run.workflow_id] : null;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    candidate, exactLocal, includeBrowser, draft: pull.draft, local: identity(localRun), browser: identity(producerRun),
    publication: publication ? [publication.id, publication.head_sha, publication.external_id,
      publication.status, publication.conclusion, publication.output?.summary] : null,
  })).digest("hex");
  return { candidate, exactLocal, localRun, publication, producerRun, fingerprint };
}
