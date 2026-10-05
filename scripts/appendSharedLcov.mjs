#!/usr/bin/env node
/**
 * SCRUM-552 - merge the packages/shared vitest LCOV into the single report
 * Sonar reads.
 *
 * `sonar.javascript.lcov.reportPaths` names only `coverage/lcov.info` (the root
 * vitest report, which excludes `packages/**`). Shared coverage is produced by
 * `pnpm shared:coverage:sonar` into `packages/shared/coverage-sonar/lcov.info`
 * (repo-relative `SF:` paths via `projectRoot`); this script appends those
 * records to the root report. The fail-closed logic lives in
 * appendScopedLcov.mjs, shared with appendMobileLcov.mjs.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { appendScopedLcov, isScopedSourcePath, runAppend } from "./appendScopedLcov.mjs";

const SHARED_SOURCE_PREFIXES = ["packages/shared/src/"];

export function isSharedSourcePath(source) {
  return isScopedSourcePath(source, SHARED_SOURCE_PREFIXES);
}

export function appendSharedLcov({ sharedLcovPath, targetLcovPath }) {
  return appendScopedLcov({
    label: "Shared",
    prefixes: SHARED_SOURCE_PREFIXES,
    sourceLcovPath: sharedLcovPath,
    targetLcovPath,
  });
}

/** CLI body: returns the process exit code so it can be tested without exiting. */
export function main(root) {
  return runAppend({
    label: "Shared",
    prefixes: SHARED_SOURCE_PREFIXES,
    sourceLcovPath: path.join(root, "packages", "shared", "coverage-sonar", "lcov.info"),
    targetLcovPath: path.join(root, "coverage", "lcov.info"),
  });
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  process.exit(main(path.resolve(path.dirname(here), "..")));
}
