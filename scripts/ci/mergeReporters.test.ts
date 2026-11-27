/**
 * SCRUM-1025: the coverage runner accepts a list of merge reporters
 * (AUTOFLOW_COVERAGE_MERGE_REPORTERS) and refuses an unknown name before any
 * test subprocess starts. The runner is imported in-process with its
 * child processes replaced, as in scripts/runVitestCoverageShards.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const childBoundary = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const interceptedSpawnSync = (_file: string, args: readonly string[]) => {
    childBoundary.calls.push({ args: [...args] });
    return { status: 0, signal: null };
  };
  const interceptedSpawn = (_file: string, args: readonly string[]) => {
    childBoundary.calls.push({ args: [...args] });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setTimeout(() => child.emit("close", 0, null), 1);
    return child;
  };
  return {
    ...actual,
    default: { ...actual, spawn: interceptedSpawn, spawnSync: interceptedSpawnSync },
    spawn: interceptedSpawn,
    spawnSync: interceptedSpawnSync,
  };
});

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_ENV = { ...process.env };
const BLOB_DIR = ".vitest-reports-selection-test";
const REPORTS_DIR = ".coverage-selection-test";
const SCRATCH: string[] = [];
const KEYS = [
  "VITEST_COVERAGE_BATCH_SIZE",
  "AUTOFLOW_COVERAGE_WORKLOAD",
  "AUTOFLOW_COVERAGE_DISCOVERY_ROOT",
  "AUTOFLOW_COVERAGE_PHASE",
  "AUTOFLOW_COVERAGE_SLICE",
  "AUTOFLOW_COVERAGE_MERGE_REPORTERS",
];

const rawArgs = (call: { args: string[] }) => call.args.slice(1);
const isMerge = (call: { args: string[] }) => rawArgs(call).some((arg) => arg.startsWith("--merge-reports="));

async function run(env: Record<string, string>) {
  for (const key of KEYS) delete process.env[key];
  process.env.AUTOFLOW_COVERAGE_BLOB_DIR = BLOB_DIR;
  process.env.AUTOFLOW_COVERAGE_REPORTS_DIR = REPORTS_DIR;
  Object.assign(process.env, env);
  process.argv = ["node", "scripts/runVitestCoverageShards.mjs", "unit"];
  vi.resetModules();
  return await import("../runVitestCoverageShards.mjs");
}

function censusRoot(count: number, dir = "lib"): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "autoflow-coverage-selection-"));
  SCRATCH.push(directory);
  mkdirSync(path.join(directory, dir));
  for (let index = 1; index <= count; index += 1) {
    writeFileSync(path.join(directory, dir, `f${String(index).padStart(2, "0")}.test.ts`), "");
  }
  return directory;
}

beforeEach(() => {
  childBoundary.calls.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
});

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  rmSync(path.join(process.cwd(), BLOB_DIR), { recursive: true, force: true });
  rmSync(path.join(process.cwd(), REPORTS_DIR), { recursive: true, force: true });
  for (const directory of SCRATCH.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("merge reporters", () => {
  const reportersOf = () =>
    childBoundary.calls.filter(isMerge).map(rawArgs)[0].filter((arg) => arg.startsWith("--coverage.reporter="));

  test("the merge passes exactly the named reporters, and none when unset", async () => {
    const env = {
      VITEST_COVERAGE_BATCH_SIZE: "2",
      AUTOFLOW_COVERAGE_DISCOVERY_ROOT: censusRoot(3, "convex"),
      AUTOFLOW_COVERAGE_PHASE: "merge",
    };
    const blobDir = path.join(process.cwd(), BLOB_DIR);
    mkdirSync(blobDir, { recursive: true });
    for (const name of ["unified-deal-authority.json", "unit-batch-1.json", "unit-batch-2.json"]) {
      writeFileSync(path.join(blobDir, name), "{}");
    }

    await run({ ...env, AUTOFLOW_COVERAGE_MERGE_REPORTERS: " lcov, json-summary ,,text-summary" });
    expect(reportersOf()).toEqual([
      "--coverage.reporter=lcov",
      "--coverage.reporter=json-summary",
      "--coverage.reporter=text-summary",
    ]);

    childBoundary.calls.length = 0;
    await run(env);
    expect(reportersOf()).toEqual([]);
  });

  test("an unknown reporter is refused before any subprocess", async () => {
    await expect(
      run({ AUTOFLOW_COVERAGE_DISCOVERY_ROOT: censusRoot(3), AUTOFLOW_COVERAGE_MERGE_REPORTERS: "lcov,evil" }),
    ).rejects.toThrow(/unknown reporters: evil/);
    expect(childBoundary.calls).toHaveLength(0);
  });
});
