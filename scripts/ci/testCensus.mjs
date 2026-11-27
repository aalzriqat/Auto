import { readdirSync } from "node:fs";
import path from "node:path";

// The unit/integration test census, shared by the coverage runner
// (scripts/runVitestCoverageShards.mjs) and the PR test selector
// (scripts/ci/selectUnitTests.mjs) so the two cannot disagree about which files
// exist. Relative, forward-slash paths; the caller decides what to exclude.
export const excludedDirs = new Set([
  "node_modules",
  ".next",
  "out",
  "build",
  "apps",
  "packages",
  ".claude",
  ".git",
]);

export function collectTestFiles(directory, relative = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) continue;
      files.push(
        ...collectTestFiles(path.join(directory, entry.name), relative ? `${relative}/${entry.name}` : entry.name),
      );
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.test\.tsx?$/.test(entry.name)) continue;
    files.push(relative ? `${relative}/${entry.name}` : entry.name);
  }
  return files;
}
