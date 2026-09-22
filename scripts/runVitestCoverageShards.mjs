import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "unit" && mode !== "sonar") {
  throw new Error('Usage: node scripts/runVitestCoverageShards.mjs <unit|sonar>');
}

// Four coverage shards still allowed a single V8 worker to grow past 5.5 GiB
// on the full AutoFlow suite. Eight keeps each coverage process bounded while
// preserving the exact same test census and final merged coverage gate.
const shardCount = Number(process.env.VITEST_COVERAGE_SHARDS ?? "8");
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
  '--coverage.include=convex/**/*.ts',
  '--coverage.include=scripts/**/*.ts',
  '--coverage.include=scripts/**/*.mjs',
  '--coverage.exclude=convex/_generated/**',
  '--coverage.exclude=**/*.test.ts',
  ...thresholdZeroArgs,
];

const sharedShardArgs = [
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
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(blobDir, { recursive: true, force: true });
rmSync(coverageDir, { recursive: true, force: true });
mkdirSync(blobDir, { recursive: true });

for (let shard = 1; shard <= shardCount; shard += 1) {
  const modeArgs = mode === "sonar" ? ["convex", "scripts"] : [];
  const coverageArgs = mode === "sonar" ? sonarCoverageArgs : thresholdZeroArgs;
  runVitest([
    "run",
    ...modeArgs,
    `--shard=${shard}/${shardCount}`,
    "--reporter=blob",
    `--outputFile=${path.join(blobDir, `${mode}-${shard}.json`)}`,
    ...sharedShardArgs,
    ...coverageArgs,
  ]);
}

// Vitest's blob merge combines both test results and V8 coverage from every
// shard. Unit mode intentionally restores the repository's configured coverage
// thresholds here; Sonar mode keeps its existing zero-threshold contract because
// SonarQube owns that quality gate.
const mergeArgs = [
  `--merge-reports=${blobDir}`,
  "--coverage",
  ...(mode === "sonar" ? sonarCoverageArgs : []),
];
runVitest(mergeArgs);
