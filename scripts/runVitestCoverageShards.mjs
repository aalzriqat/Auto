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
const blobDir = path.join(root, ".vitest-reports");
const coverageDir = path.join(root, "coverage");

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

const sharedCoverageArgs = [
  "--coverage",
  "--maxWorkers=1",
  "--exclude=convex/unifiedDealFeeAuthority.test.ts",
];

function runVitest(args) {
  const result = spawnSync(process.execPath, [vitestBin, ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
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

function collectUnitTestFiles(directory = root, relative = "") {
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
    if (candidate === "convex/unifiedDealFeeAuthority.test.ts") continue;
    files.push(candidate);
  }
  return files;
}

rmSync(blobDir, { recursive: true, force: true });
rmSync(coverageDir, { recursive: true, force: true });
mkdirSync(blobDir, { recursive: true });

if (mode === "unit") {
  const testFiles = collectUnitTestFiles().sort();
  if (testFiles.length === 0) throw new Error("No unit/integration test files discovered.");

  for (let index = 0; index < testFiles.length; index += 1) {
    const testFile = testFiles[index];
    process.stdout.write(
      `Coverage file ${index + 1}/${testFiles.length}: ${testFile}\n`,
    );
    runVitest([
      "run",
      testFile,
      "--reporter=blob",
      `--outputFile=${path.join(blobDir, `unit-${index + 1}.json`)}`,
      ...sharedCoverageArgs,
      ...thresholdZeroArgs,
    ]);
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
  ...(mode === "sonar" ? sonarCoverageArgs : []),
];
runVitest(mergeArgs);
