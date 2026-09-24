import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "unit" && mode !== "sonar") {
  throw new Error('Usage: node scripts/runVitestCoverageShards.mjs <unit|sonar>');
}

// Sonar coverage remains sharded because its input is already narrowly scoped.
// The full unit suite is intentionally process-isolated per test file: even 16
// Vitest shards left one long-lived V8 coverage process above the fixed 5.5 GiB
// CI heap ceiling. Per-file processes preserve the exact test census and final
// merged coverage gate while bounding retained V8 coverage state without buying
// reliability by raising the heap or weakening thresholds.
const shardCount = Number(process.env.VITEST_COVERAGE_SHARDS ?? "16");
if (!Number.isInteger(shardCount) || shardCount < 2 || shardCount > 16) {
  throw new Error("VITEST_COVERAGE_SHARDS must be an integer between 2 and 16.");
}

const root = process.cwd();
const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");
const blobDir = path.resolve(
  root,
  process.env.AUTOFLOW_COVERAGE_BLOB_DIR ?? ".vitest-reports",
);
const coverageDir = path.resolve(
  root,
  process.env.AUTOFLOW_COVERAGE_REPORTS_DIR ?? "coverage",
);
const discoveryRoot = path.resolve(
  root,
  process.env.AUTOFLOW_COVERAGE_DISCOVERY_ROOT ?? ".",
);
const coverageReportsArg = `--coverage.reportsDirectory=${coverageDir}`;
const authorityTest = "convex/unifiedDealFeeAuthority.test.ts";

const thresholdZeroArgs = [
  "--coverage.thresholds.lines=0",
  "--coverage.thresholds.functions=0",
  "--coverage.thresholds.branches=0",
  "--coverage.thresholds.statements=0",
];

const sonarCoverageArgs = [
  "--coverage.include=convex/**/*.ts",
  "--coverage.include=scripts/**/*.ts",
  "--coverage.include=scripts/**/*.mjs",
  "--coverage.exclude=convex/_generated/**",
  "--coverage.exclude=**/*.test.ts",
  ...thresholdZeroArgs,
];

// The authority suite is run as its own covered process below. Excluding it
// from the remaining workers prevents duplicate execution while its V8 blob is
// still merged into the same final report and therefore contributes to both
// repository thresholds and Sonar's exact-head coverage evidence.
const sharedCoverageArgs = [
  "--coverage",
  "--maxWorkers=1",
  `--exclude=${authorityTest}`,
];

function runVitest(args, diagnosticFiles = []) {
  const result = spawnSync(process.execPath, [vitestBin, ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(
      `Vitest coverage subprocess failed (status=${String(result.status)}, signal=${String(result.signal)}).\n`,
    );
    if (diagnosticFiles.length > 0) {
      process.stderr.write(
        `Re-running failing batch without coverage to expose assertion output: ${diagnosticFiles.join(" ")}\n`,
      );
      spawnSync(process.execPath, [vitestBin, "run", ...diagnosticFiles, "--maxWorkers=1"], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
      });
    }
    process.exit(result.status ?? 1);
  }
}

const excludedDirs = new Set([
  "node_modules",
  ".next",
  "out",
  "build",
  "apps",
  "packages",
  ".claude",
  ".git",
]);

function collectUnitTestFiles(directory = discoveryRoot, relative = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) continue;
      files.push(
        ...collectUnitTestFiles(
          path.join(directory, entry.name),
          relative ? `${relative}/${entry.name}` : entry.name,
        ),
      );
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.test\.tsx?$/.test(entry.name)) continue;
    const candidate = relative ? `${relative}/${entry.name}` : entry.name;
    if (candidate === authorityTest) continue;
    files.push(candidate);
  }
  return files;
}

rmSync(blobDir, { recursive: true, force: true });
rmSync(coverageDir, { recursive: true, force: true });
mkdirSync(blobDir, { recursive: true });

// Negative control for the coverage pipeline itself: the release-critical
// authority suite must produce a V8 coverage blob on every covered path. It is
// deliberately isolated so coverage instrumentation cannot reintroduce the
// long-lived-process OOM that motivated this runner.
runVitest([
  "run",
  authorityTest,
  "--reporter=blob",
  `--outputFile=${path.join(blobDir, "unified-deal-authority.json")}`,
  "--coverage",
  coverageReportsArg,
  "--maxWorkers=1",
  ...(mode === "sonar" ? sonarCoverageArgs : thresholdZeroArgs),
]);

if (mode === "unit") {
  const testFiles = collectUnitTestFiles().sort();
  if (testFiles.length === 0) throw new Error("No unit/integration test files discovered.");

  const batchSize = Number(process.env.VITEST_COVERAGE_BATCH_SIZE ?? "8");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 16) {
    throw new Error("VITEST_COVERAGE_BATCH_SIZE must be an integer between 1 and 16.");
  }
  const batchCount = Math.ceil(testFiles.length / batchSize);
  for (let offset = 0, batch = 1; offset < testFiles.length; offset += batchSize, batch += 1) {
    const batchFiles = testFiles.slice(offset, offset + batchSize);
    process.stdout.write(
      `Coverage batch ${batch}/${batchCount}: ${batchFiles.join(" ")}\n`,
    );
    runVitest(
      [
        "run",
        ...batchFiles,
        "--reporter=blob",
        `--outputFile=${path.join(blobDir, `unit-batch-${batch}.json`)}`,
        ...sharedCoverageArgs,
        coverageReportsArg,
        ...thresholdZeroArgs,
      ],
      batchFiles,
    );
  }
} else {
  for (let shard = 1; shard <= shardCount; shard += 1) {
    runVitest([
      "run",
      "convex",
      "scripts",
      `--shard=${shard}/${shardCount}`,
      "--reporter=blob",
      `--outputFile=${path.join(blobDir, `sonar-${shard}.json`)}`,
      ...sharedCoverageArgs,
      coverageReportsArg,
      ...sonarCoverageArgs,
    ]);
  }
}

// Vitest's blob merge combines both test results and V8 coverage from every
// isolated process. Unit mode intentionally restores the repository's configured
// thresholds here; Sonar mode keeps its zero-threshold contract because SonarQube
// owns that quality gate.
const mergeArgs = [
  `--merge-reports=${blobDir}`,
  "--coverage",
  coverageReportsArg,
  ...(mode === "sonar" ? sonarCoverageArgs : []),
];
runVitest(mergeArgs);