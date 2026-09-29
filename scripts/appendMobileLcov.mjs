#!/usr/bin/env node
/**
 * SCRUM-293 - merge the mobile jest LCOV into the single report Sonar reads.
 *
 * `sonar.javascript.lcov.reportPaths` names only `coverage/lcov.info` (the root
 * vitest report, which excludes `apps/**`). Mobile coverage is produced by
 * `pnpm mobile:coverage:sonar` into `apps/mobile/coverage-sonar/lcov.info`; this
 * script appends those records to the root report.
 *
 * It fails closed. The trusted PR report refuses any `SF:` path outside its
 * allowlist, so a malformed mobile report must stop here, loudly, rather than
 * silently drop mobile coverage or poison the artifact.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MOBILE_SOURCE_PREFIXES = ["apps/mobile/src/", "apps/mobile/app/"];
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * Repo-relative, forward-slash path under apps/mobile/src/ or apps/mobile/app/
 * (exact directories, so apps/mobile/appx/ is refused), with no control
 * characters and no "", "." or ".." segment.
 */
export function isMobileSourcePath(source) {
  if (CONTROL_CHAR.test(source)) return false;
  if (!MOBILE_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix))) return false;
  return !source.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export function appendMobileLcov({ mobileLcovPath, targetLcovPath }) {
  if (!existsSync(mobileLcovPath)) {
    throw new Error(`Mobile LCOV is missing: ${mobileLcovPath}`);
  }
  const raw = readFileSync(mobileLcovPath, "utf8");
  if (raw.trim() === "") {
    throw new Error(`Mobile LCOV is empty: ${mobileLcovPath}`);
  }

  // Normalise Windows separators so the emitted records are always "/".
  const lines = raw.split(/\r?\n/).map((line) =>
    line.startsWith("SF:") ? `SF:${line.slice(3).replaceAll("\\", "/")}` : line,
  );
  const sources = lines.filter((line) => line.startsWith("SF:")).map((line) => line.slice(3));
  if (sources.length === 0) {
    throw new Error(`Mobile LCOV has no SF records: ${mobileLcovPath}`);
  }
  const bad = sources.find((source) => !isMobileSourcePath(source));
  if (bad !== undefined) {
    throw new Error(`Mobile LCOV has a source outside apps/mobile/src/ or apps/mobile/app/: ${JSON.stringify(bad)}`);
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
    const count = appendMobileLcov({
      mobileLcovPath: path.join(root, "apps", "mobile", "coverage-sonar", "lcov.info"),
      targetLcovPath: path.join(root, "coverage", "lcov.info"),
    });
    console.log(`Appended ${count} mobile LCOV records to coverage/lcov.info`);
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