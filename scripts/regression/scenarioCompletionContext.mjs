import { PR_E2E_CHECK } from "../intelligence/trustedPrE2eGate.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const WORKFLOWS = Object.freeze({
  local: { file: "scenario-runner.yml", event: "pull_request" },
  browser: { file: "browser-attack-swarm.yml", event: "workflow_run" },
});
const ACTIONS = new Set(["requested", "in_progress", "completed"]);
const ADMISSIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"]);
const STATUSES = new Set(["requested", "queued", "pending", "waiting", "in_progress", "completed"]);
const MAX_PULL_PAGES = 3;

function sameRepository(value, repositoryId, repository) {
  return value?.id === repositoryId && (repository === undefined || value.full_name === undefined || value.full_name === repository);
}

function currentPull(pull, repositoryId, repository) {
  return positiveId(pull?.number) && pull.state === "open" && pull.base?.ref === "main" &&
    SHA.test(pull.base.sha ?? "") && SHA.test(pull.head?.sha ?? "") &&
    sameRepository(pull.base.repo, repositoryId, repository) && sameRepository(pull.head.repo, repositoryId, repository);
}

function target(pull) {
  return { prNumber: pull.number, headSha: pull.head.sha, baseSha: pull.base.sha };
}

function validRun(run, kind, repositoryId, workflowId, repository) {
  const workflow = WORKFLOWS[kind];
  return positiveId(run?.id) && positiveId(run.run_attempt) && positiveId(workflowId) &&
    run.workflow_id === workflowId && run.path === `.github/workflows/${workflow.file}` && run.event === workflow.event &&
    sameRepository(run.repository, repositoryId, repository) && sameRepository(run.head_repository, repositoryId, repository) &&
    SHA.test(run.head_sha ?? "") && STATUSES.has(run.status) && (kind !== "browser" || run.head_branch === "main");
}

