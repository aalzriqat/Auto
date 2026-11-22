import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareCodeUnits } from "./contractSkew/compareCodeUnits.mjs";
import { EXPLORER_SPEC } from "./intelligence/trustedBrowserReplayPolicy.mjs";
import { evaluateTrustedBrowserReplays, loadRecords } from "./regression/prRunner.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pilotTitle = /^pilot explorer (deals|sales|accounting) (en|ar) (desktop|phone)$/u;
const setupFile = "playwright/tests/auth.setup.ts";
const setupTitles = ["authenticate", "authenticate the approver"];
const reportLimitBytes = 16 * 1024 * 1024;

/** @returns {never} */
function fail(message) {
  throw new Error(message);
}

function integer(value) {
  if (!/^[1-9]\d*$/u.test(value ?? "") || !Number.isSafeInteger(Number(value))) {
    fail("Invalid benchmark identity or timing.");
  }
  return Number(value);
}

function sorted(values) {
  return [...values].sort(compareCodeUnits);
}

function sameInventory(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

export function explorerShardPlan(records, shardCount) {
  if (shardCount !== 4 && shardCount !== 6) fail("Expected four or six benchmark shards.");

  const explorer = records.filter((record) => record.status === "active" && record.level === "browser" &&
    record.domain === "screen" && record.impl?.file === EXPLORER_SPEC);
  if (explorer.length !== 12 || new Set(explorer.map((record) => record.id)).size !== 12 ||
    new Set(explorer.map((record) => record.impl.testName)).size !== 12 ||
    explorer.some((record) => !pilotTitle.test(record.impl.testName))) {
    fail("The benchmark requires all twelve pilot Explorer bindings.");
  }

  const routeOrder = ["deals", "sales", "accounting"];
  const titles = routeOrder.flatMap((route) => ["en", "ar"].flatMap((locale) =>
    ["desktop", "phone"].map((device) => `pilot explorer ${route} ${locale} ${device}`)));
  const bindings = new Map(explorer.map((record) => [record.impl.testName, record]));
  return Array.from({ length: shardCount }, (_, index) =>
    titles.filter((_, position) => position % shardCount === index).map((title) => bindings.get(title)));
}

function casesInReport(report, checkout) {
  if (!Array.isArray(report?.suites) || !Array.isArray(report.errors) || report.errors.length ||
    typeof report.config?.rootDir !== "string") {
    fail("Benchmark report is missing valid Playwright evidence.");
  }
  function visit(suite) {
    const specs = (suite.specs ?? []).flatMap((spec) => {
      const file = relative(checkout, resolve(report.config.rootDir, spec.file)).replaceAll("\\", "/");
      if (typeof spec.id !== "string" || !spec.id || typeof spec.title !== "string" ||
        !Array.isArray(spec.tests) || !spec.tests.length) {
        fail("Benchmark report contains an invalid test definition.");
      }
      return spec.tests.map((test) => ({ file, id: spec.id, title: spec.title, test }));
    });
    return specs.concat((suite.suites ?? []).flatMap(visit));
  }
  return report.suites.flatMap(visit);
}

function identityOf(row) {
  return JSON.stringify([row.file, row.id, row.title, row.test.projectName]);
}

function titleOf(row) {
  return JSON.stringify([row.file, row.title, row.test.projectName]);
}

function durationOf(test) {
  const result = test.results?.[0];
  if (test.expectedStatus !== "passed" || test.status !== "expected" ||
    test.results?.length !== 1 || result?.retry !== 0 || result.status !== "passed" ||
    !Number.isFinite(result.duration) || result.duration <= 0) {
    fail("Benchmark execution did not pass exactly once.");
  }
  return result.duration;
}

export function measureExplorerShard(records, { discovery, results, checkout }) {
  const discovered = casesInReport(discovery, checkout);
  const executed = casesInReport(results, checkout);
  const expected = [
    ...setupTitles.map((title) => JSON.stringify([setupFile, title, "setup"])),
    ...records.map((record) => JSON.stringify([EXPLORER_SPEC, record.impl.testName, "chromium"])),
  ];
  if (!sameInventory(discovered.map(titleOf), expected) ||
    !sameInventory(executed.map(identityOf), discovered.map(identityOf))) {
    fail("Benchmark discovery or execution differs from the assigned test inventory.");
  }
  if (results.stats?.expected !== expected.length || results.stats.skipped !== 0 ||
    results.stats.unexpected !== 0 || results.stats.flaky !== 0) {
    fail("Benchmark execution totals do not prove a complete successful shard.");
  }
  const verdicts = evaluateTrustedBrowserReplays(records, { report: results, discovery, root: checkout, configName: "scenarios" });
  if (verdicts.length !== records.length || verdicts.some((entry) => entry.code !== "PASS")) {
    fail("Benchmark browser bindings did not pass the existing discovery and execution checks.");
  }
  const timings = new Map(executed.map((row) => [titleOf(row), durationOf(row.test)]));
  return {
    authMs: setupTitles.reduce((total, title) => total + timings.get(JSON.stringify([setupFile, title, "setup"])), 0),
    journeys: records.map(({ id, impl }) => ({
      id,
      durationMs: timings.get(JSON.stringify([EXPLORER_SPEC, impl.testName, "chromium"])),
    })),
  };
}

/**
 * @param {{id: string}[][]} plan
 * @param {{revision: string, runId: number, attempt: number}} identity
 * @param {{
 *   revision: string, runId: number, attempt: number, shard: number, shardCount: number,
 *   startedAt: number, playwrightStartedAt: number, playwrightEndedAt: number, endedAt: number,
 *   authMs: number, journeys: {id: string, durationMs: number}[]
 * }[]} receipts
 */
export function summarizeExplorerBenchmark(plan, identity, receipts) {
  if (receipts.length !== plan.length) fail("Benchmark shard evidence is incomplete.");
  const byShard = new Map(receipts.map((row) => [row.shard, row]));
  const shards = plan.map((records, index) => {
    const row = byShard.get(index + 1);
    if (row?.revision !== identity.revision || row.runId !== identity.runId ||
      row.attempt !== identity.attempt || row.shardCount !== plan.length ||
      !Array.isArray(row.journeys) || !sameInventory(row.journeys.map(({ id }) => id), records.map(({ id }) => id))) {
      fail("Benchmark shard evidence has the wrong identity or inventory.");
    }
    const timestamps = [row.startedAt, row.playwrightStartedAt, row.playwrightEndedAt, row.endedAt];
    if (!timestamps.every((value) => Number.isSafeInteger(value) && value > 0) ||
      row.startedAt > row.playwrightStartedAt || row.playwrightStartedAt >= row.playwrightEndedAt ||
      row.playwrightEndedAt > row.endedAt || !Number.isFinite(row.authMs) || row.authMs <= 0 ||
      row.journeys.some((journey) => !Number.isFinite(journey.durationMs) || journey.durationMs <= 0)) {
      fail("Benchmark shard evidence has invalid timing.");
    }
    const playwrightMs = row.playwrightEndedAt - row.playwrightStartedAt;
    const explorerExecutionMs = row.journeys.reduce((total, journey) => total + journey.durationMs, 0);
    if (row.authMs + explorerExecutionMs > playwrightMs) fail("Benchmark shard timings exceed the one-worker window.");
    return {
      shard: row.shard,
      setupMs: row.playwrightStartedAt - row.startedAt,
      authMs: row.authMs,
      explorerExecutionMs,
      playwrightMs,
      verificationMs: row.endedAt - row.playwrightEndedAt,
      durationMs: row.endedAt - row.startedAt,
      journeys: row.journeys.map(({ id, durationMs }) => ({ id, durationMs })),
    };
  });
  return {
    ...identity,
    shardCount: shards.length,
    scope: "authenticated Explorer timing only",
    elapsedShardWindowMs: Math.max(...receipts.map((row) => row.endedAt)) - Math.min(...receipts.map((row) => row.startedAt)),
    slowestShardMs: Math.max(...shards.map((row) => row.durationMs)),
    shards,
  };
}

function readJson(file) {
  if (statSync(file).size > reportLimitBytes) fail("Benchmark evidence exceeds its size limit.");
  return JSON.parse(readFileSync(file, "utf8"));
}

function readReceipts(directory, identity) {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    if (!entry.isDirectory() || !/^explorer-benchmark-\d+-\d+-\d+$/u.test(entry.name)) {
      fail("Unexpected benchmark artifact directory.");
    }
    const receipt = readJson(resolve(directory, entry.name, "shard.json"));
    if (entry.name !== `explorer-benchmark-${identity.runId}-${identity.attempt}-${receipt.shard}`) {
      fail("Benchmark artifact name does not match its shard evidence.");
    }
    return receipt;
  });
}

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function runExplorerBenchmarkCommand([mode, ...files], env) {
  const library = loadRecords(root);
  if (library.problems.length) fail("The scenario library could not be read.");
  const shardCount = integer(env.EXPLORER_SHARD_COUNT);
  const plan = explorerShardPlan(library.records, shardCount);
  const revision = env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) fail("Benchmark revision is unavailable.");
  const identity = {
    revision,
    runId: integer(env.GITHUB_RUN_ID),
    attempt: integer(env.GITHUB_RUN_ATTEMPT),
  };
  if (mode === "summary" && files.length === 1) {
    return JSON.stringify(summarizeExplorerBenchmark(plan, identity, readReceipts(files[0], identity)), null, 2);
  }
  const shard = integer(env.EXPLORER_SHARD_INDEX);
  const records = plan[shard - 1];
  if (!records) fail("Benchmark shard was not assigned.");
  if (mode === "filter" && files.length === 0) {
    return `(?:${records.map(({ impl }) => impl.testName).join("|")})$`;
  }
  if (mode === "record" && files.length === 2) {
    const [discovery, results] = files.map(readJson);
    const timing = measureExplorerShard(records, { discovery, results, checkout: root });
    return JSON.stringify({
      ...identity,
      shard,
      shardCount,
      startedAt: integer(env.EXPLORER_JOB_STARTED_MS),
      playwrightStartedAt: integer(env.EXPLORER_PLAYWRIGHT_STARTED_MS),
      playwrightEndedAt: integer(env.EXPLORER_PLAYWRIGHT_ENDED_MS),
      endedAt: Date.now(),
      ...timing,
    });
  }
  fail("Unknown Explorer benchmark command.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(runExplorerBenchmarkCommand(process.argv.slice(2), process.env));
  } catch {
    console.error("Explorer benchmark evidence is incomplete or invalid.");
    process.exitCode = 1;
  }
}
