// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readScenarioCompletionState } from "./scenarioCompletionState.mjs";

const repositoryId = 12;
const prNumber = 825;
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const testedSha = "c".repeat(40);
const repo = { id: repositoryId, full_name: "aalzriqat/Auto" };
const pull = { number: prNumber, state: "open", draft: false,
  base: { ref: "main", sha: baseSha, repo }, head: { sha: headSha, repo } };
const sourcePath = ".github/workflows/scenario-runner.yml";
const runsRoute = `/actions/workflows/scenario-runner.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
const checkRoute = `/commits/${headSha}/check-runs?check_name=authenticated-pr-e2e&filter=all&per_page=100`;
const localRun = { id: 200, workflow_id: 30, path: sourcePath, event: "pull_request",
  run_attempt: 2, status: "completed", conclusion: "success", head_sha: headSha,
  repository: repo, head_repository: repo,
  pull_requests: [{ number: prNumber, base: { sha: baseSha, repo }, head: { sha: headSha, repo } }] };
const producerRun = { id: 300, workflow_id: 40, run_attempt: 2, status: "completed", conclusion: "success", head_sha: baseSha };
const publication = { id: 400, name: "authenticated-pr-e2e", app: { slug: "github-actions" }, head_sha: headSha,
  status: "completed", conclusion: "success", external_id: `g5:${prNumber}:300:2`, output: { summary: "Fixed receipt summary." } };

function harness() {
  const responses = new Map<string, unknown>([
    [`/pulls/${prNumber}`, structuredClone(pull)],
    [`/git/ref/pull/${prNumber}/merge`, { ref: `refs/pull/${prNumber}/merge`, object: { type: "commit", sha: testedSha } }],
    [`/git/commits/${testedSha}`, { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }] }],
    ["/actions/workflows/scenario-runner.yml", { id: 30, path: sourcePath }],
    [runsRoute, { total_count: 1, workflow_runs: [structuredClone(localRun)] }],
    ["/actions/runs/200", structuredClone(localRun)],
    [checkRoute, { total_count: 1, check_runs: [structuredClone(publication)] }],
    ["/actions/runs/300", structuredClone(producerRun)],
  ]);
  const api = vi.fn((route: string) => {
    if (!responses.has(route)) throw new Error(`Unexpected API route: ${route}`);
    return structuredClone(responses.get(route));
  });
  const read = (options: { includeBrowser?: boolean } = {}) => readScenarioCompletionState({ api, repositoryId, prNumber, ...options });
  return { api, responses, read };
}

describe("current scenario producer state", () => {
  it("binds the local producer to the live PR and exact two-parent merge", () => {
    const h = harness();
    const state = h.read();
    expect(state).toMatchObject({ exactLocal: true,
      candidate: { repositoryId, prNumber, baseSha, headSha, testedSha, workflowRunId: 200, workflowAttempt: 2 },
      localRun, publication, producerRun });
    expect(state.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(h.read().fingerprint).toBe(state.fingerprint);
  });

  it("represents admission without inventing a local run or browser source", () => {
    const h = harness();
    h.responses.set(runsRoute, { total_count: 0, workflow_runs: [] });
    h.responses.set(checkRoute, { total_count: 0, check_runs: [] });
    expect(h.read()).toMatchObject({ candidate: { repositoryId, prNumber, baseSha, headSha, testedSha },
      exactLocal: false, localRun: null, publication: null, producerRun: null });
    expect(h.api.mock.calls.some(([route]) => route.startsWith("/actions/runs/"))).toBe(false);
  });

  it("does not read or depend on unavailable browser sources when only local evidence is required", () => {
    const h = harness();
    h.api.mockImplementation(route => {
      if (route === checkRoute || route === "/actions/runs/300") throw new Error("BROWSER_SOURCE_UNAVAILABLE");
      if (!h.responses.has(route)) throw new Error("Unexpected fixture API route");
      return structuredClone(h.responses.get(route));
    });
    const state = h.read({ includeBrowser: false });
    expect(state).toMatchObject({ exactLocal: true, publication: null, producerRun: null });
    h.responses.set(checkRoute, { total_count: 2, check_runs: [publication, { ...publication, id: 401 }] });
    h.responses.set("/actions/runs/300", { ...producerRun, run_attempt: 3, status: "in_progress" });
    expect(h.read({ includeBrowser: false }).fingerprint).toBe(state.fingerprint);
    expect(h.api.mock.calls.map(([route]) => route)).not.toContain(checkRoute);
    expect(h.api.mock.calls.map(([route]) => route)).not.toContain("/actions/runs/300");
  });

  it("binds browser scope into the fingerprint even before a browser publication exists", () => {
    const h = harness();
    h.responses.set(checkRoute, { total_count: 0, check_runs: [] });
    const local = h.read({ includeBrowser: false });
    expect(h.read().fingerprint).not.toBe(local.fingerprint);
    expect(h.read({ includeBrowser: true }).fingerprint).toBe(h.read().fingerprint);
  });

  it("selects the latest local run instead of reusing an older successful run", () => {
    const h = harness();
    const newer = { ...localRun, id: 201, run_attempt: 1, status: "in_progress", conclusion: null };
    h.responses.set(runsRoute, { total_count: 2, workflow_runs: [localRun, newer] });
    h.responses.set("/actions/runs/201", newer);
    expect(h.read()).toMatchObject({ exactLocal: true, candidate: { workflowRunId: 201, workflowAttempt: 1 },
      localRun: { status: "in_progress", conclusion: null } });
    expect(h.api.mock.calls.map(([route]) => route)).not.toContain("/actions/runs/200");
  });

  it("does not fall back to older evidence when the latest run used another base", () => {
    const h = harness();
    const newer = { ...localRun, id: 201,
      pull_requests: [{ ...localRun.pull_requests[0], base: { sha: "d".repeat(40), repo } }] };
    h.responses.set(runsRoute, { total_count: 2, workflow_runs: [newer, localRun] });
    h.responses.set("/actions/runs/201", newer);
    const state = h.read();
    expect(state.exactLocal).toBe(false);
    expect(state.candidate).not.toHaveProperty("workflowRunId");
    expect(state.localRun).toMatchObject({ id: 201 });
    expect(h.api.mock.calls.map(([route]) => route)).not.toContain("/actions/runs/200");
  });

  it.each([
    ["local attempt", "/actions/runs/200", { ...localRun, run_attempt: 3, status: "in_progress", conclusion: null }],
    ["browser attempt", "/actions/runs/300", { ...producerRun, run_attempt: 3, status: "in_progress", conclusion: null }],
    ["browser result", "/actions/runs/300", { ...producerRun, conclusion: "failure" }],
    ["browser publication", checkRoute, { total_count: 1, check_runs: [{ ...publication, conclusion: "failure" }] }],
    ["draft state", `/pulls/${prNumber}`, { ...pull, draft: true }],
  ])("changes the snapshot when the %s changes", (_label, route, response) => {
    const h = harness();
    const before = h.read().fingerprint;
    h.responses.set(route, response);
    expect(h.read().fingerprint).not.toBe(before);
  });

  it.each([
    ["wrong first parent", { sha: testedSha, parents: [{ sha: headSha }, { sha: baseSha }] }],
    ["third parent", { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }, { sha: "d".repeat(40) }] }],
    ["wrong returned commit", { sha: headSha, parents: [{ sha: baseSha }, { sha: headSha }] }],
  ])("refuses a merge with a %s", (_label, merge) => {
    const h = harness();
    h.responses.set(`/git/commits/${testedSha}`, merge);
    expect(h.read).toThrow("SCENARIO_COMPLETION_CONTEXT_INVALID");
  });

  it.each([
    ["fork", { ...pull, head: { ...pull.head, repo: { id: 13 } } }],
    ["closed PR", { ...pull, state: "closed" }],
    ["retargeted PR", { ...pull, base: { ...pull.base, ref: "release" } }],
  ])("refuses a %s", (_label, changedPull) => {
    const h = harness();
    h.responses.set(`/pulls/${prNumber}`, changedPull);
    expect(h.read).toThrow("SCENARIO_COMPLETION_CONTEXT_INVALID");
  });

  it.each([
    [runsRoute, { total_count: 2, workflow_runs: [localRun] }],
    [runsRoute, { total_count: 2, workflow_runs: [localRun, localRun] }],
    [checkRoute, { total_count: 2, check_runs: [publication] }],
  ])("refuses incomplete or repeated source inventory at %s", (route, response) => {
    const h = harness();
    h.responses.set(route, response);
    expect(h.read).toThrow("SCENARIO_COMPLETION_INVENTORY_INVALID");
  });

  it("refuses two same-name Actions publications instead of choosing one", () => {
    const h = harness();
    h.responses.set(checkRoute, { total_count: 2, check_runs: [publication, { ...publication, id: 401 }] });
    expect(h.read).toThrow("SCENARIO_COMPLETION_CHECKS_AMBIGUOUS");
  });

  it("does not follow a foreign app or malformed publication pointer", () => {
    const h = harness();
    h.responses.set(checkRoute, { total_count: 1, check_runs: [{ ...publication, app: { slug: "other-app" } }] });
    expect(h.read()).toMatchObject({ publication: null, producerRun: null });
    h.responses.set(checkRoute, { total_count: 1, check_runs: [{ ...publication, external_id: "g5:825:300/other:2" }] });
    expect(h.read().producerRun).toBeNull();
    expect(h.api.mock.calls.map(([route]) => route)).not.toContain("/actions/runs/300");
  });

  it("propagates unavailable source reads so a snapshot cannot compare as current", () => {
    const h = harness();
    h.read();
    h.api.mockImplementationOnce(() => { throw new Error("SOURCE_UNAVAILABLE"); });
    expect(h.read).toThrow("SOURCE_UNAVAILABLE");
  });
});
