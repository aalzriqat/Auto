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
    "Primary blind track: generic risk questions only; no current invariant statements or finding labels.",
    "Secondary policy track: today's full AutoFlow invariant policy replayed against the same historical diff.",
    "Finding labels are loaded only after every Jev call completes.",
    "",
    `Cases: ${metrics.cases}`,
    `High/Critical findings: ${metrics.highCriticalFindings}`,
    `Current deterministic replay recall: ${percent(metrics.currentDeterministicReplayRecall)}`,
    `Blind Jev recall: ${percent(metrics.blindJevHighCriticalRecall)}`,
    `Current-policy Jev recall: ${percent(metrics.currentPolicyJevHighCriticalRecall)}`,
    `Operational combined recall: ${percent(metrics.operationalCombinedHighCriticalRecall)}`,
    `Incremental blind Jev hits: ${metrics.incrementalBlindJevHits}`,
    `Blind negative-control added-review rate: ${percent(metrics.blindNegativeControlAddedReviewRate)}`,
    `Blind negative-control escalation rate: ${percent(metrics.blindNegativeControlEscalationRate)}`,
    `Policy negative-control added-review rate: ${percent(metrics.policyNegativeControlAddedReviewRate)}`,
    `Blind input/output tokens: ${metrics.usage.blind_input_tokens}/${metrics.usage.blind_output_tokens}`,
    `Policy input/output tokens: ${metrics.usage.policy_input_tokens}/${metrics.usage.policy_output_tokens}`,
    `Blind/policy Jev latency: ${metrics.latency.blind_ms}/${metrics.latency.policy_ms} ms`,
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

  // Load hindsight labels only after every blind + policy Jev request has completed.
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
      "Blind Jev calls used generic risk questions only; current invariant policy and finding labels were excluded. Finding labels were imported only after all blind and policy calls completed.",
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
    `Jev historical calibration: ${payload.status}; blind High/Critical recall ${percent(metrics.blindJevHighCriticalRecall)}; operational combined recall ${percent(metrics.operationalCombinedHighCriticalRecall)}\n`,
  );
  return payload;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runJevHistoricalCalibration();
}
