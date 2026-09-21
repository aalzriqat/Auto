import {
  DEFAULT_CANDIDATE_THRESHOLD,
  buildChangeState,
  buildJevQuestions,
  callJev,
  deriveReviewMatrix,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
  extraDeterministicRequirementsForFiles,
  normalizeJevResponse,
} from "./jevImpact.mjs";

const DEFAULT_RUNTIME = Object.freeze({
  buildChangeState,
  buildJevQuestions,
  callJev,
  deriveReviewMatrix,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
  extraDeterministicRequirementsForFiles,
  normalizeJevResponse,
});

function assertCalibrationCase(calibrationCase) {
  if (!calibrationCase || typeof calibrationCase !== "object") {
    throw new Error("Calibration case is required");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(calibrationCase.id ?? "")) {
    throw new Error("Calibration case id must be a stable lowercase slug");
  }
  if (!/^[0-9a-f]{40}$/i.test(calibrationCase.baseSha ?? "")) {
    throw new Error(`Calibration case ${calibrationCase.id} has an invalid base SHA`);
  }
  if (!/^[0-9a-f]{40}$/i.test(calibrationCase.headSha ?? "")) {
    throw new Error(`Calibration case ${calibrationCase.id} has an invalid head SHA`);
  }
}

export function buildCalibrationObservation({
  repoRoot = process.cwd(),
  calibrationCase,
  runtimeOverrides = {},
} = {}) {
  assertCalibrationCase(calibrationCase);
  const runtime = { ...DEFAULT_RUNTIME, ...runtimeOverrides };
  const invariants = runtime.extractCanonicalInvariants(repoRoot);
  const change = runtime.buildChangeState({
    repoRoot,
    baseSha: calibrationCase.baseSha,
    headSha: calibrationCase.headSha,
  });
  const deterministicImpact = runtime.deterministicInvariantImpact(
    change.changedFiles,
    invariants,
  );
  const extraDeterministicRequirements =
    runtime.extraDeterministicRequirementsForFiles(change.changedFiles);

  return {
    caseId: calibrationCase.id,
    baseSha: calibrationCase.baseSha,
    headSha: calibrationCase.headSha,
    changedFiles: change.changedFiles,
    patchTruncated: change.patchTruncated,
    patchCharsSent: change.patchCharsSent,
    deterministicImpact,
    extraDeterministicRequirements,
    state: change.state,
    questions: runtime.buildJevQuestions(invariants),
    invariants,
  };
}

export async function runHistoricalCalibrationCase({
  repoRoot = process.cwd(),
  calibrationCase,
  apiKey,
  runtimeOverrides = {},
} = {}) {
  const runtime = { ...DEFAULT_RUNTIME, ...runtimeOverrides };
  const observation = buildCalibrationObservation({
    repoRoot,
    calibrationCase,
    runtimeOverrides,
  });
  const startedAt = Date.now();
  const rawResponse = await runtime.callJev({
    apiKey,
    state: observation.state,
    questions: observation.questions,
  });
  const latencyMs = Date.now() - startedAt;
  const jev = runtime.normalizeJevResponse(rawResponse, observation.invariants);
  const reviewMatrix = runtime.deriveReviewMatrix({
    deterministicImpact: observation.deterministicImpact,
    extraDeterministicRequirements: observation.extraDeterministicRequirements,
    risks: jev.risks,
    invariantImpact: jev.invariantImpact,
  });

  return {
    caseId: observation.caseId,
    baseSha: observation.baseSha,
    headSha: observation.headSha,
    changedFiles: observation.changedFiles,
    patchTruncated: observation.patchTruncated,
    patchCharsSent: observation.patchCharsSent,
    deterministicImpact: observation.deterministicImpact,
    model: jev.model,
    usage: jev.usage,
    risks: jev.risks,
    invariantImpact: jev.invariantImpact,
    reviewMatrix,
    latencyMs,
  };
}

function intersects(values, accepted) {
  const acceptedSet = new Set(accepted);
  return values.some((value) => acceptedSet.has(value));
}

