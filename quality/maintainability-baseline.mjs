import { isDeepStrictEqual } from "node:util";

import {
  PARSER_VERSION,
  fileViolationMetrics,
  functionViolationMetrics,
  sha256,
  structuralSimilarity,
  thresholdFor,
} from "./maintainability-metrics.mjs";
import {
  SCOPE_DESCRIPTOR,
  STRUCTURAL_SIMILARITY_FLOOR,
  THRESHOLDS,
} from "./maintainability-paths.mjs";

const BASELINE_SCHEMA_VERSION = 1;
const SCOPE_HASH = sha256(JSON.stringify(SCOPE_DESCRIPTOR));

export function createBaseline(sourceCommit, analysis) {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error(
      "A baseline source commit must be a full 40-character SHA.",
    );
  }
  const files = [];
  for (const file of [...analysis.files].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const metrics = fileViolationMetrics(file);
    const functions = file.functions
      .map((fn) => ({
        anchor: fn.anchor,
        semanticHash: fn.semanticHash,
        metrics: functionViolationMetrics(file.path, fn.metrics),
      }))
      .filter((fn) => Object.keys(fn.metrics).length > 0)
      .sort(
        (left, right) =>
          left.anchor.localeCompare(right.anchor) ||
          left.semanticHash.localeCompare(right.semanticHash),
      );
    if (Object.keys(metrics).length || functions.length) {
      files.push({
        path: file.path,
        semanticHash: file.semanticHash,
        metrics,
        functions,
      });
    }
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    engine: {
      name: "autoflow-maintainability",
      version: 1,
      parserVersion: PARSER_VERSION,
    },
    sourceCommit,
    scopeHash: SCOPE_HASH,
    thresholds: { ...THRESHOLDS },
    files,
  };
}

export function canonicalBaselineText(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

function platformNeutralBaselineText(rawText) {
  const withoutWindowsNewlines = rawText.replaceAll("\r\n", "\n");
  if (withoutWindowsNewlines.includes("\r")) {
    throw new Error(
      "Maintainability baseline contains a non-canonical carriage return.",
    );
  }
  return withoutWindowsNewlines;
}

export function validateBaselineDocument(
  baseline,
  sourceAnalysis,
  rawText = null,
) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("Maintainability baseline must be a JSON object.");
  }
  if (!/^[0-9a-f]{40}$/u.test(baseline.sourceCommit ?? "")) {
    throw new Error("Maintainability baseline has an invalid sourceCommit.");
  }
  if (sourceAnalysis.sourceCommit !== baseline.sourceCommit) {
    throw new Error("Baseline analysis does not match its sourceCommit.");
  }
  const expected = createBaseline(baseline.sourceCommit, sourceAnalysis);
  if (!isDeepStrictEqual(baseline, expected)) {
    throw new Error(
      "Maintainability baseline does not exactly match recomputed source debt.",
    );
  }
  if (
    rawText !== null &&
    platformNeutralBaselineText(rawText) !== canonicalBaselineText(expected)
  ) {
    throw new Error("Maintainability baseline JSON is not canonical.");
  }
  return expected;
}

function exactHashMatches(
  currentEntities,
  baselineEntities,
  matches,
  consumed,
) {
  const availableByHash = new Map();
  for (const baseline of baselineEntities) {
    if (consumed.has(baseline)) continue;
    const available = availableByHash.get(baseline.semanticHash) ?? [];
    available.push(baseline);
    availableByHash.set(baseline.semanticHash, available);
  }
  for (const current of currentEntities) {
    if (matches.has(current)) continue;
    const baseline = availableByHash.get(current.semanticHash)?.shift();
    if (baseline) {
      matches.set(current, baseline);
      consumed.add(baseline);
    }
  }
}

