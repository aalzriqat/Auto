/**
 * Shared core of appendMobileLcov.mjs (SCRUM-293) and appendSharedLcov.mjs
 * (SCRUM-552): append one workspace's LCOV records to the single report Sonar
 * reads (`coverage/lcov.info`), failing closed.
 *
 * The trusted PR report refuses any `SF:` path outside its allowlist, so a
 * malformed workspace report must stop here, loudly, rather than silently drop
 * coverage or poison the artifact.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * Repo-relative, forward-slash path under one of `prefixes` (each an exact
 * directory ending in "/"), with no control characters and no "", "." or ".."
 * segment.
 */
export function isScopedSourcePath(source, prefixes) {
  if (CONTROL_CHAR.test(source)) return false;
  if (!prefixes.some((prefix) => source.startsWith(prefix))) return false;
  return !source.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** Returns the number of SF records appended. `label` prefixes error texts, e.g. "Mobile". */
export function appendScopedLcov({ label, prefixes, sourceLcovPath, targetLcovPath }) {
  if (!existsSync(sourceLcovPath)) {
    throw new Error(`${label} LCOV is missing: ${sourceLcovPath}`);
  }
  const raw = readFileSync(sourceLcovPath, "utf8");
  if (raw.trim() === "") {
    throw new Error(`${label} LCOV is empty: ${sourceLcovPath}`);
  }

  // Normalise Windows separators so the emitted records are always "/".
  const lines = raw.split(/\r?\n/).map((line) =>
    line.startsWith("SF:") ? `SF:${line.slice(3).replaceAll("\\", "/")}` : line,
  );
  const sources = lines.filter((line) => line.startsWith("SF:")).map((line) => line.slice(3));
  if (sources.length === 0) {
    throw new Error(`${label} LCOV has no SF records: ${sourceLcovPath}`);
  }
  const bad = sources.find((source) => !isScopedSourcePath(source, prefixes));
  if (bad !== undefined) {
    throw new Error(`${label} LCOV has a source outside ${prefixes.join(" or ")}: ${JSON.stringify(bad)}`);
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
export function runAppend(options) {
  try {
    const count = appendScopedLcov(options);
    console.log(`Appended ${count} ${options.label.toLowerCase()} LCOV records to coverage/lcov.info`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}
