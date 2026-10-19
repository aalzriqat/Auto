/**
 * Adversarial coverage for the coverage runner itself.
 *
 * The runner is release tooling, not test-only plumbing: it decides which tests
 * contribute V8 evidence, isolates the Unified Deal authority suite, applies
 * bounded batching/sharding, and controls where repository thresholds are
 * enforced. These tests execute the real module in-process and replace only
 * child-process/filesystem side effects so a regression cannot make Sonar green
 * by silently narrowing the census or threshold contract.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const childBoundary = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown>; async?: boolean }>,
  results: [] as Array<{ status: number | null; signal: string | null; error?: Error }>,
  // Overlap bookkeeping for asynchronous children (SCRUM-752 pool).
  active: 0,
  maxActive: 0,
  // Each async child's start, and every "a call was made while N children ran".
  events: [] as string[],
}));

// The runner's child processes are the system boundary under test. Keep the
// real module shape (including its default export), but never let this suite
// launch Vitest recursively when it imports the runner in-process.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const interceptedSpawnSync = (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    childBoundary.calls.push({ file, args: [...args], options });
    childBoundary.events.push(`sync with ${childBoundary.active} running`);
    return childBoundary.results.shift() ?? { status: 0, signal: null };
  };
  const { EventEmitter } = await import("node:events");
  const { basename } = await import("node:path");
  // An asynchronous child that finishes on a later timer tick, so children the
  // runner starts together really are alive at the same time.
  const interceptedSpawn = (file: string, args: readonly string[], options: Record<string, unknown>) => {
    childBoundary.calls.push({ file, args: [...args], options, async: true });
    const result = childBoundary.results.shift() ?? { status: 0, signal: null };
    const blob = args.find((arg) => arg.startsWith("--outputFile.blob=")) ?? "";
    childBoundary.events.push(`start ${basename(blob)}`);
    childBoundary.active += 1;
    childBoundary.maxActive = Math.max(childBoundary.maxActive, childBoundary.active);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setTimeout(() => {
      childBoundary.active -= 1;
      if (result.error) {
        child.emit("error", result.error);
        return;
      }
      child.stdout.emit("data", Buffer.from(`child output for ${basename(blob)}\n`));
      child.stderr.emit("data", Buffer.from(`child stderr for ${basename(blob)}\n`));
      child.emit("close", result.status, result.signal);
    }, 2);
    return child;
  };
  return {
    ...actual,
    default: {
      ...(actual as unknown as { default?: Record<string, unknown> }).default,
      ...actual,
      spawn: interceptedSpawn,
      spawnSync: interceptedSpawnSync,
    },
    spawn: interceptedSpawn,
    spawnSync: interceptedSpawnSync,
  };
});

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_EXIT = process.exit;
let stdout: string[];
let stderr: string[];

function rawArgs(call: (typeof childBoundary.calls)[number]): string[] {
  return call.args.slice(1);
}

function isBatchCall(call: (typeof childBoundary.calls)[number]): boolean {
  return rawArgs(call).some((arg) => arg.includes("unit-batch-"));
}

function batchTestFiles(call: (typeof childBoundary.calls)[number]): string[] {
  const args = rawArgs(call);
  const reporter = args.indexOf("--reporter=blob");
  return args.slice(1, reporter).filter((arg) => /\.test\.tsx?$/.test(arg));
}

const EXPECTED_ZERO_THRESHOLDS = [
  "--coverage.thresholds.lines=0",
  "--coverage.thresholds.functions=0",
  "--coverage.thresholds.branches=0",
  "--coverage.thresholds.statements=0",
] as const;

const EXPECTED_VITEST_INCLUDE = ["**/*.test.ts", "**/*.test.tsx"] as const;
const EXPECTED_VITEST_EXCLUDE = [
  "node_modules",
  "**/node_modules/**",
  ".next",
  "out",
  "build",
  "apps/**",
  "packages/**",
  ".claude/**",
  "**/.claude/**",
] as const;

/**
 * Independent census based on vitest.config.ts include/exclude policy.
 * This deliberately does NOT reuse the runner's collector or excludedDirs, so
 * changing the runner to skip another directory makes this assertion fail.
 */
function expectedVitestCensus(
  directory = process.cwd(),
  relative = "",
): string[] {
  const excludedByVitest = new Set([
    "node_modules",
    ".next",
    "out",
    "build",
    "apps",
    "packages",
    ".claude",
    // Repository metadata is not test source even though Vitest's glob engine
    // ignores it implicitly.
    ".git",
  ]);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludedByVitest.has(entry.name)) continue;
      files.push(
        ...expectedVitestCensus(
          path.join(directory, entry.name),
          relative ? `${relative}/${entry.name}` : entry.name,
        ),
      );
      continue;
    }
    if (!entry.isFile() || !/\.test\.tsx?$/.test(entry.name)) continue;
    files.push(relative ? `${relative}/${entry.name}` : entry.name);
  }
  return files.sort();
}

const WORKLOAD = JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "coverageWorkload.json"), "utf8")) as {
  defaultFileSeconds: number;
  isolateAtSeconds: number;
  processSeconds: { unit: number; sonar: number };
  files: Record<string, number>;
};
const isHeavy = (file: string) => (WORKLOAD.files[file] ?? WORKLOAD.defaultFileSeconds) >= WORKLOAD.isolateAtSeconds;