function scoreFinding(result, finding, candidateThreshold) {
  const deterministicInvariantIds = result.deterministicImpact.map((impact) => impact.id);
  const jevInvariantIds = result.reviewMatrix.candidateInvariants.map((entry) => entry.id);
  const deterministicRequirements = result.reviewMatrix.deterministicRequirements;
  const jevRequirements = result.reviewMatrix.jevAdvisoryRequirements;
  const riskHits = finding.acceptedRiskKeys.filter(
    (risk) => (result.risks[risk] ?? 0) >= candidateThreshold,
  );

  const deterministicHit =
    intersects(deterministicInvariantIds, finding.acceptedInvariantIds) ||
    intersects(deterministicRequirements, finding.acceptedRequirements);
  const jevHit =
    intersects(jevInvariantIds, finding.acceptedInvariantIds) ||
    intersects(jevRequirements, finding.acceptedRequirements) ||
    riskHits.length > 0;

  return {
    id: finding.id,
    severity: finding.severity,
    deterministicHit,
    jevHit,
    combinedHit: deterministicHit || jevHit,
    incrementalJevHit: !deterministicHit && jevHit,
    riskHits,
  };
}

export function scoreCalibrationCase(
  result,
  label,
  { candidateThreshold = DEFAULT_CANDIDATE_THRESHOLD } = {},
) {
  if (!label || !Array.isArray(label.findings)) {
    throw new Error(`Calibration label is missing for ${result.caseId}`);
  }
  const findings = label.findings.map((finding) =>
    scoreFinding(result, finding, candidateThreshold),
  );
  const deterministicSet = new Set(result.reviewMatrix.deterministicRequirements);
  const addedRequirements = result.reviewMatrix.jevAdvisoryRequirements.filter(
    (requirement) => !deterministicSet.has(requirement),
  );

  return {
    caseId: result.caseId,
    negativeControl: label.control === "NEGATIVE_LOW_RISK",
    findings,
    addedRequirements,
    escalationRequirements: addedRequirements.filter((requirement) =>
      requirement.startsWith("escalate-"),
    ),
  };
}

function recall(findings, key) {
  if (findings.length === 0) return null;
  return findings.filter((finding) => finding[key]).length / findings.length;
}

export function aggregateCalibration(scoredCases, caseResults) {
  const highCritical = scoredCases.flatMap((entry) =>
    entry.findings.filter(
      (finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH",
    ),
  );
  const allAddedRequirements = scoredCases.flatMap((entry) => entry.addedRequirements);
  const negativeControls = scoredCases.filter((entry) => entry.negativeControl);
  const negativeControlsWithAddedReview = negativeControls.filter(
    (entry) => entry.addedRequirements.length > 0,
  );
  const negativeControlsWithEscalation = negativeControls.filter(
    (entry) => entry.escalationRequirements.length > 0,
  );
  const usage = caseResults.reduce(
    (sum, result) => ({
      input_tokens: sum.input_tokens + result.usage.input_tokens,
      output_tokens: sum.output_tokens + result.usage.output_tokens,
    }),
    { input_tokens: 0, output_tokens: 0 },
  );
  const totalLatencyMs = caseResults.reduce((sum, result) => sum + result.latencyMs, 0);

  return {
    cases: scoredCases.length,
    highCriticalFindings: highCritical.length,
    deterministicHighCriticalRecall: recall(highCritical, "deterministicHit"),
    jevHighCriticalRecall: recall(highCritical, "jevHit"),
    combinedHighCriticalRecall: recall(highCritical, "combinedHit"),
    incrementalJevHits: highCritical.filter((finding) => finding.incrementalJevHit).length,
    extraReviewRequirements: allAddedRequirements.length,
    uniqueExtraReviewRequirements: [...new Set(allAddedRequirements)].sort(),
    negativeControlCases: negativeControls.length,
    negativeControlAddedReviewRate:
      negativeControls.length === 0
        ? null
        : negativeControlsWithAddedReview.length / negativeControls.length,
    negativeControlEscalationRate:
      negativeControls.length === 0
        ? null
        : negativeControlsWithEscalation.length / negativeControls.length,
    usage,
    totalLatencyMs,
  };
}
