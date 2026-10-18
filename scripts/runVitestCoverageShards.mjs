import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "unit" && mode !== "sonar") {
  throw new Error('Usage: node scripts/runVitestCoverageShards.mjs <unit|sonar>');
}

// The full unit suite is process-isolated in small batches: even 16 Vitest
// shards left one long-lived V8 coverage process above the fixed 5.5 GiB CI heap
// ceiling. Bounded processes preserve the exact test census and final merged
// coverage gate while bounding retained V8 coverage state without buying
// reliability by raising the heap or weakening thresholds.
//
// SCRUM-752: Sonar used Vitest's hash-based `--shard`, which hid each shard's
// composition from the scheduler and could put several of the most expensive
// suites in one process. Sonar now uses explicit file batches built exactly like
// the unit batches, from the same census filtered the way Vitest filters
// `vitest run convex scripts` (see sonarCensus below).
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
  // CI helpers (.cjs) under scripts/ are exercised by suites in scripts/, so
  // they are measured rather than left outside the report (SCRUM-293).
  "--coverage.include=scripts/**/*.cjs",
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

// The blob reporter alone prints nothing, so a subprocess that exits 1 left only
// "blob report written ... status=1" — a teardown race, an unhandled error and a
// real failing test looked identical (SCRUM-140). `dot` prints the Tests and
// Errors counts and every failure. The output file is bound to the blob
// reporter by name so no other reporter can claim it.
const reporterArgs = (blobPath) => ["--reporter=blob", "--reporter=dot", `--outputFile.blob=${blobPath}`];

// Optional machine-readable telemetry (SCRUM-752): one JSON line per Vitest
// process with its work unit, files, planned cost and measured wall time. It is
// written outside the blob directory, which must hold blobs only.
const timingsFile = process.env.AUTOFLOW_COVERAGE_TIMINGS;