const TEST_BLOB_DIR = ".vitest-reports-runner-test";
const TEST_COVERAGE_DIR = ".coverage-runner-test";
const tempDiscoveryRoots: string[] = [];

async function run(mode: string, env: Record<string, string | undefined> = {}) {
  for (const key of [
    "VITEST_SONAR_BATCH_SIZE",
    "VITEST_COVERAGE_BATCH_SIZE",
    "AUTOFLOW_COVERAGE_WORKLOAD",
    "AUTOFLOW_COVERAGE_TIMINGS",
    "VITEST_COVERAGE_CONCURRENCY",
    "AUTOFLOW_COVERAGE_BLOB_DIR",
    "AUTOFLOW_COVERAGE_REPORTS_DIR",
    "AUTOFLOW_COVERAGE_DISCOVERY_ROOT",
    "AUTOFLOW_COVERAGE_PHASE",
    "AUTOFLOW_COVERAGE_SLICE",
  ]) {
    delete process.env[key];
  }
  process.env.AUTOFLOW_COVERAGE_BLOB_DIR = TEST_BLOB_DIR;
  process.env.AUTOFLOW_COVERAGE_REPORTS_DIR = TEST_COVERAGE_DIR;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  process.argv = ["node", "scripts/runVitestCoverageShards.mjs", mode];
  vi.resetModules();
  return await import("./runVitestCoverageShards.mjs");
}

