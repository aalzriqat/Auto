import {
  DEFAULT_CANDIDATE_THRESHOLD,
  buildChangeState,
  buildJevQuestions,
  buildJevRiskQuestions,
  callJev,
  deriveReviewMatrix,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
  extraDeterministicRequirementsForFiles,
  normalizeJevResponse,
  normalizeJevRiskResponse,
} from "./jevImpact.mjs";

const DEFAULT_RUNTIME = Object.freeze({
  buildChangeState,
  buildJevQuestions,
  buildJevRiskQuestions,
  callJev,
  deriveReviewMatrix,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
  extraDeterministicRequirementsForFiles,
  normalizeJevResponse,
  normalizeJevRiskResponse,
});

/**
 * @typedef {object} CalibrationCase
 * @property {string} id
 * @property {number} prNumber
 * @property {string} baseSha
 * @property {string} headSha
 * @property {string} snapshotAt
 */

/** @typedef {Partial<typeof DEFAULT_RUNTIME>} CalibrationRuntimeOverrides */

/** @param {CalibrationCase} calibrationCase */
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

/**
 * @param {{
 *   repoRoot?: string,
 *   calibrationCase: CalibrationCase,
 *   runtimeOverrides?: CalibrationRuntimeOverrides,
 * }} options
 */
export function buildCalibrationObservation({
  repoRoot = process.cwd(),
  calibrationCase,
  runtimeOverrides = {},
}) {
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
    blindQuestions: runtime.buildJevRiskQuestions(),
    policyQuestions: runtime.buildJevQuestions(invariants),
    invariants,
  };
}

/**
 * @param {{
 *   runtime: typeof DEFAULT_RUNTIME,
 *   apiKey: string,
 *   state: unknown,
 *   questions: Record<string, unknown>,
 * }} options
 */
