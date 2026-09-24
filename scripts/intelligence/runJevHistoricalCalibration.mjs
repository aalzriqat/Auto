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

function listMetric(values) {
  return values.length === 0 ? "(none)" : values.join(", ");
}

function publicTrack(track) {
  if (track.status === "COMPLETE") {
    return {
      status: track.status,
      model: track.model,
      usage: track.usage,
      risks: track.risks,
      invariantImpact: track.invariantImpact,
      reviewMatrix: track.reviewMatrix,
      latencyMs: track.latencyMs,
    };
  }
  return {
    status: track.status,
    reason: track.reason,
    latencyMs: track.latencyMs,
  };
}

function publicCaseResult(result, score) {
  return {
    caseId: result.caseId,
    ...(result.caseExecutionFailure ? { caseExecutionFailure: true } : {}),
    snapshotAt: result.snapshotAt,
    baseSha: result.baseSha,
    headSha: result.headSha,
    changedFiles: result.changedFiles,
    patchTruncated: result.patchTruncated,
    patchCharsSent: result.patchCharsSent,
    deterministicImpact: result.deterministicImpact,
    deterministicReviewMatrix: result.deterministicReviewMatrix,
    blind: publicTrack(result.blind),
    policy: publicTrack(result.policy),
    score,
  };
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
    `Blind Jev scrutiny recall: ${percent(metrics.blindJevHighCriticalRecall)}`,
    `Blind Jev escalation recall: ${percent(metrics.blindJevHighCriticalEscalationRecall)}`,
    `Current-policy Jev scrutiny recall: ${percent(metrics.currentPolicyJevHighCriticalRecall)}`,
    `Current-policy Jev escalation recall: ${percent(metrics.currentPolicyJevHighCriticalEscalationRecall)}`,
    `Operational combined recall: ${percent(metrics.operationalCombinedHighCriticalRecall)}`,
    `Incremental blind Jev hits: ${metrics.incrementalBlindJevHits}`,
    `Incremental current-policy Jev hits: ${metrics.incrementalPolicyJevHits}`,
    `Blind extra review requirements: ${metrics.blindExtraReviewRequirements} — ${listMetric(metrics.uniqueBlindExtraReviewRequirements)}`,
    `Current-policy extra review requirements: ${metrics.policyExtraReviewRequirements} — ${listMetric(metrics.uniquePolicyExtraReviewRequirements)}`,
    `Blind track availability: ${percent(metrics.blindTrackAvailabilityRate)}`,
    `Policy track availability: ${percent(metrics.policyTrackAvailabilityRate)}`,
    `Unavailable tracks: ${metrics.unavailableTracks}`,
    `Failed case executions: ${payload.failedCaseIds.length} — ${listMetric(payload.failedCaseIds)}`,
    `Blind negative-control added-review rate: ${percent(metrics.blindNegativeControlAddedReviewRate)}`,
    `Blind negative-control escalation rate: ${percent(metrics.blindNegativeControlEscalationRate)}`,
    `Policy negative-control added-review rate: ${percent(metrics.policyNegativeControlAddedReviewRate)}`,
    `Policy negative-control escalation rate: ${percent(metrics.policyNegativeControlEscalationRate)}`,
    `Blind input/output tokens: ${metrics.usage.blind_input_tokens}/${metrics.usage.blind_output_tokens}`,
    `Policy input/output tokens: ${metrics.usage.policy_input_tokens}/${metrics.usage.policy_output_tokens}`,
    `Blind/policy Jev latency: ${metrics.latency.blind_ms}/${metrics.latency.policy_ms} ms`,
    "",
    "This report is calibration evidence only. It cannot remove or waive any deterministic AutoFlow gate.",
  ];
  return `${lines.join("\n")}\n`;
}

function unavailableCaseTrack() {
  return {
    status: "UNAVAILABLE",
    reason: "CASE_EXECUTION_FAILED",
    usage: null,
    risks: null,
    invariantImpact: null,
    reviewMatrix: null,
    latencyMs: 0,
  };
}

function failedCaseResult(calibrationCase) {
  return {
    caseId: calibrationCase.id,
    snapshotAt: calibrationCase.snapshotAt,
    baseSha: calibrationCase.baseSha,
    headSha: calibrationCase.headSha,
    changedFiles: [],
    patchTruncated: false,
    patchCharsSent: 0,
    deterministicImpact: [],
    deterministicReviewMatrix: {
      deterministicRequirements: [],
      jevAdvisoryRequirements: [],
      combinedRequirements: [],
      candidateInvariants: [],
    },
    blind: unavailableCaseTrack(),
    policy: unavailableCaseTrack(),
    caseExecutionFailure: true,
  };
}

/**
 * @param {{
 *   repoRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   cases?: Array<{id: string, prNumber: number, baseSha: string, headSha: string, snapshotAt: string}>,
 *   runCase?: typeof runHistoricalCalibrationCase,
 *   loadLabels?: () => Promise<{JEV_CALIBRATION_LABELS: Record<string, any>}>,
 * }} options
 */
export async function runJevHistoricalCalibration({
  repoRoot = process.cwd(),
  env = process.env,
  cases = JEV_CALIBRATION_CASES,
  runCase = runHistoricalCalibrationCase,
  loadLabels = () => import("./jevCalibrationLabels.mjs"),
} = {}) {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for historical calibration");

  const results = [];
  const failedCaseIds = [];
  for (const calibrationCase of cases) {
    try {
      results.push(
        await runCase({
          repoRoot,
          calibrationCase,
          apiKey,
        }),
      );
    } catch {
      // Provenance/setup failures happen before a Jev track exists. Preserve
      // evidence without copying exception text (which can contain paths,
      // credentials, or untrusted git output) and keep evaluating later cases.
      results.push(failedCaseResult(calibrationCase));
      failedCaseIds.push(calibrationCase.id);
    }
  }

  // Load hindsight labels only after every blind + policy Jev request/case attempt has completed.
  const { JEV_CALIBRATION_LABELS } = await loadLabels();
  const scoredCases = results.map((result) => {
    const label = JEV_CALIBRATION_LABELS[result.caseId];
    if (!label) throw new Error(`Missing calibration label for ${result.caseId}`);
    return scoreCalibrationCase(result, label);
  });
  const metrics = aggregateCalibration(scoredCases, results);
  let status = "CALIBRATION_COMPLETE";
  if (failedCaseIds.length > 0) {
    status = "CALIBRATION_FAILED_WITH_EVIDENCE";
  } else if (metrics.unavailableTracks > 0) {
    status = "CALIBRATION_COMPLETE_WITH_UNAVAILABLE";
  }

  const payload = {
    status,
    failedCaseIds,
    authority:
      "Calibration may tune advisory routing thresholds only. It cannot remove deterministic proof obligations or correctness gates.",
    hindsightBoundary:
      "Blind Jev calls used generic risk questions only; current invariant policy and finding labels were excluded. Finding labels were imported only after all blind and policy calls completed.",
    metrics,
    cases: results.map((result, index) =>
      publicCaseResult(result, scoredCases[index]),
    ),
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
    `Jev historical calibration: ${payload.status}; blind scrutiny recall ${percent(metrics.blindJevHighCriticalRecall)}; blind escalation recall ${percent(metrics.blindJevHighCriticalEscalationRecall)}; operational combined recall ${percent(metrics.operationalCombinedHighCriticalRecall)}\n`,
  );
  return payload;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const payload = await runJevHistoricalCalibration();
  if (payload.metrics.unavailableTracks > 0) {
    process.exitCode = 2;
  }
}