beforeEach(() => {
  childBoundary.calls.length = 0;
  childBoundary.results.length = 0;
  childBoundary.active = 0;
  childBoundary.maxActive = 0;
  childBoundary.events.length = 0;
  // Regression control for c33ee35cc: without the child-process boundary,
  // importing the real runner below recursively launches this suite again and
  // CI never reaches a verdict. Probe the boundary before any test can import
  // the runner so that losing the mock fails quickly instead of hanging.
  spawnSync(process.execPath, ["--version"], { cwd: process.cwd() });
  if (childBoundary.calls.length !== 1) {
    throw new Error("Coverage runner tests must intercept child processes before importing the runner.");
  }
  childBoundary.calls.length = 0;
  childBoundary.events.length = 0;
  stdout = [];
  stderr = [];
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never;
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
  process.exit = ORIGINAL_EXIT;
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  rmSync(path.join(process.cwd(), TEST_BLOB_DIR), { recursive: true, force: true });
  rmSync(path.join(process.cwd(), TEST_COVERAGE_DIR), { recursive: true, force: true });
  for (const directory of tempDiscoveryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("runVitestCoverageShards", () => {
  test("unit mode preserves the census, isolates authority once, batches deterministically, and restores repository thresholds at merge", async () => {
    const loadedConfig = (await import("../vitest.config")).default as {
      test?: { include?: string[]; exclude?: string[] };
    };
    // Pin the independent census assumptions to the actual Vitest config. A
    // config-only scope expansion (for example removing apps/**) must fail this
    // contract instead of leaving both the runner and the test silently narrow.
    expect(loadedConfig.test?.include).toEqual([...EXPECTED_VITEST_INCLUDE]);
    expect(loadedConfig.test?.exclude).toEqual([...EXPECTED_VITEST_EXCLUDE]);

    await run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16" });

    const authority = rawArgs(childBoundary.calls[0]);
    expect(authority).toContain(
      `--coverage.reportsDirectory=${path.join(process.cwd(), TEST_COVERAGE_DIR)}`,
    );
    expect(authority).toContain("convex/unifiedDealFeeAuthority.test.ts");
    expect(authority).toContain("--coverage");
    for (const threshold of EXPECTED_ZERO_THRESHOLDS) expect(authority).toContain(threshold);

    const batches = childBoundary.calls.filter(isBatchCall);
    expect(batches.length).toBeGreaterThan(1);
    const files = batches.flatMap(batchTestFiles);
    expect(files).toContain("scripts/runVitestCoverageShards.test.ts");
    expect(files.filter((f) => f === "scripts/runVitestCoverageShards.test.ts")).toHaveLength(1);
    expect(files).not.toContain("convex/unifiedDealFeeAuthority.test.ts");
    const expected = expectedVitestCensus().filter(
      (file) => file !== "convex/unifiedDealFeeAuthority.test.ts",
    );
    // Exactly the census, each file once; isolated suites come first, the rest
    // keep their sorted order.
    expect([...files].sort()).toEqual(expected);
    expect(new Set(files).size).toBe(files.length);
    const isolated = batches.map(batchTestFiles).filter((batch) => batch.length === 1 && isHeavy(batch[0]));
    const rest = batches.map(batchTestFiles).slice(isolated.length).flat();
    expect([...rest].sort()).toEqual(rest);

    for (const batch of batches) {
      const args = rawArgs(batch);
      expect(args).toContain("--coverage");
      expect(args).toContain("--maxWorkers=1");
      expect(args).toContain("--exclude=convex/unifiedDealFeeAuthority.test.ts");
      for (const threshold of EXPECTED_ZERO_THRESHOLDS) expect(args).toContain(threshold);
    }

    const merge = rawArgs(childBoundary.calls.at(-1)!);
    expect(merge.some((arg) => arg.startsWith("--merge-reports="))).toBe(true);
    expect(merge).toContain("--coverage");
    for (const threshold of EXPECTED_ZERO_THRESHOLDS) expect(merge).not.toContain(threshold);
    expect(stdout.join("")).toContain("Coverage batch 1/");
  });

  test("sonar mode keeps the measured source scope, explicit bounded batches, isolated authority coverage, and zero local thresholds", async () => {
    await run("sonar", { VITEST_SONAR_BATCH_SIZE: "64" });

    const authority = rawArgs(childBoundary.calls[0]);
    expect(authority).toContain("convex/unifiedDealFeeAuthority.test.ts");
    expect(authority).toContain("--coverage.include=convex/**/*.ts");
    expect(authority).toContain("--coverage.include=scripts/**/*.mjs");
    expect(authority).toContain("--coverage.include=scripts/**/*.cjs");
    // proxy.ts is excluded from Sonar coverage; the trusted LCOV validator refuses SF:proxy.ts (SCRUM-784).
    expect(authority).not.toContain("--coverage.include=proxy.ts");
    for (const threshold of EXPECTED_ZERO_THRESHOLDS) expect(authority).toContain(threshold);

    const batches = childBoundary.calls.slice(1, -1).map(rawArgs);
    expect(batches.length).toBeGreaterThan(1);
    for (const args of batches) {
      expect(args.some((arg) => /--outputFile\.blob=.*sonar-\d+\.json$/.test(arg))).toBe(true);
      expect(args).not.toContain("convex");
      expect(args).not.toContain("scripts");
      expect(args.some((arg) => arg.startsWith("--shard"))).toBe(false);
      expect(args).toContain("--exclude=convex/unifiedDealFeeAuthority.test.ts");
      expect(args).toContain("--coverage.include=convex/**/*.ts");
      for (const threshold of EXPECTED_ZERO_THRESHOLDS) expect(args).toContain(threshold);
      expect(args.filter((arg) => /\.test\.tsx?$/.test(arg) && !arg.startsWith("--")).length).toBeLessThanOrEqual(64);
    }
    // The batches together are exactly the census `vitest run convex scripts`
    // selects (Vitest keeps a file whose lower-cased path contains a filter),
    // each file once, never the authority suite.
    const files = childBoundary.calls.slice(1, -1).flatMap(batchTestFiles);
    const expected = expectedVitestCensus().filter(
      (file) => file !== "convex/unifiedDealFeeAuthority.test.ts" && /convex|scripts/.test(file.toLowerCase()),
    );
    expect([...files].sort()).toEqual(expected);
    expect(new Set(files).size).toBe(files.length);

    const merge = rawArgs(childBoundary.calls.at(-1)!);
    expect(merge.some((arg) => arg.startsWith("--merge-reports="))).toBe(true);
    expect(merge).toContain("--coverage.include=convex/**/*.ts");
    for (const threshold of EXPECTED_ZERO_THRESHOLDS) expect(merge).toContain(threshold);
  });

  test("the Sonar census is exactly what the real `vitest list convex scripts` selects", async () => {
    const cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const directory = mkdtempSync(path.join(os.tmpdir(), "autoflow-sonar-list-"));
    tempDiscoveryRoots.push(directory);
    const out = path.join(directory, "list.json");
    const result = cp.spawnSync(
      process.execPath,
      [path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs"), "list", "--filesOnly", `--json=${out}`, "convex", "scripts"],
      { encoding: "utf8", timeout: 120_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const listed = (JSON.parse(readFileSync(out, "utf8")) as Array<{ file: string }>)
      .map((entry) => path.relative(process.cwd(), entry.file).split(path.sep).join("/"))
      .sort();
    const expected = expectedVitestCensus().filter((file) => /convex|scripts/.test(file.toLowerCase()));
    expect(listed.length).toBeGreaterThan(100);
    expect(listed).toEqual(expected);
  }, 180_000);

  test("every suite the workload model marks heavy runs in a process of its own, in both modes", async () => {
    await run("unit");
    const unitBatches = childBoundary.calls.filter(isBatchCall).map(batchTestFiles);
    childBoundary.calls.length = 0;
    await run("sonar");
    const sonarBatches = childBoundary.calls.slice(1, -1).map(batchTestFiles);
    const heavy = Object.keys(WORKLOAD.files).filter(isHeavy);
    expect(heavy).toContain("scripts/contractSkew/census.test.ts");
    expect(heavy).toContain("scripts/contractSkew/cliExit.test.ts");
    for (const file of heavy) {
      expect(unitBatches.filter((batch) => batch.includes(file))).toEqual([[file]]);
      if (/convex|scripts/.test(file)) expect(sonarBatches.filter((batch) => batch.includes(file))).toEqual([[file]]);
    }
  });

  test("a workload entry naming a test file that does not exist refuses before any subprocess", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autoflow-workload-"));
    tempDiscoveryRoots.push(directory);
    const stale = path.join(directory, "workload.json");
    writeFileSync(stale, JSON.stringify({ ...WORKLOAD, files: { ...WORKLOAD.files, "convex/removedSuite.test.ts": 99 } }));
    await expect(run("unit", { AUTOFLOW_COVERAGE_WORKLOAD: stale })).rejects.toThrow(
      "names test files that do not exist: convex/removedSuite.test.ts",
    );
    expect(childBoundary.calls).toHaveLength(0);
  });

  test("a census file that is a substring of another refuses, because one Vitest filter would run both", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autoflow-coverage-substring-"));
    tempDiscoveryRoots.push(directory);
    mkdirSync(path.join(directory, "lib"), { recursive: true });
    mkdirSync(path.join(directory, "x", "lib"), { recursive: true });
    writeFileSync(path.join(directory, "lib", "a.test.ts"), "");
    writeFileSync(path.join(directory, "x", "lib", "a.test.ts"), "");
    await expect(run("unit", { AUTOFLOW_COVERAGE_DISCOVERY_ROOT: directory })).rejects.toThrow(
      "Test file lib/a.test.ts is a substring of x/lib/a.test.ts",
    );
    expect(childBoundary.calls).toHaveLength(0);
  });

  test("timings telemetry records one line per Vitest process, outside the blob directory", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autoflow-timings-"));
    tempDiscoveryRoots.push(directory);
    const timings = path.join(directory, "timings.jsonl");
    await run("unit", { AUTOFLOW_COVERAGE_TIMINGS: timings, VITEST_COVERAGE_BATCH_SIZE: "16" });
    const lines = readFileSync(timings, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const tested = childBoundary.calls.filter((call) => !rawArgs(call).some((arg) => arg.startsWith("--merge-reports=")));
    expect(lines).toHaveLength(tested.length);
    expect(lines[0]).toMatchObject({ mode: "unit", unit: "unified-deal-authority.json", slice: "all", status: 0 });
    for (const line of lines) {
      expect(typeof line.wallSeconds).toBe("number");
      expect(line.files.length).toBeGreaterThan(0);
    }
  });

  test("rejects an unknown mode before touching the filesystem or spawning Vitest", async () => {
    await expect(run("mystery")).rejects.toThrow("Usage: node scripts/runVitestCoverageShards.mjs <unit|sonar>");
    expect(childBoundary.calls).toHaveLength(0);
    expect(childBoundary.calls).toHaveLength(0);
  });

  test.each(["0", "65", "2.5", "not-a-number"])(
    "rejects an invalid Sonar batch size (%s) before any subprocess",
    async (value) => {
      await expect(run("sonar", { VITEST_SONAR_BATCH_SIZE: value })).rejects.toThrow(
        "VITEST_SONAR_BATCH_SIZE must be an integer between 1 and 64."
      );
      expect(childBoundary.calls).toHaveLength(0);
    }
  );

  test("rejects an invalid unit batch size before any subprocess", async () => {
    await expect(run("unit", { VITEST_COVERAGE_BATCH_SIZE: "0" })).rejects.toThrow(
      "VITEST_COVERAGE_BATCH_SIZE must be an integer between 1 and 16."
    );
    expect(childBoundary.calls).toHaveLength(0);
  });

  test("fails closed when unit test discovery returns an empty census", async () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "autoflow-coverage-empty-"));
    tempDiscoveryRoots.push(emptyRoot);
    await expect(
      run("unit", { AUTOFLOW_COVERAGE_DISCOVERY_ROOT: emptyRoot }),
    ).rejects.toThrow("No unit/integration test files discovered.");
    expect(childBoundary.calls).toHaveLength(0);
  });

  test("a failing coverage batch is rerun without coverage for diagnostics and exits with the original status", async () => {
    childBoundary.results.push(
      { status: 0, signal: null },
      { status: 7, signal: null },
      { status: 0, signal: null },
    );

    let error: unknown;
    try {
      await run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExitSignal);
    expect((error as ExitSignal).code).toBe(7);
    expect(childBoundary.calls).toHaveLength(3);

    const diagnostic = rawArgs(childBoundary.calls[2]);
    expect(diagnostic[0]).toBe("run");
    expect(diagnostic).toContain("--maxWorkers=1");
    expect(diagnostic).not.toContain("--coverage");
    expect(diagnostic.some((arg) => /\.test\.tsx?$/.test(arg))).toBe(true);
    expect(stderr.join("")).toContain("Vitest coverage subprocess failed (status=7");
    expect(stderr.join("")).toContain("Re-running failing batch without coverage");
  });

  describe("SCRUM-359 parallel slices", () => {
    const isAuthority = (call: (typeof childBoundary.calls)[number]) =>
      rawArgs(call).some((arg) => arg.endsWith("unified-deal-authority.json"));
    const isMerge = (call: (typeof childBoundary.calls)[number]) =>
      rawArgs(call).some((arg) => arg.startsWith("--merge-reports="));

    async function callsFor(mode: string, env: Record<string, string>) {
      childBoundary.calls.length = 0;
      await run(mode, env);
      return childBoundary.calls.map((call) => ({ ...call, args: [...call.args] }));
    }

    function fakeDiscoveryRoot(count: number, dir = "lib"): string {
      const directory = mkdtempSync(path.join(os.tmpdir(), "autoflow-coverage-slices-"));
      tempDiscoveryRoots.push(directory);
      mkdirSync(path.join(directory, dir));
      for (let index = 1; index <= count; index += 1) {
        writeFileSync(path.join(directory, dir, `f${String(index).padStart(2, "0")}.test.ts`), "");
      }
      return directory;
    }

    function writeBlobs(names: string[]) {
      const directory = path.join(process.cwd(), TEST_BLOB_DIR);
      mkdirSync(directory, { recursive: true });
      for (const name of names) writeFileSync(path.join(directory, name), "{}");
    }

    test("unit slices partition the exact batches of a full run: same args, each once, authority once, no merge", async () => {
      const root = fakeDiscoveryRoot(11);
      const base = { VITEST_COVERAGE_BATCH_SIZE: "2", AUTOFLOW_COVERAGE_DISCOVERY_ROOT: root };
      const full = await callsFor("unit", base);
      const fullWork = full.filter((call) => !isMerge(call)).map(rawArgs);
      expect(fullWork).toHaveLength(1 + 6);

      const sliced: string[][] = [];
      for (let slice = 1; slice <= 3; slice += 1) {
        const calls = await callsFor("unit", {
          ...base,
          AUTOFLOW_COVERAGE_PHASE: "run",
          AUTOFLOW_COVERAGE_SLICE: `${slice}/3`,
        });
        expect(calls.filter(isMerge)).toHaveLength(0);
        expect(calls.filter(isAuthority)).toHaveLength(slice === 1 ? 1 : 0);
        expect(calls.length).toBeGreaterThan(0);
        sliced.push(...calls.map(rawArgs));
      }
      const key = (args: string[]) => JSON.stringify(args);
      expect(sliced.map(key).sort()).toEqual(fullWork.map(key).sort());
      expect(new Set(sliced.map(key)).size).toBe(sliced.length);
    });

    test("Sonar slices partition the exact batches of a full run", async () => {
      const env = { VITEST_SONAR_BATCH_SIZE: "40" };
      const full = await callsFor("sonar", env);
      const fullWork = full.filter((call) => !isMerge(call)).map(rawArgs);
      const sliced: string[][] = [];
      for (let slice = 1; slice <= 4; slice += 1) {
        const calls = await callsFor("sonar", {
          ...env,
          AUTOFLOW_COVERAGE_PHASE: "run",
          AUTOFLOW_COVERAGE_SLICE: `${slice}/4`,
        });
        expect(calls.filter(isMerge)).toHaveLength(0);
        sliced.push(...calls.map(rawArgs));
      }
      const key = (args: string[]) => JSON.stringify(args);
      expect(sliced.map(key).sort()).toEqual(fullWork.map(key).sort());
      expect(new Set(sliced.map(key)).size).toBe(sliced.length);
    });

    test("SCRUM-752: the plan balances planned cost across slices over both modes together", async () => {
      const loads: string[] = [];
      for (const mode of ["unit", "sonar"]) {
        for (let slice = 1; slice <= 4; slice += 1) {
          stdout = [];
          await callsFor(mode, { AUTOFLOW_COVERAGE_PHASE: "run", AUTOFLOW_COVERAGE_SLICE: `${slice}/4` });
          const line = stdout.join("").match(/planned load per slice \(s, both modes\): ([\d ]+)/);
          expect(line, "each slice states the plan it ran").not.toBeNull();
          loads.push(line![1].trim());
        }
      }
      // Every invocation computed the identical joint plan.
      expect(new Set(loads).size).toBe(1);
      const perSlice = loads[0].split(" ").map(Number);
      expect(perSlice).toHaveLength(4);
      // Largest-first assignment keeps each slice within one heaviest unit of the
      // mean; round-robin by ordinal did not (slice 4 ran ~2x slice 2).
      const mean = perSlice.reduce((a, b) => a + b, 0) / perSlice.length;
      const heaviest = Math.max(...Object.values(WORKLOAD.files)) + WORKLOAD.processSeconds.unit;
      for (const load of perSlice) expect(Math.abs(load - mean)).toBeLessThanOrEqual(heaviest);
    });

    const invalidSliceEnvs: Array<[Record<string, string>, string]> = [
      [{ AUTOFLOW_COVERAGE_PHASE: "slice" }, "AUTOFLOW_COVERAGE_PHASE must be one of"],
      [{ AUTOFLOW_COVERAGE_PHASE: "run" }, "AUTOFLOW_COVERAGE_SLICE is required with"],
      [{ AUTOFLOW_COVERAGE_SLICE: "1/4" }, "AUTOFLOW_COVERAGE_SLICE is required with"],
      [{ AUTOFLOW_COVERAGE_PHASE: "merge", AUTOFLOW_COVERAGE_SLICE: "1/4" }, "AUTOFLOW_COVERAGE_SLICE is required with"],
      ...["0/4", "5/4", "1/1", "1/17", "a/b", "2", " 1/4"].map(
        (spec): [Record<string, string>, string] => [
          { AUTOFLOW_COVERAGE_PHASE: "run", AUTOFLOW_COVERAGE_SLICE: spec },
          "AUTOFLOW_COVERAGE_SLICE must be",
        ],
      ),
    ];
    test.each(invalidSliceEnvs)("rejects %o before any subprocess", async (env, message) => {
      await expect(run("unit", env)).rejects.toThrow(message);
      expect(childBoundary.calls).toHaveLength(0);
    });

    const sonarRoot = () => ({
      AUTOFLOW_COVERAGE_DISCOVERY_ROOT: fakeDiscoveryRoot(4, "convex"),
      VITEST_SONAR_BATCH_SIZE: "2",
    });

    test("merge refuses a missing blob directory without running anything", async () => {
      await expect(run("sonar", { ...sonarRoot(), AUTOFLOW_COVERAGE_PHASE: "merge" })).rejects.toThrow(
        /incomplete for sonar merge \(expected 3, found 0\)/,
      );
      expect(childBoundary.calls).toHaveLength(0);
    });

    test("merge refuses a blob set missing one slice's work and names it", async () => {
      writeBlobs(["unified-deal-authority.json", "sonar-1.json", "sonar-3.json"]);
      await expect(
        run("sonar", { ...sonarRoot(), VITEST_SONAR_BATCH_SIZE: "1", AUTOFLOW_COVERAGE_PHASE: "merge" }),
      ).rejects.toThrow(
        "Missing: sonar-2.json, sonar-4.json. Unexpected: none.",
      );
      expect(childBoundary.calls).toHaveLength(0);
    });

    test("merge refuses a stray blob from another run", async () => {
      writeBlobs(["unified-deal-authority.json", "sonar-1.json", "sonar-2.json", "unit-batch-1.json"]);
      await expect(run("sonar", { ...sonarRoot(), AUTOFLOW_COVERAGE_PHASE: "merge" })).rejects.toThrow(
        "Missing: none. Unexpected: unit-batch-1.json.",
      );
      expect(childBoundary.calls).toHaveLength(0);
    });

    test("merge refuses a stray file of any extension, because Vitest merges every file in the directory", async () => {
      writeBlobs(["unified-deal-authority.json", "sonar-1.json", "sonar-2.json", "stray.blob"]);
      await expect(run("sonar", { ...sonarRoot(), AUTOFLOW_COVERAGE_PHASE: "merge" })).rejects.toThrow(
        "Missing: none. Unexpected: stray.blob.",
      );
      expect(childBoundary.calls).toHaveLength(0);
    });

    test("merge refuses a unit blob set whose authority blob is missing", async () => {
      const root = fakeDiscoveryRoot(3);
      writeBlobs(["unit-batch-1.json", "unit-batch-2.json"]);
      await expect(
        run("unit", {
          VITEST_COVERAGE_BATCH_SIZE: "2",
          AUTOFLOW_COVERAGE_DISCOVERY_ROOT: root,
          AUTOFLOW_COVERAGE_PHASE: "merge",
        }),
      ).rejects.toThrow("Missing: unified-deal-authority.json.");
      expect(childBoundary.calls).toHaveLength(0);
    });

    test.each(["unit", "sonar"])(
      "%s merge on a complete blob set runs only the merge, with the same args as a full run, and keeps the blobs",
      async (mode) => {
        const root = fakeDiscoveryRoot(5, "convex");
        const env = {
          VITEST_COVERAGE_BATCH_SIZE: "2",
          VITEST_SONAR_BATCH_SIZE: "3",
          AUTOFLOW_COVERAGE_DISCOVERY_ROOT: root,
        };
        const fullMerge = (await callsFor(mode, env)).filter(isMerge).map(rawArgs);
        expect(fullMerge).toHaveLength(1);

        const blobs =
          mode === "unit"
            ? ["unified-deal-authority.json", "unit-batch-1.json", "unit-batch-2.json", "unit-batch-3.json"]
            : ["unified-deal-authority.json", "sonar-1.json", "sonar-2.json"];
        writeBlobs(blobs);
        const calls = await callsFor(mode, { ...env, AUTOFLOW_COVERAGE_PHASE: "merge" });
        expect(calls.map(rawArgs)).toEqual(fullMerge);
        expect(readdirSync(path.join(process.cwd(), TEST_BLOB_DIR)).sort()).toEqual([...blobs].sort());
      },
    );
  });

  // SCRUM-140: with only the blob reporter a subprocess that exits 1 prints
  // nothing, so a teardown race, an unhandled error and a real failing test are
  // indistinguishable. Fifteen Sonar-shard failures in CI between 2026-09-27 and
  // 2026-10-06 read only "blob report written ... status=1".
  describe("SCRUM-140 every test-running subprocess explains its own failure", () => {
    const testRunning = (calls: typeof childBoundary.calls) =>
      calls.map(rawArgs).filter((args) => args.includes("--coverage") && !args.some((arg) => arg.startsWith("--merge-reports=")));

    test.each(["unit", "sonar"])("%s mode: a console reporter beside blob, and the output file bound to blob only", async (mode) => {
      await run(mode, { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_SONAR_BATCH_SIZE: "64" });
      const calls = testRunning(childBoundary.calls);
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const args of calls) {
        expect(args).toContain("--reporter=blob");
        expect(args).toContain("--reporter=dot");
        const outputs = args.filter((arg) => arg.startsWith("--outputFile"));
        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatch(/^--outputFile\.blob=.+\.json$/);
        expect(outputs[0]).toContain(path.join(process.cwd(), TEST_BLOB_DIR));
      }
    });

    test("the real Vitest, given the runner's own reporter arguments, reports a zero-failing-test error and still writes the blob", async () => {
      await run("sonar", { VITEST_SONAR_BATCH_SIZE: "64" });
      const shard = testRunning(childBoundary.calls).find((args) => args.some((arg) => /sonar-\d+\.json$/.test(arg)));
      const reporting = (shard ?? []).filter((arg) => arg.startsWith("--reporter=") || arg.startsWith("--outputFile"));
      expect(reporting.length).toBeGreaterThan(0);

      const fixture = mkdtempSync(path.join(os.tmpdir(), "autoflow-scrum140-"));
      tempDiscoveryRoots.push(fixture);
      writeFileSync(
        path.join(fixture, "late.test.js"),
        "test('passes', () => { setTimeout(() => { throw new Error('late teardown boom'); }, 1); });\n" +
          "test('waits', async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });\n",
      );
      const blob = path.join(fixture, "blob.json");
      const args = reporting.map((arg) => (arg.startsWith("--outputFile.blob=") ? `--outputFile.blob=${blob}` : arg));
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("VITEST") || key === "NODE_V8_COVERAGE") delete env[key];
      }
      const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const result = real.spawnSync(
        process.execPath,
        [path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs"), "run", "--root", fixture, "--globals", ...args],
        { encoding: "utf8", env, timeout: 120_000 },
      );
      const output = `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");

      expect(result.status).toBe(1);
      expect(output).toMatch(/Tests\s+2 passed/);
      expect(output).toMatch(/Errors\s+1 error/);
      expect(output).toContain("late teardown boom");
      expect(readdirSync(fixture)).toContain("blob.json");
    });
  });

  describe("SCRUM-752 overlapping batch processes", () => {
    const reportsDirOf = (call: (typeof childBoundary.calls)[number]) =>
      rawArgs(call).find((arg) => arg.startsWith("--coverage.reportsDirectory="))!;
    const blobOf = (call: (typeof childBoundary.calls)[number]) =>
      rawArgs(call).find((arg) => arg.startsWith("--outputFile.blob="))!;
    const tested = () => childBoundary.calls.filter((call) => !rawArgs(call).some((arg) => arg.startsWith("--merge-reports=")));

    test("the default stays strictly serial: no overlapping child is ever started", async () => {
      await run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16" });
      expect(childBoundary.calls.some((call) => call.async)).toBe(false);
      expect(childBoundary.maxActive).toBe(0);
    });

    test.each(["unit", "sonar"])(
      "%s mode with two lanes runs the same batches with the same arguments, never more than two at once",
      async (mode) => {
        const env = { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_SONAR_BATCH_SIZE: "64" };
        await run(mode, env);
        const serial = tested().map((call) => rawArgs(call));
        childBoundary.calls.length = 0;
        childBoundary.events.length = 0;
        childBoundary.maxActive = 0;

        await run(mode, { ...env, VITEST_COVERAGE_CONCURRENCY: "2" });
        const pooled = tested();
        expect(childBoundary.maxActive).toBe(2);
        // Only the reports directory differs, and only for overlapping batches:
        // the census, blobs, thresholds and scope are argument-for-argument equal.
        const withoutReports = (args: string[]) => args.filter((arg) => !arg.startsWith("--coverage.reportsDirectory="));
        const key = (args: string[]) => JSON.stringify(withoutReports(args));
        expect(pooled.map((call) => key(rawArgs(call))).sort()).toEqual(serial.map(key).sort());
        expect(new Set(pooled.map(blobOf)).size).toBe(pooled.length);
      },
    );

    test("the authority control runs alone, before any overlapping batch starts", async () => {
      await run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_COVERAGE_CONCURRENCY: "2" });
      expect(childBoundary.calls[0].async).toBeUndefined();
      expect(rawArgs(childBoundary.calls[0])).toContain("convex/unifiedDealFeeAuthority.test.ts");
      expect(childBoundary.events[0]).toBe("sync with 0 running");
      expect(childBoundary.events[1]).toMatch(/^start unit-batch-/);
      // The merge, too, starts only after every batch has finished.
      expect(childBoundary.events.at(-1)).toBe("sync with 0 running");
      const merge = rawArgs(childBoundary.calls.at(-1)!);
      expect(merge.some((arg) => arg.startsWith("--merge-reports="))).toBe(true);
    });

    test("every overlapping batch gets its own coverage directory, outside the blob directory", async () => {
      await run("sonar", { VITEST_COVERAGE_CONCURRENCY: "2" });
      const batches = childBoundary.calls.filter((call) => call.async);
      expect(batches.length).toBeGreaterThan(2);
      const dirs = batches.map(reportsDirOf);
      expect(new Set(dirs).size).toBe(dirs.length);
      const coverageRoot = path.join(process.cwd(), TEST_COVERAGE_DIR, "units");
      const blobRoot = path.join(process.cwd(), TEST_BLOB_DIR);
      for (const dir of dirs) {
        const value = dir.slice("--coverage.reportsDirectory=".length);
        expect(path.dirname(value)).toBe(coverageRoot);
        expect(value.startsWith(blobRoot)).toBe(false);
      }
      // The merge still writes the one shared directory the workflow reads.
      expect(reportsDirOf(childBoundary.calls.at(-1)!)).toBe(
        `--coverage.reportsDirectory=${path.join(process.cwd(), TEST_COVERAGE_DIR)}`,
      );
    });

    test("the most expensive batch starts first", async () => {
      await run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_COVERAGE_CONCURRENCY: "2" });
      const heaviest = Object.entries(WORKLOAD.files).sort((a, b) => b[1] - a[1])[0][0];
      const first = childBoundary.calls.find((call) => call.async)!;
      expect(batchTestFiles(first)).toEqual([heaviest]);
    });

    test("each overlapping batch's output is written in one piece under its own header", async () => {
      await run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_COVERAGE_CONCURRENCY: "2" });
      const text = stdout.join("");
      const pieces = stdout.filter((chunk) => chunk.startsWith("Coverage batch "));
      expect(pieces.length).toBe(childBoundary.calls.filter((call) => call.async).length);
      for (const piece of pieces) {
        const blob = /child output for (unit-batch-\d+\.json)/.exec(piece)?.[1];
        expect(blob).toBeDefined();
        expect(piece).toContain(`child stderr for ${blob}`);
      }
      expect(text).not.toMatch(/child output for [^\n]+\n(?!child stderr)/);
    });

    test.each(["0", "3", "1.5", "two"])(
      "rejects an invalid concurrency (%s) before any subprocess",
      async (value) => {
        await expect(run("unit", { VITEST_COVERAGE_CONCURRENCY: value })).rejects.toThrow(
          "VITEST_COVERAGE_CONCURRENCY must be an integer between 1 and 2.",
        );
        expect(childBoundary.calls).toHaveLength(0);
      },
    );

    test("a failing overlapping batch stops new batches, drains the running one, reruns for diagnostics and exits with its status", async () => {
      // Authority, then two overlapping batches: the first fails.
      childBoundary.results.push({ status: 0, signal: null }, { status: 7, signal: null }, { status: 0, signal: null });
      let error: unknown;
      try {
        await run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_COVERAGE_CONCURRENCY: "2" });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ExitSignal);
      expect((error as ExitSignal).code).toBe(7);
      const batches = childBoundary.calls.filter((call) => call.async);
      // The batch beside the failure was already running and finished; the
      // failing lane started nothing more. Only the surviving lane may have
      // started one more batch before it saw the failure.
      expect(batches.length).toBeLessThanOrEqual(3);
      expect(childBoundary.active).toBe(0);
      const diagnostic = rawArgs(childBoundary.calls.at(-1)!);
      expect(childBoundary.calls.at(-1)!.async).toBeUndefined();
      expect(diagnostic).not.toContain("--coverage");
      expect(diagnostic).toEqual(["run", ...batchTestFiles(batches[0]), "--maxWorkers=1"]);
      expect(childBoundary.events.at(-1)).toBe("sync with 0 running");
      expect(stderr.join("")).toContain("Vitest coverage subprocess failed (status=7");
    });

    test("an overlapping batch killed by a signal fails the slice", async () => {
      childBoundary.results.push({ status: 0, signal: null }, { status: null, signal: "SIGKILL" });
      await expect(
        run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_COVERAGE_CONCURRENCY: "2" }),
      ).rejects.toMatchObject({ code: 1 });
      expect(stderr.join("")).toContain("signal=SIGKILL");
    });

    test("an overlapping batch that cannot be launched propagates the launch error", async () => {
      childBoundary.results.push({ status: 0, signal: null }, { status: null, signal: null, error: new Error("spawn exploded") });
      await expect(
        run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_COVERAGE_CONCURRENCY: "2" }),
      ).rejects.toThrow("spawn exploded");
      expect(childBoundary.active).toBe(0);
    });

    test("two failures report both, and the first in plan order decides the status", async () => {
      childBoundary.results.push({ status: 0, signal: null }, { status: 3, signal: null }, { status: 5, signal: null });
      let error: unknown;
      try {
        await run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_COVERAGE_CONCURRENCY: "2" });
      } catch (caught) {
        error = caught;
      }
      const batches = childBoundary.calls.filter((call) => call.async);
      expect(batches).toHaveLength(2);
      expect(error).toBeInstanceOf(ExitSignal);
      // Statuses were handed out in start order; the batch earlier in the plan wins.
      const order = (call: (typeof childBoundary.calls)[number]) => Number(/unit-batch-(\d+)\.json/.exec(blobOf(call))![1]);
      const [earlier, later] = order(batches[0]) < order(batches[1]) ? [3, 5] : [5, 3];
      expect((error as ExitSignal).code).toBe(earlier);
      expect(stderr.join("")).toMatch(new RegExp(`Also failed: unit-batch-\\d+\\.json \\(status=${later}`));
    });

    test("telemetry records the concurrency each process ran under", async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "autoflow-timings-"));
      tempDiscoveryRoots.push(directory);
      const timings = path.join(directory, "timings.jsonl");
      await run("sonar", { AUTOFLOW_COVERAGE_TIMINGS: timings, VITEST_COVERAGE_CONCURRENCY: "2" });
      const lines = readFileSync(timings, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toHaveLength(tested().length);
      for (const line of lines) expect(line.concurrency).toBe(2);
    });
  });

  test("propagates a child-process launch error instead of converting it into a green result", async () => {
    childBoundary.results.push({ status: null, signal: null, error: new Error("spawn exploded") });
    await expect(run("sonar")).rejects.toThrow("spawn exploded");
    expect(childBoundary.calls).toHaveLength(1);
  });
});