function runVitest(args, diagnosticFiles = [], unit = undefined) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [vitestBin, ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (timingsFile && unit) {
    appendFileSync(
      timingsFile,
      `${JSON.stringify({
        mode,
        unit: unit.blob,
        slice: phase === "run" ? `${sliceIndex}/${sliceCount}` : "all",
        files: unit.files,
        estimatedSeconds: Math.round(unit.cost),
        wallSeconds: Math.round((performance.now() - started) / 100) / 10,
        status: result.status,
      })}\n`,
    );
  }
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

function unitTestCensus() {
  const testFiles = collectUnitTestFiles().sort();
  if (testFiles.length === 0) throw new Error("No unit/integration test files discovered.");
  // Every file is handed to Vitest as a CLI filter, and Vitest keeps any test
  // file whose lower-cased relative path CONTAINS a filter. A census entry that
  // is a substring of another entry would therefore run that other file a second
  // time, in a batch that does not own it. Refuse instead of double-counting.
  const lower = testFiles.map((file) => file.toLowerCase());
  for (const [index, file] of lower.entries()) {
    const shadowed = lower.find((other, otherIndex) => otherIndex !== index && other.includes(file));
    if (shadowed) {
      throw new Error(`Test file ${testFiles[index]} is a substring of ${shadowed}; Vitest would run both for one filter.`);
    }
  }
  return testFiles;
}

// `vitest run convex scripts` keeps every test file whose lower-cased path
// relative to the root contains "convex" or "scripts" (Vitest filterFiles).
// The runner test pins this against the real `vitest list` so the two cannot
// drift apart.
const sonarFilters = ["convex", "scripts"];
const sonarCensus = (testFiles) =>
  testFiles.filter((file) => sonarFilters.some((filter) => file.toLowerCase().includes(filter)));

function boundedInteger(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

// SCRUM-752 workload model. Costs only decide which suites get a process of
// their own and which slice runs which batch; they never add or drop a file. A
// file the model does not name costs `defaultFileSeconds`, so a new suite is
// still scheduled, only less precisely.
const workloadPath = path.resolve(root, process.env.AUTOFLOW_COVERAGE_WORKLOAD ?? "scripts/coverageWorkload.json");
const workload = JSON.parse(readFileSync(workloadPath, "utf8"));
const fileSeconds = (file) => workload.files[file] ?? workload.defaultFileSeconds;

function assertWorkloadNamesRealFiles(testFiles) {
  // A stale entry would silently stop isolating whatever replaced it. Only the
  // real repository census is checked; synthetic discovery roots in the runner's
  // own tests name none of these files.
  if (discoveryRoot !== root) return;
  const known = new Set([...testFiles, authorityTest]);
  const stale = Object.keys(workload.files).filter((file) => !known.has(file));
  if (stale.length > 0) {
    throw new Error(`${path.relative(root, workloadPath)} names test files that do not exist: ${stale.join(", ")}`);
  }
}

// Expensive suites (cost >= isolateAtSeconds) each get their own process; the
// rest keep the original sorted, fixed-size batching. Composition depends only
// on the census and the committed workload file, never on the slice.
function batchesOf(files, batchSize) {
  const isolated = files.filter((file) => fileSeconds(file) >= workload.isolateAtSeconds);
  const rest = files.filter((file) => fileSeconds(file) < workload.isolateAtSeconds);
  const batches = isolated.map((file) => [file]);
  for (let offset = 0; offset < rest.length; offset += batchSize) {
    batches.push(rest.slice(offset, offset + batchSize));
  }
  return batches;
}

function workUnits(forMode, testFiles) {
  const processSeconds = workload.processSeconds[forMode];
  const cost = (files) => processSeconds + files.reduce((sum, file) => sum + fileSeconds(file), 0);
  const units = [{ mode: forMode, blob: authorityBlob, files: [authorityTest], cost: cost([authorityTest]), authority: true }];
  if (forMode === "unit") {
    const batchSize = boundedInteger("VITEST_COVERAGE_BATCH_SIZE", "8", 1, 16);
    batchesOf(testFiles, batchSize).forEach((files, index) => {
      units.push({ mode: forMode, blob: `unit-batch-${index + 1}.json`, files, cost: cost(files) });
    });
  } else {
    const batchSize = boundedInteger("VITEST_SONAR_BATCH_SIZE", "32", 1, 64);
    batchesOf(sonarCensus(testFiles), batchSize).forEach((files, index) => {
      units.push({ mode: forMode, blob: `sonar-${index + 1}.json`, files, cost: cost(files) });
    });
  }
  return units;
}

// Slice assignment covers BOTH modes at once, because a slice runs its unit
// share and then its Sonar share: balancing each mode separately can still stack
// two heavy halves on one runner. Largest cost first onto the least-loaded
// slice, ties to the lower slice and then the earlier unit, so every slice
// computes the identical plan. Both authority controls stay on slice 1, which
// also runs the plain authority suite.
function slicePlan(testFiles) {
  const units = [...workUnits("unit", testFiles), ...workUnits("sonar", testFiles)];
  const load = Array.from({ length: sliceCount }, () => 0);
  const owner = new Map();
  for (const unit of units.filter((u) => u.authority)) {
    owner.set(unit, 1);
    load[0] += unit.cost;
  }
  const ordered = units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => !unit.authority)
    .sort((a, b) => b.unit.cost - a.unit.cost || a.index - b.index);
  for (const { unit } of ordered) {
    let target = 0;
    for (let slice = 1; slice < sliceCount; slice += 1) if (load[slice] < load[target]) target = slice;
    owner.set(unit, target + 1);
    load[target] += unit.cost;
  }
  return { units, owner, load };
}

// The merge-phase completeness gate: a missing slice, a slice that stopped
// early, or a stray blob from another run must not reach the merge, because
// Vitest merges whatever blobs it finds and would report the smaller census
// as green.
function assertCompleteBlobSet(units) {
  const expected = units.map((unit) => unit.blob);
  // Every file counts, not only .json: Vitest's merge parses every file in the
  // directory, so the gate must see exactly what the merge will read.
  let present = [];
  try {
    present = readdirSync(blobDir);
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

const census = unitTestCensus();
assertWorkloadNamesRealFiles(census);
const plan = slicePlan(census);
const modeUnits = plan.units.filter((unit) => unit.mode === mode);

rmSync(coverageDir, { recursive: true, force: true });
if (phase === "merge") {
  assertCompleteBlobSet(modeUnits);
} else {
  rmSync(blobDir, { recursive: true, force: true });
  mkdirSync(blobDir, { recursive: true });
}

// Per-process coverage reports are never read: each covered process cleans the
// reports directory, the slices upload only blobs, and the merge regenerates
// every configured reporter from the blobs. Sonar's full-scope text table alone
// printed ~1,500 lines per process, so each process now prints one summary.
const runReporterArgs = ["--coverage.reporter=text-summary"];

if (phase === "run") {
  const mine = modeUnits.filter((unit) => plan.owner.get(unit) === sliceIndex);
  process.stdout.write(
    `Coverage slice ${sliceIndex}/${sliceCount} (${mode}): ${mine.length} of ${modeUnits.length} work units; ` +
      `planned load per slice (s, both modes): ${plan.load.map((l) => Math.round(l)).join(" ")}\n`,
  );
}

if (phase !== "merge") {
  const total = modeUnits.length - 1;
  for (const [index, unit] of modeUnits.entries()) {
    if (phase === "run" && plan.owner.get(unit) !== sliceIndex) continue;
    if (unit.authority) {
      // Negative control for the coverage pipeline itself: the release-critical
      // authority suite must produce a V8 coverage blob on every covered path. It
      // is deliberately isolated so coverage instrumentation cannot reintroduce
      // the long-lived-process OOM that motivated this runner.
      runVitest(
        [
          "run",
          authorityTest,
          ...reporterArgs(path.join(blobDir, authorityBlob)),
          "--coverage",
          coverageReportsArg,
          "--maxWorkers=1",
          ...runReporterArgs,
          ...(mode === "sonar" ? sonarCoverageArgs : thresholdZeroArgs),
        ],
        [],
        unit,
      );
      continue;
    }
    const label = mode === "unit" ? "Coverage batch" : "Sonar coverage batch";
    process.stdout.write(`${label} ${index}/${total}: ${unit.files.join(" ")}\n`);
    runVitest(
      [
        "run",
        ...unit.files,
        ...reporterArgs(path.join(blobDir, unit.blob)),
        ...sharedCoverageArgs,
        coverageReportsArg,
        ...runReporterArgs,
        ...(mode === "sonar" ? sonarCoverageArgs : thresholdZeroArgs),
      ],
      unit.files,
      unit,
    );
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