async function listOpenPulls(api) {
  const pulls = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PULL_PAGES; page++) {
    const batch = await api(`/pulls?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100) throw new Error("SCENARIO_COMPLETION_INVENTORY_INVALID");
    for (const pull of batch) {
      if (!positiveId(pull?.number) || seen.has(pull.number)) throw new Error("SCENARIO_COMPLETION_INVENTORY_INVALID");
      seen.add(pull.number);
      pulls.push(pull);
    }
    if (batch.length < 100) return pulls;
  }
  throw new Error("SCENARIO_COMPLETION_INVENTORY_BOUND");
}

function publicationPointsAt(check, pull, run) {
  const match = new RegExp(`^g5:${pull.number}:${run.id}:([1-9][0-9]{0,14})$`, "u").exec(check.external_id ?? "");
  const attempt = Number(match?.[1]);
  // This is a target hint only. An earlier attempt identifies which success a
  // newly started attempt must revoke before its publisher updates the pointer.
  return check.head_sha === pull.head.sha && positiveId(attempt) && attempt <= run.run_attempt;
}

async function browserTargets({ run, api, repositoryId, repository }) {
  const pulls = await listOpenPulls(api);
  const targets = [];
  for (const pull of pulls) {
    if (!currentPull(pull, repositoryId, repository)) continue;
    const payload = await api(`/commits/${pull.head.sha}/check-runs?check_name=${PR_E2E_CHECK}&filter=all&per_page=100`);
    if (!Array.isArray(payload?.check_runs) || payload.check_runs.length !== payload.total_count) {
      throw new Error("SCENARIO_COMPLETION_INVENTORY_INVALID");
    }
    const publications = payload.check_runs.filter(check => check?.name === PR_E2E_CHECK && check.app?.slug === "github-actions");
    if (!publications.some(check => publicationPointsAt(check, pull, run))) continue;
    if (publications.length !== 1) throw new Error("SCENARIO_COMPLETION_CHECKS_AMBIGUOUS");
    const live = await api(`/pulls/${pull.number}`);
    if (currentPull(live, repositoryId, repository) && live.number === pull.number && live.head.sha === pull.head.sha) {
      targets.push(target(live));
    }
  }
  if (targets.length > 1) throw new Error("SCENARIO_COMPLETION_TARGET_AMBIGUOUS");
  return targets;
}

/** Discover recipients for a protected completion event; no result here certifies evidence. */
export async function resolveScenarioCompletionContext({ eventName, event, repository, repositoryId, api }) {
  if (!positiveId(repositoryId) || typeof repository !== "string" || !/^[\w-]+\/[\w.-]+$/u.test(repository) ||
      /\/(?:\.|\.\.)$/u.test(repository) || !sameRepository(event?.repository, repositoryId, repository)) {
    throw new Error("SCENARIO_COMPLETION_EVENT_INVALID");
  }
  if (eventName === "pull_request_target") {
    const snapshot = event.pull_request;
    if (!ADMISSIONS.has(event.action) || !positiveId(snapshot?.number) || !SHA.test(snapshot.head?.sha ?? "")) {
      throw new Error("SCENARIO_COMPLETION_EVENT_INVALID");
    }
    const live = await api(`/pulls/${snapshot.number}`);
    const targets = currentPull(live, repositoryId, repository) && live.number === snapshot.number && live.head.sha === snapshot.head.sha
      ? [target(live)] : [];
    return { mode: "admission", targets };
  }
  const snapshot = event.workflow_run;
  if (eventName !== "workflow_run" || !ACTIONS.has(event.action) ||
      !positiveId(snapshot?.id) || !positiveId(snapshot.run_attempt)) throw new Error("SCENARIO_COMPLETION_EVENT_INVALID");
  const run = await api(`/actions/runs/${snapshot.id}`);
  const kind = Object.keys(WORKFLOWS).find(key => snapshot.path === `.github/workflows/${WORKFLOWS[key].file}`);
  if (!kind || run?.id !== snapshot.id) throw new Error("SCENARIO_COMPLETION_RUN_INVALID");
  const definition = await api(`/actions/workflows/${WORKFLOWS[kind].file}`);
  if (definition?.path !== snapshot.path || !validRun(run, kind, repositoryId, definition.id, repository)) {
    throw new Error("SCENARIO_COMPLETION_RUN_INVALID");
  }
  const trigger = { kind, runId: run.id, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion ?? null };
  if (run.run_attempt > snapshot.run_attempt) return { mode: "completion", targets: [], trigger };
  if (run.run_attempt !== snapshot.run_attempt || run.head_sha !== snapshot.head_sha || run.workflow_id !== snapshot.workflow_id) {
    throw new Error("SCENARIO_COMPLETION_RUN_INVALID");
  }
  if (kind === "browser") {
    return { mode: "completion", targets: await browserTargets({ run, api, repositoryId, repository }), trigger };
  }
  const associated = run.pull_requests;
  if (!Array.isArray(associated) || associated.length !== 1 || !positiveId(associated[0]?.number) ||
      associated[0].head?.sha !== run.head_sha) throw new Error("SCENARIO_COMPLETION_RUN_INVALID");
  const live = await api(`/pulls/${associated[0].number}`);
  const targets = currentPull(live, repositoryId, repository) && live.number === associated[0].number && live.head.sha === run.head_sha
    ? [target(live)] : [];
  return { mode: "completion", targets, trigger };
}

/** The local producer's event identity and live Git parents bind its evidence. */
export function resolveLocalScenarioCandidate({ pull, run, mergeRef, merge, repositoryId, workflowId }) {
  const associated = run?.pull_requests;
  const testedSha = mergeRef?.object?.sha;
  if (!positiveId(repositoryId) || !currentPull(pull, repositoryId) ||
      !validRun(run, "local", repositoryId, workflowId) || run.head_sha !== pull.head.sha ||
      !Array.isArray(associated) || associated.length !== 1 || associated[0]?.number !== pull.number ||
      associated[0].head?.sha !== pull.head.sha || associated[0].base?.sha !== pull.base.sha ||
      !sameRepository(associated[0].head?.repo, repositoryId) || !sameRepository(associated[0].base?.repo, repositoryId) ||
      mergeRef?.ref !== `refs/pull/${pull.number}/merge` || mergeRef.object?.type !== "commit" || !SHA.test(testedSha ?? "") ||
      merge?.sha !== testedSha || !Array.isArray(merge.parents) || merge.parents.length !== 2 ||
      merge.parents[0]?.sha !== pull.base.sha || merge.parents[1]?.sha !== pull.head.sha) {
    throw new Error("SCENARIO_COMPLETION_CANDIDATE_INVALID");
  }
  return { repositoryId, prNumber: pull.number, baseSha: pull.base.sha, headSha: pull.head.sha, testedSha,
    workflowRunId: run.id, workflowAttempt: run.run_attempt };
}
