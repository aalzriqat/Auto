#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

export {
  canonicalBaselineText,
  combineRatchetComparisons,
  compareAnalyses,
  createBaseline,
  validateBaselineDocument,
} from "./maintainability-baseline.mjs";
export {
  analyzeSource,
  analyzeSourceEntries,
  debtCounts,
  structuralSimilarity,
} from "./maintainability-metrics.mjs";
export {
  DEFAULT_BASELINE_PATH,
  STRUCTURAL_SIMILARITY_FLOOR,
  THRESHOLDS,
  inventoryProductionPaths,
  isMigrationOrSeedPath,
  normalizeRepositoryPath,
} from "./maintainability-paths.mjs";
export {
  analyzeCommit,
  analyzeWorkingTree,
  assertBaselineProvenance,
  formatMaintainabilityIssue,
  repositoryRoot,
  resolveCommit,
  runCli,
} from "./maintainability-cli.mjs";

import { runCli } from "./maintainability-cli.mjs";

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(`Maintainability check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
