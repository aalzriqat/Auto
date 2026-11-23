// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const candidate = {
  repositoryId: 12, prNumber: 825,
  baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40),
  workflowRunId: 200, workflowAttempt: 2,
};
const checkName = "pr-scenario-runner";
const externalId = `scenario:825:${candidate.testedSha}`;
const checkRoute = `/commits/${candidate.testedSha}/check-runs?check_name=${checkName}&filter=all&per_page=100`;
const detailsUrl = "https://github.com/aalzriqat/Auto/actions/runs/300";
const now = () => new Date("2026-11-22T08:00:00Z");
const load = () => import("./scenarioCompletionCheck.mjs");

function harness(initial: Record<string, unknown>[] = [], hostedLinks = false) {
  const records = new Map(initial.map(record => [Number(record.id), structuredClone(record)]));
  const response = (record: Record<string, unknown>) => {
    if (!hostedLinks) return record;
    const checkUrl = `https://github.com/aalzriqat/Auto/runs/${record.id}`;
    return { ...record, details_url: checkUrl, html_url: checkUrl };
  };
  const api = vi.fn(async (method: string, route: string, body?: Record<string, unknown>) => {
    if (method === "GET" && route === checkRoute) {
      return { total_count: records.size, check_runs: structuredClone([...records.values()]) };
    }
    if (method === "POST" && route === "/check-runs" && body) {
      const record = { id: Math.max(899, ...records.keys()) + 1, app: { slug: "github-actions" }, ...structuredClone(body) };
      const stored = response(record);
      records.set(record.id, stored);
      return structuredClone(stored);
    }
    const previous = records.get(Number(route.replace("/check-runs/", "")));
    if (method === "PATCH" && previous && body) {
      const record = response({ ...previous, ...structuredClone(body) });
      records.set(Number(previous.id), record);
      return structuredClone(record);
    }
    throw new Error("Unexpected GitHub API request.");
  });
  const snapshot = vi.fn(async () => undefined);
  return { api, records, snapshot };
}

function existing(change: Record<string, unknown> = {}) {
  return {
    id: 900, name: checkName, head_sha: candidate.testedSha,
    app: { slug: "github-actions" }, external_id: externalId,
    status: "completed", conclusion: "success", ...change,
  };
}

const writes = (h: ReturnType<typeof harness>) => h.api.mock.calls.filter(([method]) => method !== "GET");

