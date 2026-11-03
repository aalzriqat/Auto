// SCRUM-752: rebuild scripts/coverageWorkload.json from measured timings.
//
//   gh run download <tests-run-id> --pattern 'coverage-timings-*' --dir <dir>
//   node scripts/rebuildCoverageWorkload.mjs <dir> [<dir> ...] [--write]
//
// Each slice of the Tests workflow uploads one JSON line per Vitest process
// (`coverage-timings-N/slice-N.jsonl`: mode, unit, files, wallSeconds). A line
// holds the wall time of a whole batch, not of each file, so the per-file cost
// is the non-negative solution of
//     wallSeconds(batch) - processSeconds(mode) ~= sum of the cost of its files
// over every line of every run given. Unit and Sonar batches group the same
// files differently and the single-file batches measure a file exactly, which
// is what pins down the files that dominate a batch. The solve is the
// multiplicative (EM) update for non-negative least squares, started from an
// even split of each batch, so it is deterministic and never goes negative.
//
// Only the scheduling inputs change: `defaultFileSeconds` and `files`. The
// runner still runs every file exactly once per mode whatever these numbers
// say, and `isolateAtSeconds`, `processSeconds` and every coverage threshold
// are carried over untouched. Wall times were taken with two batches
// overlapping on one runner, so they include that contention; the planner only
// needs the costs to be comparable with each other.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A file cheaper than this is left to `defaultFileSeconds`, which keeps the
// committed model short and diffable.
const LISTED_AT_SECONDS = 8;
const ITERATIONS = 400;

export function parseTimingLines(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((row) => (row.mode === "unit" || row.mode === "sonar") && Array.isArray(row.files) && row.status === 0);
}

// rows: parsed timing lines, any number of runs. Returns file -> seconds.
export function fitFileSeconds(rows, processSeconds) {
  const equations = rows
    .map((row) => ({
      files: [...new Set(row.files)],
      seconds: Math.max(0, Number(row.wallSeconds) - processSeconds[row.mode]),
    }))
    .filter((equation) => equation.files.length > 0 && Number.isFinite(equation.seconds));
  const memberOf = new Map();
  equations.forEach((equation, index) => {
    for (const file of equation.files) memberOf.set(file, [...(memberOf.get(file) ?? []), index]);
  });
  const cost = new Map();
  for (const [file, indexes] of memberOf) {
    const shares = indexes.map((i) => equations[i].seconds / equations[i].files.length);
    cost.set(file, shares.reduce((a, b) => a + b, 0) / shares.length);
  }
  for (let step = 0; step < ITERATIONS; step += 1) {
    const predicted = equations.map((equation) => equation.files.reduce((sum, file) => sum + cost.get(file), 0));
    for (const [file, indexes] of memberOf) {
      const measured = indexes.reduce((sum, i) => sum + equations[i].seconds, 0);
      const modelled = indexes.reduce((sum, i) => sum + predicted[i], 0);
      if (modelled > 0) cost.set(file, (cost.get(file) * measured) / modelled);
    }
  }
  return cost;
}

export function buildWorkload(previous, cost, fileExists) {
  const known = [...cost].filter(([file]) => fileExists(file));
  const small = known
    .map(([, seconds]) => seconds)
    .filter((seconds) => seconds < LISTED_AT_SECONDS)
    .sort((a, b) => a - b);
  const median = small.length > 0 ? small[Math.floor(small.length / 2)] : previous.defaultFileSeconds;
  const files = Object.fromEntries(
    known
      .map(([file, seconds]) => [file, Math.round(seconds)])
      .filter(([, seconds]) => seconds >= LISTED_AT_SECONDS)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
  return { ...previous, defaultFileSeconds: Math.max(1, Math.round(median)), files };
}

function timingFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return timingFiles(full);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [full] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const directories = args.filter((arg) => arg !== "--write");
  if (directories.length === 0 || directories.some((d) => !existsSync(d) || !statSync(d).isDirectory())) {
    throw new Error("Usage: node scripts/rebuildCoverageWorkload.mjs <timings-dir> [<timings-dir> ...] [--write]");
  }
  const workloadPath = path.resolve(process.env.AUTOFLOW_COVERAGE_WORKLOAD ?? "scripts/coverageWorkload.json");
  const previous = JSON.parse(readFileSync(workloadPath, "utf8"));
  const rows = directories.flatMap(timingFiles).flatMap((file) => parseTimingLines(readFileSync(file, "utf8")));
  if (rows.length === 0) throw new Error("No successful timing lines found.");
  const next = buildWorkload(previous, fitFileSeconds(rows, previous.processSeconds), (file) => existsSync(file));
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (write) writeFileSync(workloadPath, text);
  else process.stdout.write(text);
  process.stderr.write(`${rows.length} timing lines -> ${Object.keys(next.files).length} listed files (default ${next.defaultFileSeconds}s)\n`);
}
