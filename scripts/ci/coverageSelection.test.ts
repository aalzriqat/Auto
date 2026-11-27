/**
 * SCRUM-1025: the coverage runner accepts a selected subset of the test census
 * (AUTOFLOW_COVERAGE_SELECTION) and a list of merge reporters
 * (AUTOFLOW_COVERAGE_MERGE_REPORTERS). Both fail closed on anything unexpected,
 * before any test subprocess starts. The runner is imported in-process with its
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
  "AUTOFLOW_COVERAGE_SELECTION",
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

function selectionFile(content: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "autoflow-selection-file-"));
  SCRATCH.push(directory);
  const file = path.join(directory, "selection.json");
  writeFileSync(file, content);
  return file;
}

const testedFiles = () =>
  childBoundary.calls
    .map(rawArgs)
    .filter((args) => args.includes("--coverage") && !args.some((arg) => arg.startsWith("--merge-reports=")))
    .flatMap((args) => args.filter((arg) => /^lib\/f\d+\.test\.ts$/.test(arg)))
    .sort();

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

describe("selected census", () => {
  test("an impacted selection runs exactly the selected files of the census", async () => {
    const selection = selectionFile(JSON.stringify({ mode: "impacted", files: ["lib/f02.test.ts", "lib/f05.test.ts"] }));
    await run({
      VITEST_COVERAGE_BATCH_SIZE: "2",
      AUTOFLOW_COVERAGE_DISCOVERY_ROOT: censusRoot(6),
      AUTOFLOW_COVERAGE_SELECTION: selection,
    });
    expect(testedFiles()).toEqual(["lib/f02.test.ts", "lib/f05.test.ts"]);
  });

  test("without a selection the whole census runs", async () => {
    await run({ VITEST_COVERAGE_BATCH_SIZE: "2", AUTOFLOW_COVERAGE_DISCOVERY_ROOT: censusRoot(3) });
    expect(testedFiles()).toEqual(["lib/f01.test.ts", "lib/f02.test.ts", "lib/f03.test.ts"]);
  });

  test.each([
    ["an empty file list", JSON.stringify({ mode: "impacted", files: [] }), /at least one file/],
    ["a selection that is not impacted", JSON.stringify({ mode: "full", files: ["lib/f01.test.ts"] }), /impacted selection/],
    ["files that are not an array", JSON.stringify({ mode: "impacted", files: "lib/f01.test.ts" }), /impacted selection/],
    [
      "a file outside the census",
      JSON.stringify({ mode: "impacted", files: ["lib/f01.test.ts", "lib/ghost.test.ts"] }),
      /outside the test census: lib\/ghost\.test\.ts/,
    ],
    ["malformed JSON", "{not json", /JSON/],
  ])("refuses %s before any subprocess", async (_label, content, message) => {
    await expect(
      run({ AUTOFLOW_COVERAGE_DISCOVERY_ROOT: censusRoot(3), AUTOFLOW_COVERAGE_SELECTION: selectionFile(content) }),
    ).rejects.toThrow(message);
    expect(childBoundary.calls).toHaveLength(0);
  });
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
