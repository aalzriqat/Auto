// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createScenarioCompletionApi } from "./scenarioCompletionTransport.mjs";

const repository = "aalzriqat/Auto";
const token = "fixture-controller-token";
const sha = "a".repeat(40);
const check = { name: "pr-scenario-runner", head_sha: sha, external_id: `scenario:825:${sha}`,
  status: "completed", conclusion: "failure", output: { title: "Awaiting scenario evidence", summary: "Fixed summary." } };

function harness() {
  const execute = vi.fn(() => JSON.stringify({ ok: true }));
  return { execute, ...createScenarioCompletionApi({ repository, token }, execute) };
}

describe("scenario completion GitHub executable boundary", () => {
  it.each([
    "/pulls/825", "/pulls?state=open&per_page=100&page=3", "/actions/runs/300",
    "/actions/workflows/scenario-runner.yml", "/actions/workflows/browser-attack-swarm.yml",
    `/actions/workflows/scenario-runner.yml/runs?event=pull_request&head_sha=${sha}&per_page=100`,
    `/commits/${sha}/check-runs?check_name=authenticated-pr-e2e&filter=all&per_page=100`,
    `/commits/${sha}/check-runs?check_name=pr-scenario-runner&filter=all&per_page=100`,
    "/git/ref/pull/825/merge", `/git/commits/${sha}`,
  ])("reads the fixed repository resource %s", route => {
    const h = harness();
    expect(h.api(route)).toEqual({ ok: true });
    expect(h.execute).toHaveBeenCalledWith("/usr/bin/gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${repository}${route}`],
      expect.objectContaining({ timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
  });

  it.each([["POST", "/check-runs"], ["PATCH", "/check-runs/900"]])("sends a %s check through JSON stdin", (method, route) => {
    const h = harness();
    expect(h.request(method, route, check)).toEqual({ ok: true });
    expect(h.execute).toHaveBeenCalledWith("/usr/bin/gh", ["api", "--hostname", "github.com", "--method", method,
      `repos/${repository}${route}`, "--input", "-"], expect.objectContaining({ input: JSON.stringify(check) }));
  });

  it("confines credentials to the child environment and does not inherit arbitrary variables", () => {
    const h = harness();
    h.request("POST", "/check-runs", check);
    expect(h.execute).toHaveBeenCalledWith(expect.any(String), expect.not.arrayContaining([token]), expect.objectContaining({
      env: { GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", HOME: process.env.HOME },
      input: expect.not.stringContaining(token),
    }));
  });

  it.each([
    ["GET", "https://example.test/steal"], ["GET", "/pulls/825?token=secret"],
    ["GET", "/pulls?state=open&per_page=100&page=4"], ["GET", "/pulls/825/../../actions/secrets"],
    ["GET", "/actions/workflows/attacker.yml"], ["POST", "/pulls/825/comments"],
    ["DELETE", "/check-runs/900"], ["PATCH", "/check-runs/0"], ["PATCH", "/check-runs/900/other"],
  ])("refuses %s %s before starting gh", (method, route) => {
    const h = harness();
    expect(() => h.request(method, route, method === "GET" ? undefined : check)).toThrow("SCENARIO_COMPLETION_ROUTE_REFUSED");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("refuses another check name and a request body on a read", () => {
    const h = harness();
    expect(() => h.request("POST", "/check-runs", { ...check, name: "authenticated-pr-e2e" })).toThrow("SCENARIO_COMPLETION_ROUTE_REFUSED");
    expect(() => h.request("GET", "/pulls/825", check)).toThrow("SCENARIO_COMPLETION_ROUTE_REFUSED");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not retry an indeterminate write or reinterpret malformed JSON", () => {
    const h = harness();
    const error = new Error("TRANSPORT_UNAVAILABLE");
    h.execute.mockImplementationOnce(() => { throw error; });
    expect(() => h.request("POST", "/check-runs", check)).toThrow(error);
    expect(h.execute).toHaveBeenCalledTimes(1);
    h.execute.mockReturnValueOnce("not-json");
    expect(() => h.api("/pulls/825")).toThrow(SyntaxError);
    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it.each(["owner/../other", "owner/..", "owner/repo?token=secret", "owner/repo/extra"])("refuses a repository path escape: %s", value => {
    const execute = vi.fn();
    expect(() => createScenarioCompletionApi({ repository: value, token }, execute)).toThrow("SCENARIO_COMPLETION_TRANSPORT_INVALID");
    expect(execute).not.toHaveBeenCalled();
  });
});
