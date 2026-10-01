#!/usr/bin/env node
/**
 * SCRUM-293 - merge the mobile jest LCOV into the single report Sonar reads.
 *
 * `sonar.javascript.lcov.reportPaths` names only `coverage/lcov.info` (the root
 * vitest report, which excludes `apps/**`). Mobile coverage is produced by
 * `pnpm mobile:coverage:sonar` into `apps/mobile/coverage-sonar/lcov.info`; this
 * script appends those records to the root report. The fail-closed logic lives
 * in appendScopedLcov.mjs, shared with appendSharedLcov.mjs.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { appendScopedLcov, isScopedSourcePath, runAppend } from "./appendScopedLcov.mjs";

const MOBILE_SOURCE_PREFIXES = ["apps/mobile/src/", "apps/mobile/app/"];

export function isMobileSourcePath(source) {
  return isScopedSourcePath(source, MOBILE_SOURCE_PREFIXES);
}

export function appendMobileLcov({ mobileLcovPath, targetLcovPath }) {
  return appendScopedLcov({
    label: "Mobile",
    prefixes: MOBILE_SOURCE_PREFIXES,
    sourceLcovPath: mobileLcovPath,
    targetLcovPath,
  });
}

/** CLI body: returns the process exit code so it can be tested without exiting. */
export function main(root) {
  return runAppend({
    label: "Mobile",
    prefixes: MOBILE_SOURCE_PREFIXES,
    sourceLcovPath: path.join(root, "apps", "mobile", "coverage-sonar", "lcov.info"),
    targetLcovPath: path.join(root, "coverage", "lcov.info"),
  });
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  process.exit(main(path.resolve(path.dirname(here), "..")));
}
