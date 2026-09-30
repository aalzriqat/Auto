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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const childBoundary = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  results: [] as Array<{ status: number | null; signal: string | null; error?: Error }>,
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
    return childBoundary.results.shift() ?? { status: 0, signal: null };
  };
  return {
    ...actual,
    default: {
      ...(actual as unknown as { default?: Record<string, unknown> }).default,
      ...actual,
      spawnSync: interceptedSpawnSync,
    },
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

const TEST_BLOB_DIR = ".vitest-reports-runner-test";
const TEST_COVERAGE_DIR = ".coverage-runner-test";
const tempDiscoveryRoots: string[] = [];

async function run(mode: string, env: Record<string, string | undefined> = {}) {
  for (const key of [
    "VITEST_COVERAGE_SHARDS",
    "VITEST_COVERAGE_BATCH_SIZE",
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
  // Regression control for c33ee35cc: without the child-process boundary,
  // importing the real runner below recursively launches this suite again and
  // CI never reaches a verdict. Probe the boundary before any test can import
  // the runner so that losing the mock fails quickly instead of hanging.
  spawnSync(process.execPath, ["--version"], { cwd: process.cwd() });
  if (childBoundary.calls.length !== 1) {
    throw new Error("Coverage runner tests must intercept child processes before importing the runner.");
  }
  childBoundary.calls.length = 0;
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

    await run("unit", { VITEST_COVERAGE_BATCH_SIZE: "16", VITEST_COVERAGE_SHARDS: "2" });

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
    expect([...files].sort()).toEqual(files);
    const expected = expectedVitestCensus().filter(
      (file) => file !== "convex/unifiedDealFeeAuthority.test.ts",
    );
    expect(files).toEqual(expected);

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

  test("sonar mode keeps the measured source scope, bounded shards, isolated authority coverage, and zero local thresholds", async () => {
    await run("sonar", { VITEST_COVERAGE_SHARDS: "2" });

    expect(childBoundary.calls).toHaveLength(4);
    const authority = rawArgs(childBoundary.calls[0]);
    expect(authority).toContain("convex/unifiedDealFeeAuthority.test.ts");
    expect(authority).toContain("--coverage.include=convex/**/*.ts");
    expect(authority).toContain("--coverage.include=scripts/**/*.mjs");
    for (const threshold of EXPECTED_ZERO_THRESHOLDS) expect(authority).toContain(threshold);

    const shard1 = rawArgs(childBoundary.calls[1]);
    const shard2 = rawArgs(childBoundary.calls[2]);
    expect(shard1).toContain("--shard=1/2");
    expect(shard2).toContain("--shard=2/2");
    for (const args of [shard1, shard2]) {
      expect(args).toContain("convex");
      expect(args).toContain("scripts");
      expect(args).toContain("--exclude=convex/unifiedDealFeeAuthority.test.ts");
      for (const threshold of EXPECTED_ZERO_THRESHOLDS) expect(args).toContain(threshold);
    }

    const merge = rawArgs(childBoundary.calls[3]);
    expect(merge.some((arg) => arg.startsWith("--merge-reports="))).toBe(true);
    expect(merge).toContain("--coverage.include=convex/**/*.ts");
    for (const threshold of EXPECTED_ZERO_THRESHOLDS) expect(merge).toContain(threshold);
  });

  test("rejects an unknown mode before touching the filesystem or spawning Vitest", async () => {
    await expect(run("mystery")).rejects.toThrow("Usage: node scripts/runVitestCoverageShards.mjs <unit|sonar>");
    expect(childBoundary.calls).toHaveLength(0);
    expect(childBoundary.calls).toHaveLength(0);
  });

  test.each(["1", "17", "2.5", "not-a-number"])(
    "rejects an invalid shard count (%s) before any subprocess",
    async (value) => {
      await expect(run("sonar", { VITEST_COVERAGE_SHARDS: value })).rejects.toThrow(
        "VITEST_COVERAGE_SHARDS must be an integer between 2 and 16."
      );
      expect(childBoundary.calls).toHaveLength(0);
    }
  );

  test("rejects an invalid unit batch size after the isolated authority control and before any batch", async () => {
    await expect(run("unit", { VITEST_COVERAGE_BATCH_SIZE: "0" })).rejects.toThrow(
      "VITEST_COVERAGE_BATCH_SIZE must be an integer between 1 and 16."
    );
    expect(childBoundary.calls).toHaveLength(1);
    expect(rawArgs(childBoundary.calls[0])).toContain("convex/unifiedDealFeeAuthority.test.ts");
  });

  test("fails closed when unit test discovery returns an empty census", async () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "autoflow-coverage-empty-"));
    tempDiscoveryRoots.push(emptyRoot);
    await expect(
      run("unit", { AUTOFLOW_COVERAGE_DISCOVERY_ROOT: emptyRoot }),
    ).rejects.toThrow("No unit/integration test files discovered.");
    expect(childBoundary.calls).toHaveLength(1);
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

    function fakeDiscoveryRoot(count: number): string {
      const directory = mkdtempSync(path.join(os.tmpdir(), "autoflow-coverage-slices-"));
      tempDiscoveryRoots.push(directory);
      mkdirSync(path.join(directory, "lib"));
      for (let index = 1; index <= count; index += 1) {
        writeFileSync(path.join(directory, "lib", `f${String(index).padStart(2, "0")}.test.ts`), "");
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

    test("Sonar slices partition the exact shards of a full run", async () => {
      const full = await callsFor("sonar", { VITEST_COVERAGE_SHARDS: "5" });
      const fullWork = full.filter((call) => !isMerge(call)).map(rawArgs);
      const sliced: string[][] = [];
      for (let slice = 1; slice <= 4; slice += 1) {
        const calls = await callsFor("sonar", {
          VITEST_COVERAGE_SHARDS: "5",
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

    test("merge refuses a missing blob directory without running anything", async () => {
      await expect(run("sonar", { VITEST_COVERAGE_SHARDS: "2", AUTOFLOW_COVERAGE_PHASE: "merge" })).rejects.toThrow(
        /incomplete for sonar merge \(expected 3, found 0\)/,
      );
      expect(childBoundary.calls).toHaveLength(0);
    });

    test("merge refuses a blob set missing one slice's work and names it", async () => {
      writeBlobs(["unified-deal-authority.json", "sonar-1.json", "sonar-3.json"]);
      await expect(run("sonar", { VITEST_COVERAGE_SHARDS: "3", AUTOFLOW_COVERAGE_PHASE: "merge" })).rejects.toThrow(
        "Missing: sonar-2.json. Unexpected: none.",
      );
      expect(childBoundary.calls).toHaveLength(0);
    });

    test("merge refuses a stray blob from another run", async () => {
      writeBlobs(["unified-deal-authority.json", "sonar-1.json", "sonar-2.json", "unit-batch-1.json"]);
      await expect(run("sonar", { VITEST_COVERAGE_SHARDS: "2", AUTOFLOW_COVERAGE_PHASE: "merge" })).rejects.toThrow(
        "Missing: none. Unexpected: unit-batch-1.json.",
      );
      expect(childBoundary.calls).toHaveLength(0);
    });

    test("merge refuses a stray file of any extension, because Vitest merges every file in the directory", async () => {
      writeBlobs(["unified-deal-authority.json", "sonar-1.json", "sonar-2.json", "stray.blob"]);
      await expect(run("sonar", { VITEST_COVERAGE_SHARDS: "2", AUTOFLOW_COVERAGE_PHASE: "merge" })).rejects.toThrow(
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
        const root = fakeDiscoveryRoot(5);
        const env = {
          VITEST_COVERAGE_BATCH_SIZE: "2",
          VITEST_COVERAGE_SHARDS: "2",
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

  test("propagates a child-process launch error instead of converting it into a green result", async () => {
    childBoundary.results.push({ status: null, signal: null, error: new Error("spawn exploded") });
    await expect(run("sonar")).rejects.toThrow("spawn exploded");
    expect(childBoundary.calls).toHaveLength(1);
  });
});
