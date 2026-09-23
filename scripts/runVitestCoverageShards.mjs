import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "unit" && mode !== "sonar") {
  throw new Error('Usage: node scripts/runVitestCoverageShards.mjs <unit|sonar>');
}

// Coverage is deliberately process-isolated rather than buying reliability by
// raising Node's heap ceiling. Eight shards still allowed shard 1 to exceed the
// 5.5 GiB CI ceiling on the production suite. Sixteen is the bounded maximum:
// it preserves the exact test census and final merged coverage gate while
// reducing the maximum amount of V8 coverage state retained by one process.
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
