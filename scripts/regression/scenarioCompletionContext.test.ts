// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { resolveLocalScenarioCandidate, resolveScenarioCompletionContext } from "./scenarioCompletionContext.mjs";

const repository = "aalzriqat/Auto";
const repositoryId = 12;
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const testedSha = "c".repeat(40);
const repo = { id: repositoryId, full_name: repository };
const pull = {
  number: 825, state: "open", draft: false,
  base: { ref: "main", sha: baseSha, repo }, head: { sha: headSha, repo },
};
const associatedPull = { number: pull.number, base: { sha: baseSha, repo }, head: { sha: headSha, repo } };
const localRun = {
  id: 200, run_attempt: 2, workflow_id: 30, path: ".github/workflows/scenario-runner.yml",
  event: "pull_request", repository: repo, head_repository: repo, head_sha: headSha,
  head_branch: "candidate", status: "completed", conclusion: "success" as string | null, pull_requests: [associatedPull],
};
const browserRun = {
  id: 300, run_attempt: 2, workflow_id: 40, path: ".github/workflows/browser-attack-swarm.yml",
  event: "workflow_run", repository: repo, head_repository: repo, head_sha: baseSha,
  head_branch: "main", status: "completed", conclusion: "success" as string | null, pull_requests: [],
};
const browserCheck = {
  name: "authenticated-pr-e2e", head_sha: headSha, app: { slug: "github-actions" },
  external_id: `g5:${pull.number}:${browserRun.id}:${browserRun.run_attempt}`,
  status: "completed", conclusion: "success",
};
const checkRoute = `/commits/${headSha}/check-runs?check_name=authenticated-pr-e2e&filter=all&per_page=100`;
const openRoute = "/pulls?state=open&per_page=100&page=1";
const mergeRef = { ref: `refs/pull/${pull.number}/merge`, object: { type: "commit", sha: testedSha } };
const merge = { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }] };

function harness(run = localRun) {
  const responses = new Map<string, unknown>([
    [`/actions/runs/${run.id}`, structuredClone(run)],
    ["/actions/workflows/scenario-runner.yml", { id: 30, path: localRun.path }],
    ["/actions/workflows/browser-attack-swarm.yml", { id: 40, path: browserRun.path }],
    [`/pulls/${pull.number}`, structuredClone(pull)],
    [openRoute, [structuredClone(pull)]],
    [checkRoute, { total_count: 1, check_runs: [structuredClone(browserCheck)] }],
  ]);
  const api = vi.fn(async (route: string) => {
    if (!responses.has(route)) throw new Error(`Unexpected route: ${route}`);
    return responses.get(route);
  });
  const event = { action: "completed", repository: repo, workflow_run: structuredClone(run) };
  return { responses, api, event };
}

function resolve(h: ReturnType<typeof harness>) {
  return resolveScenarioCompletionContext({ eventName: "workflow_run", event: h.event, repository, repositoryId, api: h.api });
}

