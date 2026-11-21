// @vitest-environment node
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { EXPLORER_SPEC } from "./intelligence/trustedBrowserReplayPolicy.mjs";
import { explorerShardPlan, measureExplorerShard, summarizeExplorerBenchmark } from "./explorerShardBenchmark.mjs";
import { loadRecords } from "./regression/prRunner.mjs";

const checkout = process.cwd();
const library = loadRecords(checkout);
const identity = { revision: "a".repeat(40), runId: 76, attempt: 1 };

function makeReceipts(shardCount: number) {
  const plan = explorerShardPlan(library.records, shardCount);
  return { plan, receipts: plan.map((records, index) => ({
    ...identity,
    shard: index + 1,
    shardCount,
    startedAt: 1000 + index * 10,
    playwrightStartedAt: 1100,
    playwrightEndedAt: 1300,
    endedAt: 1500 + index * 100,
    authMs: 30,
    journeys: records.map(({ id }) => ({ id, durationMs: 40 })),
  })) };
}

test.each([4, 6])("accounts for every pilot journey across %i shards and reports the observed shard window", (count) => {
  expect(library.problems).toEqual([]);
  const { plan, receipts } = makeReceipts(count);
  const summary = summarizeExplorerBenchmark(plan, identity, receipts);
  const ids = summary.shards.flatMap((row) => row.journeys.map((journey) => journey.id));
  expect(new Set(ids).size).toBe(12);
  expect(summary.shards.map((row) => row.journeys.length)).toEqual(Array.from({ length: count }, () => 12 / count));
  expect(summary.elapsedShardWindowMs).toBe(500 + (count - 1) * 100);
  expect(summary.slowestShardMs).toBe(500 + (count - 1) * 90);
});

test.each([
  { title: "missing shard", damage: (rows: ReturnType<typeof makeReceipts>["receipts"]) => { rows.pop(); } },
  { title: "duplicate shard", damage: (rows: ReturnType<typeof makeReceipts>["receipts"]) => { rows[1] = rows[0]; } },
  { title: "different revision", damage: (rows: ReturnType<typeof makeReceipts>["receipts"]) => { rows[1].revision = "b".repeat(40); } },
  { title: "different attempt", damage: (rows: ReturnType<typeof makeReceipts>["receipts"]) => { rows[1].attempt = 2; } },
  { title: "different run", damage: (rows: ReturnType<typeof makeReceipts>["receipts"]) => { rows[1].runId = 41; } },
  { title: "duplicated journey", damage: (rows: ReturnType<typeof makeReceipts>["receipts"]) => { rows[1].journeys[0] = rows[1].journeys[1]; } },
  { title: "invalid duration", damage: (rows: ReturnType<typeof makeReceipts>["receipts"]) => { rows[1].journeys[0].durationMs = 0; } },
])("refuses a $title in a hosted sample", ({ damage }) => {
  const { plan, receipts } = makeReceipts(4);
  damage(receipts);
  expect(() => summarizeExplorerBenchmark(plan, identity, receipts)).toThrow(/benchmark shard evidence/i);
});

function makePlaywrightEvidence() {
  const records = explorerShardPlan(library.records, 6)[0];
  const config = {
    version: "1.61.1",
    configFile: resolve(checkout, "playwright.scenarios.config.ts"),
    rootDir: resolve(checkout, "playwright/scenarios"),
    argv: ["test", "--retries=0"],
    projects: [
      { id: "setup", name: "setup", testDir: resolve(checkout, "playwright/tests"), retries: 0, repeatEach: 1 },
      { id: "chromium", name: "chromium", testDir: resolve(checkout, "playwright/scenarios"), retries: 0, repeatEach: 1 },
    ],
  };
  const spec = (title: string, file: string, projectName: string, index: number) => ({
    title, file, id: `spec-${projectName}-${index}`,
    tests: [{
      projectId: projectName, projectName, status: "expected", expectedStatus: "passed",
      results: [{ status: "passed", retry: 0, duration: 50 }],
    }],
  });
  const results = {
    config, errors: [],
    suites: [
      { title: "../tests/auth.setup.ts", specs: [
        spec("authenticate", "../tests/auth.setup.ts", "setup", 1),
        spec("authenticate the approver", "../tests/auth.setup.ts", "setup", 2),
      ] },
      { title: "jev-explorer.spec.ts", specs: records.map(({ impl }, index) =>
        spec(impl.testName, EXPLORER_SPEC.split("/").at(-1)!, "chromium", index)) },
    ],
    stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 0 },
  };
  const discovery = structuredClone(results);
  for (const suite of discovery.suites) for (const definition of suite.specs) {
    definition.tests[0].status = "skipped";
    definition.tests[0].results = [];
  }
  return { records, discovery, results };
}

test("counts both auth setup results separately from the Explorer bindings", () => {
  const { records, discovery, results } = makePlaywrightEvidence();
  expect(measureExplorerShard(records, { checkout, discovery, results })).toEqual({
    authMs: 100, journeys: records.map(({ id }) => ({ id, durationMs: 50 })),
  });
});

test.each([
  { cause: "approver setup skipped", suite: 0, index: 1, state: "skipped" },
  { cause: "journey failed", suite: 1, index: 0, state: "unexpected" },
  { cause: "journey retried", suite: 1, index: 0, state: "flaky" },
])("refuses benchmark evidence with $cause", ({ suite, index, state }) => {
  const { records, discovery, results } = makePlaywrightEvidence();
  results.suites[suite].specs[index].tests[0].status = state;
  expect(() => measureExplorerShard(records, { checkout, discovery, results })).toThrow(/did not pass|did not.*checks/);
});