async function timedJevCall({ runtime, apiKey, state, questions }) {
  const startedAt = Date.now();
  const rawResponse = await runtime.callJev({ apiKey, state, questions });
  return {
    rawResponse,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * @param {{
 *   repoRoot?: string,
 *   calibrationCase: CalibrationCase,
 *   apiKey: string,
 *   runtimeOverrides?: CalibrationRuntimeOverrides,
 * }} options
 */
export async function runHistoricalCalibrationCase({
  repoRoot = process.cwd(),
  calibrationCase,
  apiKey,
  runtimeOverrides = {},
}) {
  const runtime = { ...DEFAULT_RUNTIME, ...runtimeOverrides };
  const observation = buildCalibrationObservation({
    repoRoot,
    calibrationCase,
    runtimeOverrides,
  });

  // Primary hindsight-free track: generic risk questions only. No current
  // invariant IDs, statements, source areas, or later finding labels are sent.
  const blindCall = await timedJevCall({
    runtime,
    apiKey,
    state: observation.state,
    questions: observation.blindQuestions,
  });
  const blindJev = runtime.normalizeJevRiskResponse(blindCall.rawResponse);
  const blindReviewMatrix = runtime.deriveReviewMatrix({
    deterministicImpact: [],
    extraDeterministicRequirements: [],
    risks: blindJev.risks,
    invariantImpact: {},
  });

  // Secondary operational replay: apply today's complete AutoFlow policy to the
  // same old diff. This is useful for current routing, but is not counted as the
  // hindsight-free Jev metric because today's invariant catalog is newer.
  const policyCall = await timedJevCall({
    runtime,
    apiKey,
    state: observation.state,
    questions: observation.policyQuestions,
  });
  const policyJev = runtime.normalizeJevResponse(
    policyCall.rawResponse,
    observation.invariants,
  );
  const policyReviewMatrix = runtime.deriveReviewMatrix({
    deterministicImpact: observation.deterministicImpact,
    extraDeterministicRequirements: observation.extraDeterministicRequirements,
    risks: policyJev.risks,
    invariantImpact: policyJev.invariantImpact,
  });

  return {
    caseId: observation.caseId,
    baseSha: observation.baseSha,
    headSha: observation.headSha,
    changedFiles: observation.changedFiles,
    patchTruncated: observation.patchTruncated,
    patchCharsSent: observation.patchCharsSent,
    deterministicImpact: observation.deterministicImpact,
    blind: {
      model: blindJev.model,
      usage: blindJev.usage,
      risks: blindJev.risks,
      reviewMatrix: blindReviewMatrix,
      latencyMs: blindCall.latencyMs,
    },
    policy: {
      model: policyJev.model,
      usage: policyJev.usage,
      risks: policyJev.risks,
      invariantImpact: policyJev.invariantImpact,
      reviewMatrix: policyReviewMatrix,
      latencyMs: policyCall.latencyMs,
    },
  };
}

function intersects(values, accepted) {
  const acceptedSet = new Set(accepted);
  return values.some((value) => acceptedSet.has(value));
}

function matchingRisks(risks, acceptedRiskKeys, candidateThreshold) {
  return acceptedRiskKeys.filter(
    (risk) => (risks[risk] ?? 0) >= candidateThreshold,
  );
}

function scoreFinding(result, finding, candidateThreshold) {
  const deterministicInvariantIds = result.deterministicImpact.map((impact) => impact.id);
  const deterministicRequirements = result.policy.reviewMatrix.deterministicRequirements;

  const blindRiskHits = matchingRisks(
    result.blind.risks,
    finding.acceptedRiskKeys,
    candidateThreshold,
  );
  const blindJevHit =
    intersects(
      result.blind.reviewMatrix.jevAdvisoryRequirements,
      finding.acceptedRequirements,
    ) || blindRiskHits.length > 0;

  const policyInvariantIds = result.policy.reviewMatrix.candidateInvariants.map(
    (entry) => entry.id,
  );
  const policyRiskHits = matchingRisks(
    result.policy.risks,
    finding.acceptedRiskKeys,
    candidateThreshold,
  );
  const policyJevHit =
    intersects(policyInvariantIds, finding.acceptedInvariantIds) ||
    intersects(
      result.policy.reviewMatrix.jevAdvisoryRequirements,
      finding.acceptedRequirements,
    ) ||
    policyRiskHits.length > 0;

  const deterministicHit =
    intersects(deterministicInvariantIds, finding.acceptedInvariantIds) ||
    intersects(deterministicRequirements, finding.acceptedRequirements);

  return {
    id: finding.id,
    severity: finding.severity,
    deterministicHit,
    blindJevHit,
    policyJevHit,
    operationalCombinedHit: deterministicHit || policyJevHit,
    incrementalBlindJevHit: !deterministicHit && blindJevHit,
    incrementalPolicyJevHit: !deterministicHit && policyJevHit,
    blindRiskHits,
    policyRiskHits,
  };
}

function addedRequirements(reviewMatrix) {
  const deterministic = new Set(reviewMatrix.deterministicRequirements);
  return reviewMatrix.jevAdvisoryRequirements.filter(
    (requirement) => !deterministic.has(requirement),
  );
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
  const blindAddedRequirements = addedRequirements(result.blind.reviewMatrix);
  const policyAddedRequirements = addedRequirements(result.policy.reviewMatrix);

  return {
    caseId: result.caseId,
    negativeControl: label.control === "NEGATIVE_LOW_RISK",
    findings,
    blindAddedRequirements,
    policyAddedRequirements,
    blindEscalationRequirements: blindAddedRequirements.filter((requirement) =>
      requirement.startsWith("escalate-"),
    ),
    policyEscalationRequirements: policyAddedRequirements.filter((requirement) =>
      requirement.startsWith("escalate-"),
    ),
  };
}

function recall(findings, key) {
  if (findings.length === 0) return null;
  return findings.filter((finding) => finding[key]).length / findings.length;
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

export function aggregateCalibration(scoredCases, caseResults) {
  const highCritical = scoredCases.flatMap((entry) =>
    entry.findings.filter(
      (finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH",
    ),
  );
  const negativeControls = scoredCases.filter((entry) => entry.negativeControl);
  const blindExtraRequirements = scoredCases.flatMap(
    (entry) => entry.blindAddedRequirements,
  );
  const policyExtraRequirements = scoredCases.flatMap(
    (entry) => entry.policyAddedRequirements,
  );
  const blindNegativeWithReview = negativeControls.filter(
    (entry) => entry.blindAddedRequirements.length > 0,
  );
  const policyNegativeWithReview = negativeControls.filter(
    (entry) => entry.policyAddedRequirements.length > 0,
  );
  const blindNegativeWithEscalation = negativeControls.filter(
    (entry) => entry.blindEscalationRequirements.length > 0,
  );
  const policyNegativeWithEscalation = negativeControls.filter(
    (entry) => entry.policyEscalationRequirements.length > 0,
  );

  const usage = caseResults.reduce(
    (sum, result) => ({
      blind_input_tokens: sum.blind_input_tokens + result.blind.usage.input_tokens,
      blind_output_tokens: sum.blind_output_tokens + result.blind.usage.output_tokens,
      policy_input_tokens: sum.policy_input_tokens + result.policy.usage.input_tokens,
      policy_output_tokens: sum.policy_output_tokens + result.policy.usage.output_tokens,
    }),
    {
      blind_input_tokens: 0,
      blind_output_tokens: 0,
      policy_input_tokens: 0,
      policy_output_tokens: 0,
    },
  );
  const latency = caseResults.reduce(
    (sum, result) => ({
      blind_ms: sum.blind_ms + result.blind.latencyMs,
      policy_ms: sum.policy_ms + result.policy.latencyMs,
    }),
    { blind_ms: 0, policy_ms: 0 },
  );

  return {
    cases: scoredCases.length,
    highCriticalFindings: highCritical.length,
    currentDeterministicReplayRecall: recall(highCritical, "deterministicHit"),
    blindJevHighCriticalRecall: recall(highCritical, "blindJevHit"),
    currentPolicyJevHighCriticalRecall: recall(highCritical, "policyJevHit"),
    operationalCombinedHighCriticalRecall: recall(
      highCritical,
      "operationalCombinedHit",
    ),
    incrementalBlindJevHits: highCritical.filter(
      (finding) => finding.incrementalBlindJevHit,
    ).length,
    incrementalPolicyJevHits: highCritical.filter(
      (finding) => finding.incrementalPolicyJevHit,
    ).length,
    blindExtraReviewRequirements: blindExtraRequirements.length,
    uniqueBlindExtraReviewRequirements: [...new Set(blindExtraRequirements)].sort(),
    policyExtraReviewRequirements: policyExtraRequirements.length,
    uniquePolicyExtraReviewRequirements: [...new Set(policyExtraRequirements)].sort(),
    negativeControlCases: negativeControls.length,
    blindNegativeControlAddedReviewRate: rate(
      blindNegativeWithReview.length,
      negativeControls.length,
    ),
    policyNegativeControlAddedReviewRate: rate(
      policyNegativeWithReview.length,
      negativeControls.length,
    ),
    blindNegativeControlEscalationRate: rate(
      blindNegativeWithEscalation.length,
      negativeControls.length,
    ),
    policyNegativeControlEscalationRate: rate(
      policyNegativeWithEscalation.length,
      negativeControls.length,
    ),
    usage,
    latency,
  };
}
