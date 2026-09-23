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
import { readdirSync } from "node:fs";
import path from "node:path";

const childBoundary = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  results: [] as Array<{ status: number | null; signal: string | null; error?: Error }>,
}));

const fsBoundary = vi.hoisted(() => ({
  readdirOverride: null as null | ((directory: string, options: unknown) => unknown[]),
  removed: [] as string[],
  created: [] as string[],
}));

vi.mock("node:child_process", () => ({
  spawnSync: (file: string, args: string[], options: Record<string, unknown>) => {
    childBoundary.calls.push({ file, args, options });
    return childBoundary.results.shift() ?? { status: 0, signal: null };
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (directory: string, options: unknown) =>
      fsBoundary.readdirOverride
        ? fsBoundary.readdirOverride(directory, options)
        : actual.readdirSync(directory, options as never),
    rmSync: (target: string) => {
      fsBoundary.removed.push(String(target));
    },
    mkdirSync: (target: string) => {
      fsBoundary.created.push(String(target));
      return undefined;
    },
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

async function run(mode: string, env: Record<string, string | undefined> = {}) {
  for (const key of ["VITEST_COVERAGE_SHARDS", "VITEST_COVERAGE_BATCH_SIZE"]) {
    delete process.env[key];
  }
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
  fsBoundary.readdirOverride = null;
  fsBoundary.removed.length = 0;
  fsBoundary.created.length = 0;
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

    expect(fsBoundary.removed.some((p) => p.endsWith(".vitest-reports"))).toBe(true);
    expect(fsBoundary.removed.some((p) => p.endsWith("coverage"))).toBe(true);
    expect(fsBoundary.created.some((p) => p.endsWith(".vitest-reports"))).toBe(true);

    const authority = rawArgs(childBoundary.calls[0]);
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
    expect(fsBoundary.removed).toHaveLength(0);
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
    fsBoundary.readdirOverride = () => [];
    await expect(run("unit")).rejects.toThrow("No unit/integration test files discovered.");
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

  test("propagates a child-process launch error instead of converting it into a green result", async () => {
    childBoundary.results.push({ status: null, signal: null, error: new Error("spawn exploded") });
    await expect(run("sonar")).rejects.toThrow("spawn exploded");
    expect(childBoundary.calls).toHaveLength(1);
  });
});