function structuralFallbackMatches(
  currentEntities,
  baselineEntities,
  matches,
  consumed,
) {
  const candidates = [];
  for (
    let currentIndex = 0;
    currentIndex < currentEntities.length;
    currentIndex += 1
  ) {
    const current = currentEntities[currentIndex];
    if (matches.has(current)) continue;
    for (
      let baselineIndex = 0;
      baselineIndex < baselineEntities.length;
      baselineIndex += 1
    ) {
      const baseline = baselineEntities[baselineIndex];
      if (consumed.has(baseline)) continue;
      const similarity = structuralSimilarity(
        current.structureTokens,
        baseline.structureTokens,
      );
      if (similarity >= STRUCTURAL_SIMILARITY_FLOOR) {
        candidates.push({
          current,
          baseline,
          currentIndex,
          baselineIndex,
          similarity,
        });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.currentIndex - right.currentIndex ||
      left.baselineIndex - right.baselineIndex,
  );
  for (const candidate of candidates) {
    if (matches.has(candidate.current) || consumed.has(candidate.baseline))
      continue;
    matches.set(candidate.current, candidate.baseline);
    consumed.add(candidate.baseline);
  }
}

function matchFiles(currentFiles, baselineFiles) {
  const matches = new Map();
  const consumed = new Set();
  const baselineByPath = new Map(
    baselineFiles.map((file) => [file.path, file]),
  );
  for (const current of currentFiles) {
    const baseline = baselineByPath.get(current.path);
    if (!baseline) continue;
    consumed.add(baseline);
    if (
      structuralSimilarity(current.structureTokens, baseline.structureTokens) >=
      STRUCTURAL_SIMILARITY_FLOOR
    ) {
      matches.set(current, baseline);
    }
  }
  exactHashMatches(currentFiles, baselineFiles, matches, consumed);
  structuralFallbackMatches(currentFiles, baselineFiles, matches, consumed);
  return matches;
}

function analyzedFunctions(analysis) {
  const functions = [];
  for (const file of analysis.files) {
    for (const fn of file.functions) {
      const violations = functionViolationMetrics(file.path, fn.metrics);
      functions.push({ ...fn, path: file.path, violations });
    }
  }
  return functions.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.anchor.localeCompare(right.anchor),
  );
}

function matchFunctions(currentFunctions, baselineFunctions) {
  const matches = new Map();
  const consumed = new Set();
  const baselineByIdentity = new Map(
    baselineFunctions.map((fn) => [`${fn.path}\u0000${fn.anchor}`, fn]),
  );
  for (const current of currentFunctions) {
    const baseline = baselineByIdentity.get(
      `${current.path}\u0000${current.anchor}`,
    );
    if (!baseline) continue;
    consumed.add(baseline);
    if (
      structuralSimilarity(current.structureTokens, baseline.structureTokens) >=
      STRUCTURAL_SIMILARITY_FLOOR
    ) {
      matches.set(current, baseline);
    }
  }
  exactHashMatches(currentFunctions, baselineFunctions, matches, consumed);
  structuralFallbackMatches(
    currentFunctions,
    baselineFunctions,
    matches,
    consumed,
  );
  return matches;
}

function metricIssues(entity, currentMetrics, baselineMetrics, identity) {
  const issues = [];
  for (const [metric, current] of Object.entries(currentMetrics)) {
    const limit = thresholdFor(entity, metric);
    const baseline = baselineMetrics?.[metric];
    if (baseline === undefined) {
      issues.push({
        kind: "NEW_MAINTAINABILITY_VIOLATION",
        entity,
        ...identity,
        metric,
        current,
        limit,
      });
    } else if (current > baseline) {
      issues.push({
        kind: "LEGACY_DEBT_WORSENED",
        entity,
        ...identity,
        metric,
        current,
        baseline,
        limit,
        delta: current - baseline,
      });
    }
  }
  return issues;
}

function compareIssues(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    (left.anchor ?? "").localeCompare(right.anchor ?? "") ||
    left.metric.localeCompare(right.metric)
  );
}

function issueIdentity(issue) {
  return JSON.stringify([
    issue.entity,
    issue.path,
    issue.anchor ?? null,
    issue.metric,
  ]);
}

export function combineRatchetComparisons(currentVsSource, currentVsOrigin) {
  const issuesByIdentity = new Map(
    currentVsSource.issues.map((issue) => [issueIdentity(issue), issue]),
  );
  for (const issue of currentVsOrigin.issues) {
    issuesByIdentity.set(issueIdentity(issue), issue);
  }
  const issues = [...issuesByIdentity.values()].sort(compareIssues);
  return { ok: issues.length === 0, issues };
}

export function compareAnalyses(currentAnalysis, baselineAnalysis) {
  const currentFiles = [...currentAnalysis.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const violatingCurrentFiles = currentFiles.filter(
    (file) => Object.keys(fileViolationMetrics(file)).length,
  );
  const baselineFiles = baselineAnalysis.files
    .filter((file) => Object.keys(fileViolationMetrics(file)).length)
    .sort((left, right) => left.path.localeCompare(right.path));
  const fileMatches = matchFiles(currentFiles, baselineFiles);
  const issues = [];
  for (const current of violatingCurrentFiles) {
    const baseline = fileMatches.get(current);
    issues.push(
      ...metricIssues(
        "file",
        fileViolationMetrics(current),
        baseline ? fileViolationMetrics(baseline) : null,
        { path: current.path },
      ),
    );
  }

  const currentFunctions = analyzedFunctions(currentAnalysis);
  const violatingCurrentFunctions = currentFunctions.filter(
    (fn) => Object.keys(fn.violations).length,
  );
  const baselineFunctions = analyzedFunctions(baselineAnalysis).filter(
    (fn) => Object.keys(fn.violations).length,
  );
  const functionMatches = matchFunctions(currentFunctions, baselineFunctions);
  for (const current of violatingCurrentFunctions) {
    const baseline = functionMatches.get(current);
    issues.push(
      ...metricIssues(
        "function",
        current.violations,
        baseline?.violations ?? null,
        { path: current.path, anchor: current.anchor },
      ),
    );
  }
  issues.sort(compareIssues);
  return { ok: issues.length === 0, issues };
}
