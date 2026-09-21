import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JEV_CALIBRATION_CASES } from "./jevCalibrationCases.mjs";
import {
  aggregateCalibration,
  runHistoricalCalibrationCase,
  scoreCalibrationCase,
} from "./jevCalibration.mjs";

function percent(value) {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function summaryMarkdown(payload) {
  const metrics = payload.metrics;
  const lines = [
    "## Jev Historical Calibration",
    "",
    `**Status:** ${payload.status}`,
    "",
    "Hindsight boundary: historical finding labels are loaded only after all Jev calls complete.",
    "",
    `Cases: ${metrics.cases}`,
    `High/Critical findings: ${metrics.highCriticalFindings}`,
    `Deterministic recall: ${percent(metrics.deterministicHighCriticalRecall)}`,
    `Jev recall: ${percent(metrics.jevHighCriticalRecall)}`,
    `Combined recall: ${percent(metrics.combinedHighCriticalRecall)}`,
    `Incremental Jev hits: ${metrics.incrementalJevHits}`,
    `Extra review requirements: ${metrics.extraReviewRequirements}`,
    `Negative-control added-review rate: ${percent(metrics.negativeControlAddedReviewRate)}`,
    `Negative-control escalation rate: ${percent(metrics.negativeControlEscalationRate)}`,
    `Input tokens: ${metrics.usage.input_tokens}`,
    `Output tokens: ${metrics.usage.output_tokens}`,
    `Total Jev latency: ${metrics.totalLatencyMs} ms`,
    "",
    "This report is calibration evidence only. It cannot remove or waive any deterministic AutoFlow gate.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runJevHistoricalCalibration({
  repoRoot = process.cwd(),
  env = process.env,
  cases = JEV_CALIBRATION_CASES,
} = {}) {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for historical calibration");

  const results = [];
  for (const calibrationCase of cases) {
    results.push(
      await runHistoricalCalibrationCase({
        repoRoot,
        calibrationCase,
        apiKey,
      }),
    );
  }

  // Load hindsight labels only after every Jev request has completed.
  const { JEV_CALIBRATION_LABELS } = await import("./jevCalibrationLabels.mjs");
  const scoredCases = results.map((result) => {
    const label = JEV_CALIBRATION_LABELS[result.caseId];
    if (!label) throw new Error(`Missing calibration label for ${result.caseId}`);
    return scoreCalibrationCase(result, label);
  });
  const metrics = aggregateCalibration(scoredCases, results);
  const payload = {
    status: "CALIBRATION_COMPLETE",
    authority:
      "Calibration may tune advisory routing thresholds only. It cannot remove deterministic proof obligations or correctness gates.",
    hindsightBoundary:
      "Finding labels were not imported until all Jev calls completed.",
    metrics,
    cases: results.map((result, index) => ({
      ...result,
      score: scoredCases[index],
    })),
  };

  const outputDir = path.join(repoRoot, "artifacts");
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDir, "jev-historical-calibration.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(outputDir, "jev-historical-calibration.md"),
      summaryMarkdown(payload),
      "utf8",
    ),
  ]);
  process.stdout.write(
    `Jev historical calibration: ${payload.status}; combined High/Critical recall ${percent(metrics.combinedHighCriticalRecall)}\n`,
  );
  return payload;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runJevHistoricalCalibration();
}