describe("scenario completion required check publisher", () => {
  it("creates one blocking required check on the tested merge before evidence exists", async () => {
    const h = harness();
    const { publishScenarioCompletion } = await load();
    await expect(publishScenarioCompletion({
      ...h, candidate, verdict: { kind: "pending", code: "WAITING_FOR_PRODUCERS" }, detailsUrl, now,
    })).resolves.toMatchObject({ outcome: "written" });
    expect([...h.records.values()]).toEqual([expect.objectContaining({
      name: checkName, head_sha: candidate.testedSha, external_id: externalId,
      status: "completed", conclusion: "failure",
      output: expect.objectContaining({ title: "Awaiting scenario evidence" }),
    })]);
    expect(h.snapshot).toHaveBeenCalledOnce();
  });

  it("validates GitHub Actions' canonical check URL on creation and update", async () => {
    const h = harness([], true);
    const { publishScenarioCompletion } = await load();
    const input = { ...h, candidate, detailsUrl, now };
    await expect(publishScenarioCompletion({ ...input, verdict: { kind: "pending" } }))
      .resolves.toMatchObject({ outcome: "written", record: { id: 900, conclusion: "failure" } });
    await expect(publishScenarioCompletion({ ...input, verdict: { kind: "pending" } }))
      .resolves.toMatchObject({ outcome: "unchanged", record: { id: 900 } });
    await expect(publishScenarioCompletion({ ...input, verdict: { kind: "success", counts: { selected: 3, passed: 3 } } }))
      .resolves.toMatchObject({ outcome: "written", record: { id: 900, conclusion: "success",
        output: { text: expect.stringContaining(detailsUrl) } } });
    expect(writes(h).map(([method, route]) => [method, route])).toEqual([
      ["POST", "/check-runs"], ["PATCH", "/check-runs/900"],
    ]);
  });

  it("uses a generic fixed failure for unknown codes and never publishes source text", async () => {
    const h = harness();
    const { publishScenarioCompletion } = await load();
    await publishScenarioCompletion({
      ...h, candidate, detailsUrl, now,
      verdict: { kind: "failure", code: "private-tenant-token", reason: "private-tenant-token", summary: "private-tenant-token", counts: { selected: 3, passed: 2 } },
    });
    const output = JSON.stringify(h.records.get(900)?.output);
    expect(output).toContain("SCENARIO_CERTIFICATION_UNAVAILABLE");
    expect(output).toContain("Selected scenarios: 3. Passed scenarios: 2.");
    expect(output).not.toContain("private-tenant-token");
  });

  it("revokes previous success with pending PATCH and only restores success after explicit aggregation", async () => {
    const h = harness([existing()]);
    const { publishScenarioCompletion } = await load();
    const rerun = { ...candidate, workflowAttempt: 3 };
    await publishScenarioCompletion({ ...h, candidate: rerun, verdict: { kind: "pending", code: "BROWSER_EVIDENCE_PENDING" }, detailsUrl, now });
    expect(h.records.get(900)).toMatchObject({
      external_id: externalId, head_sha: candidate.testedSha, conclusion: "failure",
      output: { title: "Awaiting scenario evidence" },
    });
    await publishScenarioCompletion({ ...h, candidate: rerun, verdict: { kind: "success", counts: { selected: 3, passed: 3 } }, detailsUrl, now });
    expect(h.records.get(900)).toMatchObject({ conclusion: "success", output: { title: "Scenario evidence verified" } });
    expect(h.records.size).toBe(1);
    expect(writes(h).map(([method, route]) => [method, route])).toEqual([["PATCH", "/check-runs/900"], ["PATCH", "/check-runs/900"]]);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
  });

  it("rechecks an identical callback without creating or changing its check", async () => {
    const h = harness();
    const { publishScenarioCompletion } = await load();
    const input = { ...h, candidate, verdict: { kind: "success", counts: { selected: 3, passed: 3 } }, detailsUrl, now };
    await publishScenarioCompletion(input);
    const before = structuredClone([...h.records.values()]);
    await expect(publishScenarioCompletion(input)).resolves.toMatchObject({ outcome: "unchanged" });
    expect([...h.records.values()]).toEqual(before);
    expect(writes(h)).toHaveLength(1);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
    h.snapshot.mockRejectedValueOnce(new Error("STALE_SOURCE"));
    await expect(publishScenarioCompletion(input)).rejects.toThrow("STALE_SOURCE");
    expect(writes(h)).toHaveLength(1);
  });

  it("uses an existing check only as a destination and replaces writable foreign metadata", async () => {
    const h = harness([existing({ external_id: "foreign-pointer", output: { title: "private-tenant-token" } })]);
    const { publishScenarioCompletion } = await load();
    await publishScenarioCompletion({ ...h, candidate, verdict: { kind: "pending" }, detailsUrl, now });
    expect(h.records.get(900)).toMatchObject({ external_id: externalId, conclusion: "failure" });
    expect(JSON.stringify(h.records.get(900))).not.toContain("private-tenant-token");
    expect(writes(h)[0]?.slice(0, 2)).toEqual(["PATCH", "/check-runs/900"]);
  });

  it("can block an admission before any local producer exists", async () => {
    const h = harness();
    const { publishScenarioCompletion } = await load();
    const admission = { ...candidate, workflowRunId: undefined, workflowAttempt: undefined };
    await publishScenarioCompletion({ ...h, candidate: admission, verdict: { kind: "pending" }, detailsUrl, now });
    expect(h.records.get(900)).toMatchObject({ external_id: externalId, conclusion: "failure" });
    await expect(publishScenarioCompletion({ ...h, candidate: admission, verdict: { kind: "success" }, detailsUrl, now })).rejects.toThrow("SCENARIO_COMPLETION_PUBLICATION_INVALID");
    expect(writes(h)).toHaveLength(1);
  });

  it("refuses ambiguous same-name GitHub Actions checks without creating or updating one", async () => {
    const h = harness([existing(), existing({ id: 901 })]);
    const { publishScenarioCompletion } = await load();
    await expect(publishScenarioCompletion({ ...h, candidate, verdict: { kind: "success" }, detailsUrl, now })).rejects.toThrow("SCENARIO_COMPLETION_CHECKS_AMBIGUOUS");
    expect(writes(h)).toEqual([]);
  });

  it.each([
    ["producer app", { app: { slug: "another-app" } }, "SCENARIO_COMPLETION_PRODUCER_INVALID"],
    ["commit", { head_sha: candidate.headSha }, "SCENARIO_COMPLETION_INVENTORY_INVALID"],
    ["check name", { name: "unrelated-check" }, "SCENARIO_COMPLETION_INVENTORY_INVALID"],
    ["check id", { id: "900/other" }, "SCENARIO_COMPLETION_INVENTORY_INVALID"],
  ])("refuses a destination with the wrong %s", async (_label, change, error) => {
    const h = harness([existing(change)]);
    const { publishScenarioCompletion } = await load();
    await expect(publishScenarioCompletion({ ...h, candidate, verdict: { kind: "success" }, detailsUrl, now })).rejects.toThrow(error);
    expect(writes(h)).toEqual([]);
  });

  it.each([
    ["absent count", { check_runs: [] }],
    ["incomplete page", { total_count: 2, check_runs: [existing()] }],
    ["extra records", { total_count: 0, check_runs: [existing()] }],
    ["duplicate id", { total_count: 2, check_runs: [existing(), existing()] }],
    ["saturated inventory", { total_count: 101, check_runs: [] }],
  ])("requires a complete check inventory: %s", async (_label, inventory) => {
    const h = harness();
    h.api.mockResolvedValueOnce(inventory);
    const { publishScenarioCompletion } = await load();
    await expect(publishScenarioCompletion({ ...h, candidate, verdict: { kind: "success" }, detailsUrl, now })).rejects.toThrow("SCENARIO_COMPLETION_INVENTORY_INVALID");
    expect(writes(h)).toEqual([]);
  });

  it("rechecks source freshness after reading the destination and before mutation", async () => {
    const h = harness();
    const order: string[] = [];
    const api = async (method: string, route: string, body?: Record<string, unknown>) => {
      order.push(method);
      return h.api(method, route, body);
    };
    const snapshot = async () => { order.push("snapshot"); throw new Error("STALE_SOURCE"); };
    const { publishScenarioCompletion } = await load();
    await expect(publishScenarioCompletion({ api, snapshot, candidate, verdict: { kind: "success" }, detailsUrl, now })).rejects.toThrow("STALE_SOURCE");
    expect(order).toEqual(["GET", "snapshot"]);
    expect(writes(h)).toEqual([]);
  });

  it("does not publish when its source API cannot be read", async () => {
    const h = harness();
    h.api.mockRejectedValueOnce(new Error("SOURCE_UNAVAILABLE"));
    const { publishScenarioCompletion } = await load();
    await expect(publishScenarioCompletion({ ...h, candidate, verdict: { kind: "success" }, detailsUrl, now })).rejects.toThrow("SOURCE_UNAVAILABLE");
    expect(writes(h)).toEqual([]);
  });

  it.each(["POST", "PATCH"])("keeps a lost %s response UNKNOWN without a second mutation", async (lostMethod) => {
    const h = harness(lostMethod === "PATCH" ? [existing()] : []);
    const api = async (method: string, route: string, body?: Record<string, unknown>) => {
      const result = await h.api(method, route, body);
      if (method === lostMethod) throw new Error("private-tenant-token");
      return result;
    };
    const { publishScenarioCompletion } = await load();
    const input = { ...h, api, candidate, verdict: { kind: "pending" }, detailsUrl, now };
    await expect(publishScenarioCompletion(input)).rejects.toThrow("SCENARIO_COMPLETION_PUBLICATION_UNKNOWN");
    expect(h.records.size).toBe(1);
    expect(writes(h)).toHaveLength(1);
    // A separately delivered callback can reconcile the persisted destination.
    await expect(publishScenarioCompletion(input)).resolves.toMatchObject({ outcome: "unchanged" });
    expect(writes(h)).toHaveLength(1);
  });

  it.each([
    { app: { slug: "another-app" } }, { head_sha: candidate.headSha },
    { name: "unrelated-check" }, { external_id: "foreign-pointer" },
    { conclusion: "success" }, { id: 0 },
    { details_url: "https://github.com/other/Auto/runs/900", html_url: "https://github.com/other/Auto/runs/900" },
    { details_url: "https://github.com/aalzriqat/Auto/runs/901", html_url: "https://github.com/aalzriqat/Auto/runs/901" },
    { details_url: "https://github.com/aalzriqat/Auto/runs/900", html_url: "https://github.com/aalzriqat/Auto/runs/901" },
  ])("keeps an inconsistent write acknowledgement UNKNOWN: %j", async change => {
    const h = harness();
    const api = async (method: string, route: string, body?: Record<string, unknown>) => {
      const result = await h.api(method, route, body);
      return method === "POST" ? { ...result, ...change } : result;
    };
    const { publishScenarioCompletion } = await load();
    await expect(publishScenarioCompletion({ ...h, api, candidate, verdict: { kind: "pending" }, detailsUrl, now })).rejects.toThrow("SCENARIO_COMPLETION_PUBLICATION_UNKNOWN");
    expect(writes(h)).toHaveLength(1);
  });

  it.each([
    { selected: -1, passed: 0 }, { selected: 1_000_001, passed: 0 },
    { selected: 1.5, passed: 1 }, { selected: 3, passed: 4 }, { selected: 3, passed: 2 },
  ])("refuses invalid or incomplete successful counts: %j", async counts => {
    const h = harness();
    const { publishScenarioCompletion } = await load();
    await expect(publishScenarioCompletion({ ...h, candidate, verdict: { kind: "success", counts }, detailsUrl, now })).rejects.toThrow("SCENARIO_COMPLETION_PUBLICATION_INVALID");
    expect(writes(h)).toEqual([]);
  });

  it("does not expose arbitrary URLs in the public check", async () => {
    const h = harness();
    const { publishScenarioCompletion } = await load();
    await expect(publishScenarioCompletion({ ...h, candidate, verdict: { kind: "pending" }, detailsUrl: `${detailsUrl}?token=private-tenant-token`, now })).rejects.toThrow("SCENARIO_COMPLETION_PUBLICATION_INVALID");
    expect(writes(h)).toEqual([]);
  });
});