describe("event-driven scenario completion targets", () => {
  it("resolves the completed local producer without waiting for another workflow", async () => {
    const h = harness();
    await expect(resolve(h)).resolves.toEqual({
      mode: "completion", targets: [{ prNumber: pull.number, headSha, baseSha }],
      trigger: { kind: "local", runId: localRun.id, attempt: 2, status: "completed", conclusion: "success" },
    });
    expect(h.api.mock.calls.map(([route]) => route)).not.toContain(openRoute);
  });

  it("resolves an admission against the live PR and ignores its stale event head", async () => {
    const h = harness();
    const event = { action: "synchronize", repository: repo, pull_request: pull };
    const input = { eventName: "pull_request_target", event, repository, repositoryId, api: h.api };
    await expect(resolveScenarioCompletionContext(input)).resolves.toEqual({
      mode: "admission", targets: [{ prNumber: pull.number, headSha, baseSha }],
    });
    h.responses.set(`/pulls/${pull.number}`, { ...pull, head: { ...pull.head, sha: "d".repeat(40) } });
    await expect(resolveScenarioCompletionContext(input)).resolves.toEqual({ mode: "admission", targets: [] });
  });

  it("maps a protected run with no pull_requests through its exact publication", async () => {
    const h = harness(browserRun);
    await expect(resolve(h)).resolves.toMatchObject({
      mode: "completion", targets: [{ prNumber: pull.number, headSha, baseSha }],
      trigger: { kind: "browser", runId: 300, attempt: 2 },
    });
  });

  it("uses an earlier attempt only as a revocation target hint while a rerun starts", async () => {
    const h = harness({ ...browserRun, status: "in_progress", conclusion: null });
    h.event.action = "in_progress";
    h.responses.set(checkRoute, { total_count: 1, check_runs: [{ ...browserCheck, external_id: `g5:${pull.number}:300:1` }] });
    await expect(resolve(h)).resolves.toMatchObject({
      targets: [{ prNumber: pull.number, headSha, baseSha }],
      trigger: { kind: "browser", runId: 300, attempt: 2, status: "in_progress", conclusion: null },
    });
  });

  it("ignores an older callback after the same producer started a new attempt", async () => {
    const h = harness();
    h.responses.set(`/actions/runs/${localRun.id}`, { ...localRun, run_attempt: 3, status: "in_progress" });
    await expect(resolve(h)).resolves.toMatchObject({ targets: [] });
    expect(h.api.mock.calls.map(([route]) => route)).not.toContain(`/pulls/${pull.number}`);
  });

  it.each([
    ["different producer", { external_id: `g5:${pull.number}:999:2` }],
    ["future attempt", { external_id: `g5:${pull.number}:300:3` }],
    ["different PR", { external_id: "g5:826:300:2" }],
    ["wrong producer app", { app: { slug: "another-app" } }],
    ["wrong head", { head_sha: baseSha }],
  ])("does not select a %s publication", async (_label, change) => {
    const h = harness(browserRun);
    h.responses.set(checkRoute, { total_count: 1, check_runs: [{ ...browserCheck, ...change }] });
    await expect(resolve(h)).resolves.toMatchObject({ targets: [] });
  });

  it("refuses ambiguous or incomplete publication inventories", async () => {
    const h = harness(browserRun);
    h.responses.set(checkRoute, { total_count: 2, check_runs: [browserCheck, browserCheck] });
    await expect(resolve(h)).rejects.toThrow("SCENARIO_COMPLETION_CHECKS_AMBIGUOUS");
    h.responses.set(checkRoute, { total_count: 2, check_runs: [browserCheck] });
    await expect(resolve(h)).rejects.toThrow("SCENARIO_COMPLETION_INVENTORY_INVALID");
  });

  it("reads a bounded complete open-PR inventory and refuses saturation", async () => {
    const h = harness(browserRun);
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ ...pull, number: i + 1 }));
    for (let page = 1; page <= 3; page++) {
      h.responses.set(`/pulls?state=open&per_page=100&page=${page}`,
        fullPage.map(entry => ({ ...entry, number: entry.number + (page - 1) * 100 })));
    }
    await expect(resolve(h)).rejects.toThrow("SCENARIO_COMPLETION_INVENTORY_BOUND");
    expect(h.api.mock.calls.map(([route]) => route)).not.toContain(checkRoute);
  });

  it("ignores a producer once its PR head changed", async () => {
    const h = harness();
    h.responses.set(`/pulls/${pull.number}`, { ...pull, head: { ...pull.head, sha: "d".repeat(40) } });
    await expect(resolve(h)).resolves.toMatchObject({ targets: [] });
  });

  it.each([
    ["workflow id", { workflow_id: 999 }],
    ["workflow path", { path: ".github/workflows/untrusted.yml" }],
    ["repository", { repository: { id: 13 } }],
    ["head repository", { head_repository: { id: 13 } }],
    ["event type", { event: "workflow_dispatch" }],
    ["head", { head_sha: "not-a-sha" }],
  ])("refuses inconsistent live producer %s", async (_label, change) => {
    const h = harness();
    h.responses.set(`/actions/runs/${localRun.id}`, { ...localRun, ...change });
    await expect(resolve(h)).rejects.toThrow("SCENARIO_COMPLETION_RUN_INVALID");
  });

  it("refuses malformed events before calling the API", async () => {
    const h = harness();
    h.event.repository = { ...repo, id: 99 };
    await expect(resolve(h)).rejects.toThrow("SCENARIO_COMPLETION_EVENT_INVALID");
    expect(h.api).not.toHaveBeenCalled();
  });
});

describe("local scenario candidate identity", () => {
  const input = () => ({ pull: structuredClone(pull), run: structuredClone(localRun),
    mergeRef: structuredClone(mergeRef), merge: structuredClone(merge), repositoryId, workflowId: 30 });

  it("preserves the producing local run and attempt, independent of the completion controller", () => {
    expect(resolveLocalScenarioCandidate(input())).toEqual({
      repositoryId, prNumber: pull.number, baseSha, headSha, testedSha,
      workflowRunId: 200, workflowAttempt: 2,
    });
  });

  it("keeps draft PR candidates available for the existing evidence validators", () => {
    const args = input();
    args.pull.draft = true;
    expect(resolveLocalScenarioCandidate(args)).toMatchObject({ prNumber: pull.number, headSha, baseSha, testedSha });
  });

  it.each([
    "base changed", "head changed", "different workflow", "wrong ref", "wrong merge", "reversed parents", "extra parent", "fork", "closed", "missing association",
  ])("refuses local evidence with %s", kind => {
    const args = input();
    if (kind === "base changed") args.pull.base.sha = "d".repeat(40);
    if (kind === "head changed") args.pull.head.sha = "d".repeat(40);
    if (kind === "different workflow") args.run.workflow_id = 31;
    if (kind === "wrong ref") args.mergeRef.ref = "refs/pull/826/merge";
    if (kind === "wrong merge") args.merge.sha = "d".repeat(40);
    if (kind === "reversed parents") args.merge.parents.reverse();
    if (kind === "extra parent") args.merge.parents.push({ sha: "d".repeat(40) });
    if (kind === "fork") args.pull.head.repo.id = 13;
    if (kind === "closed") args.pull.state = "closed";
    if (kind === "missing association") args.run.pull_requests = [];
    expect(() => resolveLocalScenarioCandidate(args)).toThrow("SCENARIO_COMPLETION_CANDIDATE_INVALID");
  });
});
