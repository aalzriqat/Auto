#!/usr/bin/env node
/**
 * SCRUM-552 - merge the packages/shared vitest LCOV into the single report
 * Sonar reads.
 *
 * `sonar.javascript.lcov.reportPaths` names only `coverage/lcov.info` (the root
 * vitest report, which excludes `packages/**`). Shared coverage is produced by
 * `pnpm shared:coverage:sonar` into `packages/shared/coverage-sonar/lcov.info`
 * (repo-relative `SF:` paths via `projectRoot`); this script appends those
 * records to the root report. Mirrors appendMobileLcov.mjs (SCRUM-293).
 *
 * It fails closed: a missing, empty, record-less or out-of-scope report stops
 * here rather than silently dropping shared coverage or poisoning the artifact.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SHARED_SOURCE_PREFIX = "packages/shared/src/";
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * Repo-relative, forward-slash path under packages/shared/src/ (exact
 * directory), with no control characters and no "", "." or ".." segment.
 */
export function isSharedSourcePath(source) {
  if (CONTROL_CHAR.test(source)) return false;
  if (!source.startsWith(SHARED_SOURCE_PREFIX)) return false;
  return !source.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export function appendSharedLcov({ sharedLcovPath, targetLcovPath }) {
  if (!existsSync(sharedLcovPath)) {
    throw new Error(`Shared LCOV is missing: ${sharedLcovPath}`);
  }
  const raw = readFileSync(sharedLcovPath, "utf8");
  if (raw.trim() === "") {
    throw new Error(`Shared LCOV is empty: ${sharedLcovPath}`);
  }

  // Normalise Windows separators so the emitted records are always "/".
  const lines = raw.split(/\r?\n/).map((line) =>
    line.startsWith("SF:") ? `SF:${line.slice(3).replaceAll("\\", "/")}` : line,
  );
  const sources = lines.filter((line) => line.startsWith("SF:")).map((line) => line.slice(3));
  if (sources.length === 0) {
    throw new Error(`Shared LCOV has no SF records: ${sharedLcovPath}`);
  }
  const bad = sources.find((source) => !isSharedSourcePath(source));
  if (bad !== undefined) {
    throw new Error(`Shared LCOV has a source outside packages/shared/src/: ${JSON.stringify(bad)}`);
  }
  if (!existsSync(targetLcovPath)) {
    throw new Error(`Target LCOV is missing: ${targetLcovPath}`);
  }

  const body = lines.join("\n").replace(/\n+$/, "\n");
  const existing = readFileSync(targetLcovPath, "utf8");
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(targetLcovPath, separator + body);
  return sources.length;
}

/** CLI body: returns the process exit code so it can be tested without exiting. */
export function main(root) {
  try {
    const count = appendSharedLcov({
      sharedLcovPath: path.join(root, "packages", "shared", "coverage-sonar", "lcov.info"),
      targetLcovPath: path.join(root, "coverage", "lcov.info"),
    });
    console.log(`Appended ${count} shared LCOV records to coverage/lcov.info`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  process.exit(main(path.resolve(path.dirname(here), "..")));
}
