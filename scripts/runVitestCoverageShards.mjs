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

// CI parallelism (SCRUM-359). "all" is the original single-process pipeline.
// "run" executes only this slice's share of the SAME work units (authority
// control, unit batches or Sonar shards) and writes blobs without merging.
// "merge" runs no tests: it refuses unless the blob directory holds exactly the
// blobs a full "all" run would have produced, then performs the identical
// merge. Batch composition is always computed from the full sorted census, so
// slicing changes which machine runs a batch, never what the batch contains.
const phase = process.env.AUTOFLOW_COVERAGE_PHASE ?? "all";
if (phase !== "all" && phase !== "run" && phase !== "merge") {
  throw new Error("AUTOFLOW_COVERAGE_PHASE must be one of: all, run, merge.");
}
const sliceSpec = process.env.AUTOFLOW_COVERAGE_SLICE;
if ((phase === "run") !== (sliceSpec !== undefined)) {
  throw new Error("AUTOFLOW_COVERAGE_SLICE is required with, and only with, AUTOFLOW_COVERAGE_PHASE=run.");
}
let sliceIndex = 1;
let sliceCount = 1;
if (phase === "run") {
  const match = /^(\d+)\/(\d+)$/.exec(sliceSpec);
  sliceIndex = match ? Number(match[1]) : Number.NaN;
  sliceCount = match ? Number(match[2]) : Number.NaN;
  if (!(sliceCount >= 2 && sliceCount <= 16 && sliceIndex >= 1 && sliceIndex <= sliceCount)) {
    throw new Error("AUTOFLOW_COVERAGE_SLICE must be <index>/<count> with 1 <= index <= count and 2 <= count <= 16.");
  }
}
// Work unit N (1-based) belongs to slice ((N - 1) mod count) + 1. The authority
// control is work unit 1, so exactly one slice runs it.
const ownsWorkUnit = (ordinal) => (ordinal - 1) % sliceCount === sliceIndex - 1;

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

const authorityBlob = "unified-deal-authority.json";

function unitBatches() {
  const testFiles = collectUnitTestFiles().sort();
  if (testFiles.length === 0) throw new Error("No unit/integration test files discovered.");

  const batchSize = Number(process.env.VITEST_COVERAGE_BATCH_SIZE ?? "8");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 16) {
    throw new Error("VITEST_COVERAGE_BATCH_SIZE must be an integer between 1 and 16.");
  }
  const batches = [];
  for (let offset = 0; offset < testFiles.length; offset += batchSize) {
    batches.push(testFiles.slice(offset, offset + batchSize));
  }
  return batches;
}

// The merge-phase completeness gate: a missing slice, a slice that stopped
// early, or a stray blob from another run must not reach the merge, because
// Vitest merges whatever blobs it finds and would report the smaller census
// as green.
function assertCompleteBlobSet() {
  const expected =
    mode === "unit"
      ? unitBatches().map((_, index) => `unit-batch-${index + 1}.json`)
      : Array.from({ length: shardCount }, (_, index) => `sonar-${index + 1}.json`);
  expected.push(authorityBlob);
  let present = [];
  try {
    present = readdirSync(blobDir).filter((name) => name.endsWith(".json"));
  } catch {
    present = [];
  }
  const missing = expected.filter((name) => !present.includes(name));
  const unexpected = present.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Coverage blob set is incomplete for ${mode} merge (expected ${expected.length}, found ${present.length}). ` +
        `Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
  process.stdout.write(`Coverage blob set complete for ${mode} merge: ${expected.length} blobs.\n`);
}

rmSync(coverageDir, { recursive: true, force: true });
if (phase === "merge") {
  assertCompleteBlobSet();
} else {
  rmSync(blobDir, { recursive: true, force: true });
  mkdirSync(blobDir, { recursive: true });
}

// Negative control for the coverage pipeline itself: the release-critical
// authority suite must produce a V8 coverage blob on every covered path. It is
// deliberately isolated so coverage instrumentation cannot reintroduce the
// long-lived-process OOM that motivated this runner.
if (phase !== "merge" && ownsWorkUnit(1)) {
  runVitest([
    "run",
    authorityTest,
    "--reporter=blob",
    `--outputFile=${path.join(blobDir, authorityBlob)}`,
    "--coverage",
    coverageReportsArg,
    "--maxWorkers=1",
    ...(mode === "sonar" ? sonarCoverageArgs : thresholdZeroArgs),
  ]);
}

if (phase === "merge") {
  // Tests already ran in the slices; fall through to the merge.
} else if (mode === "unit") {
  const batches = unitBatches();
  const batchCount = batches.length;
  for (let batch = 1; batch <= batchCount; batch += 1) {
    // Work unit 1 is the authority control, so batch N is work unit N + 1.
    if (!ownsWorkUnit(batch + 1)) continue;
    const batchFiles = batches[batch - 1];
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
    if (!ownsWorkUnit(shard + 1)) continue;
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
if (phase === "run") {
  process.stdout.write(
    `Coverage slice ${sliceIndex}/${sliceCount} (${mode}) wrote its blobs; the merge runs in the aggregator.\n`,
  );
} else {
  runVitest(mergeArgs);
}