import {
  DEFAULT_CANDIDATE_THRESHOLD,
  DEFAULT_ESCALATION_THRESHOLD,
  assertAncestorCommit,
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
  readCommitTimestamp,
} from "./jevImpact.mjs";

const DEFAULT_RUNTIME = Object.freeze({
  assertAncestorCommit,
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
  readCommitTimestamp,
});

function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const EMPTY_RISKS = Object.freeze({
  economic: 0,
  tenancy: 0,
  authorization: 0,
  replay: 0,
  concurrency: 0,
  reversal: 0,
  lifecycle: 0,
  completeness: 0,
  externalInput: 0,
  uiAuthority: 0,
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

function assertSnapshotProvenance(repoRoot, calibrationCase, runtime) {
  runtime.assertAncestorCommit(
    repoRoot,
    calibrationCase.baseSha,
    calibrationCase.headSha,
  );
  const expected = new Date(calibrationCase.snapshotAt);
  if (!Number.isFinite(expected.getTime())) {
    throw new TypeError(
      `Calibration case ${calibrationCase.id} has an invalid snapshot timestamp`,
    );
  }
  const actual = runtime.readCommitTimestamp(repoRoot, calibrationCase.headSha);
  if (actual !== expected.toISOString()) {
    throw new Error(
      `Calibration case ${calibrationCase.id} timestamp mismatch: expected ${expected.toISOString()} but commit is ${actual}`,
    );
  }
}

function sanitizeFailureReason(error, apiKey) {
  let reason = error instanceof Error ? error.message : String(error);
  if (apiKey) reason = reason.split(apiKey).join("[redacted]");
  reason = reason
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>\x00-\x1f\x7f]/g, "")
    .trim();
  return reason.slice(0, 300) || "Unknown Jev calibration failure";
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
  assertSnapshotProvenance(repoRoot, calibrationCase, runtime);
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
  const deterministicReviewMatrix = runtime.deriveReviewMatrix({
    deterministicImpact,
    extraDeterministicRequirements,
    risks: EMPTY_RISKS,
    invariantImpact: {},
  });

  return {
    caseId: calibrationCase.id,
    baseSha: calibrationCase.baseSha,
    headSha: calibrationCase.headSha,
    changedFiles: change.changedFiles,
    patchTruncated: change.patchTruncated,
    patchCharsSent: change.patchCharsSent,
    deterministicImpact,
    extraDeterministicRequirements,
    deterministicReviewMatrix,
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
 *   normalize: (response: unknown) => any,
 *   deterministicImpact: any[],
 *   extraDeterministicRequirements: string[],
 * }} options
 */
async function runJevTrack({
  runtime,
  apiKey,
  state,
  questions,
  normalize,
  deterministicImpact,
  extraDeterministicRequirements,
}) {
  const startedAt = Date.now();
  try {
    const rawResponse = await runtime.callJev({ apiKey, state, questions });
    const jev = normalize(rawResponse);
    const reviewMatrix = runtime.deriveReviewMatrix({
      deterministicImpact,
      extraDeterministicRequirements,
      risks: jev.risks,
      invariantImpact: jev.invariantImpact ?? {},
    });
    return {
      status: "COMPLETE",
      model: jev.model,
      usage: jev.usage,
      risks: jev.risks,
      invariantImpact: jev.invariantImpact ?? {},
      reviewMatrix,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      reason: sanitizeFailureReason(error, apiKey),
      usage: null,
      risks: null,
      invariantImpact: null,
      reviewMatrix: null,
      latencyMs: Date.now() - startedAt,
    };
  }
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
  const blind = await runJevTrack({
    runtime,
    apiKey,
    state: observation.state,
    questions: observation.blindQuestions,
    normalize: (response) => runtime.normalizeJevRiskResponse(response),
    deterministicImpact: [],
    extraDeterministicRequirements: [],
  });

  // Secondary operational replay: apply today's complete AutoFlow policy to the
  // same old diff. This is useful for current routing, but is not counted as the
  // hindsight-free Jev metric because today's invariant catalog is newer.
  const policy = await runJevTrack({
    runtime,
    apiKey,
    state: observation.state,
    questions: observation.policyQuestions,
    normalize: (response) =>
      runtime.normalizeJevResponse(response, observation.invariants),
    deterministicImpact: observation.deterministicImpact,
    extraDeterministicRequirements: observation.extraDeterministicRequirements,
  });

  return {
    caseId: observation.caseId,
    snapshotAt: calibrationCase.snapshotAt,
    baseSha: observation.baseSha,
    headSha: observation.headSha,
    changedFiles: observation.changedFiles,
    patchTruncated: observation.patchTruncated,
    patchCharsSent: observation.patchCharsSent,
    deterministicImpact: observation.deterministicImpact,
    deterministicReviewMatrix: observation.deterministicReviewMatrix,
    blind,
    policy,
  };
}

function intersects(values, accepted) {
  const acceptedSet = new Set(accepted);
  return values.some((value) => acceptedSet.has(value));
}

function matchingRisks(risks, acceptedRiskKeys, threshold) {
  return acceptedRiskKeys.filter(
    (risk) => (risks?.[risk] ?? 0) >= threshold,
  );
}

function completedTrack(track) {
  return track?.status === "COMPLETE" && track.reviewMatrix !== null;
}

function scoreFinding(result, finding, candidateThreshold, escalationThreshold) {
  const deterministicInvariantIds = result.deterministicImpact.map(
    (impact) => impact.id,
  );
  const deterministicRequirements =
    result.deterministicReviewMatrix.deterministicRequirements;

  const blindAvailable = completedTrack(result.blind);
  const blindRiskHits = blindAvailable
    ? matchingRisks(result.blind.risks, finding.acceptedRiskKeys, candidateThreshold)
    : [];
  const blindEscalationRiskHits = blindAvailable
    ? matchingRisks(
        result.blind.risks,
        finding.acceptedRiskKeys,
        escalationThreshold,
      )
    : [];
  const blindJevHit =
    blindAvailable &&
    (intersects(
      result.blind.reviewMatrix.jevAdvisoryRequirements,
      finding.acceptedRequirements,
    ) ||
      blindRiskHits.length > 0);

  const policyAvailable = completedTrack(result.policy);
  const policyInvariantIds = policyAvailable
    ? result.policy.reviewMatrix.candidateInvariants.map((entry) => entry.id)
    : [];
  const policyRiskHits = policyAvailable
    ? matchingRisks(result.policy.risks, finding.acceptedRiskKeys, candidateThreshold)
    : [];
  const policyEscalationRiskHits = policyAvailable
    ? matchingRisks(
        result.policy.risks,
        finding.acceptedRiskKeys,
        escalationThreshold,
      )
    : [];
  const policyInvariantEscalationHits = policyAvailable
    ? finding.acceptedInvariantIds.filter(
        (id) => (result.policy.invariantImpact?.[id] ?? 0) >= escalationThreshold,
      )
    : [];
  const policyJevHit =
    policyAvailable &&
    (intersects(policyInvariantIds, finding.acceptedInvariantIds) ||
      intersects(
        result.policy.reviewMatrix.jevAdvisoryRequirements,
        finding.acceptedRequirements,
      ) ||
      policyRiskHits.length > 0);

  const deterministicHit =
    intersects(deterministicInvariantIds, finding.acceptedInvariantIds) ||
    intersects(deterministicRequirements, finding.acceptedRequirements);

  const blindEscalatedHit = blindEscalationRiskHits.length > 0;
  const policyEscalatedHit =
    policyEscalationRiskHits.length > 0 ||
    policyInvariantEscalationHits.length > 0;

  return {
    id: finding.id,
    severity: finding.severity,
    deterministicHit,
    blindAvailable,
    policyAvailable,
    blindJevHit,
    blindEscalatedHit,
    policyJevHit,
    policyEscalatedHit,
    operationalCombinedHit: deterministicHit || policyJevHit,
    incrementalBlindJevHit: !deterministicHit && blindJevHit,
    incrementalPolicyJevHit: !deterministicHit && policyJevHit,
    blindRiskHits,
    blindEscalationRiskHits,
    policyRiskHits,
    policyEscalationRiskHits,
    policyInvariantEscalationHits,
  };
}

function addedRequirements(track) {
  if (!completedTrack(track)) return [];
  const deterministic = new Set(track.reviewMatrix.deterministicRequirements);
  return track.reviewMatrix.jevAdvisoryRequirements.filter(
    (requirement) => !deterministic.has(requirement),
  );
}

export function scoreCalibrationCase(
  result,
  label,
  {
    candidateThreshold = DEFAULT_CANDIDATE_THRESHOLD,
    escalationThreshold = DEFAULT_ESCALATION_THRESHOLD,
  } = {},
) {
  if (!label || !Array.isArray(label.findings)) {
    throw new Error(`Calibration label is missing for ${result.caseId}`);
  }
  const snapshotAt = Date.parse(result.snapshotAt ?? "");
  const revealedAfter = Date.parse(label.revealedAfter ?? "");
  if (!Number.isFinite(snapshotAt) || !Number.isFinite(revealedAfter)) {
    throw new TypeError(
      `Calibration case ${result.caseId} has invalid hindsight-boundary timestamps`,
    );
  }
  if (snapshotAt >= revealedAfter) {
    throw new Error(
      `Calibration case ${result.caseId} is not hindsight-free: snapshot ${result.snapshotAt} must precede disclosure ${label.revealedAfter}`,
    );
  }
  const findings = label.findings.map((finding) =>
    scoreFinding(result, finding, candidateThreshold, escalationThreshold),
  );
  const blindAddedRequirements = addedRequirements(result.blind);
  const policyAddedRequirements = addedRequirements(result.policy);

  return {
    caseId: result.caseId,
    negativeControl: label.control === "NEGATIVE_LOW_RISK",
    blindAvailable: completedTrack(result.blind),
    policyAvailable: completedTrack(result.policy),
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

function usageForTrack(result, trackName) {
  const track = result[trackName];
  return track?.status === "COMPLETE" && track.usage
    ? track.usage
    : { input_tokens: 0, output_tokens: 0 };
}

export function aggregateCalibration(scoredCases, caseResults) {
  const highCritical = scoredCases.flatMap((entry) =>
    entry.findings.filter(
      (finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH",
    ),
  );
  const negativeControls = scoredCases.filter((entry) => entry.negativeControl);
  const blindAvailableControls = negativeControls.filter(
    (entry) => entry.blindAvailable,
  );
  const policyAvailableControls = negativeControls.filter(
    (entry) => entry.policyAvailable,
  );
  const blindExtraRequirements = scoredCases.flatMap(
    (entry) => entry.blindAddedRequirements,
  );
  const policyExtraRequirements = scoredCases.flatMap(
    (entry) => entry.policyAddedRequirements,
  );
  const blindNegativeWithReview = blindAvailableControls.filter(
    (entry) => entry.blindAddedRequirements.length > 0,
  );
  const policyNegativeWithReview = policyAvailableControls.filter(
    (entry) => entry.policyAddedRequirements.length > 0,
  );
  const blindNegativeWithEscalation = blindAvailableControls.filter(
    (entry) => entry.blindEscalationRequirements.length > 0,
  );
  const policyNegativeWithEscalation = policyAvailableControls.filter(
    (entry) => entry.policyEscalationRequirements.length > 0,
  );

  const usage = caseResults.reduce(
    (sum, result) => {
      const blindUsage = usageForTrack(result, "blind");
      const policyUsage = usageForTrack(result, "policy");
      return {
        blind_input_tokens: sum.blind_input_tokens + blindUsage.input_tokens,
        blind_output_tokens: sum.blind_output_tokens + blindUsage.output_tokens,
        policy_input_tokens: sum.policy_input_tokens + policyUsage.input_tokens,
        policy_output_tokens: sum.policy_output_tokens + policyUsage.output_tokens,
      };
    },
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
  const blindAvailableCases = scoredCases.filter((entry) => entry.blindAvailable);
  const policyAvailableCases = scoredCases.filter((entry) => entry.policyAvailable);

  return {
    cases: scoredCases.length,
    highCriticalFindings: highCritical.length,
    currentDeterministicReplayRecall: recall(highCritical, "deterministicHit"),
    blindJevHighCriticalRecall: recall(highCritical, "blindJevHit"),
    blindJevHighCriticalEscalationRecall: recall(
      highCritical,
      "blindEscalatedHit",
    ),
    currentPolicyJevHighCriticalRecall: recall(highCritical, "policyJevHit"),
    currentPolicyJevHighCriticalEscalationRecall: recall(
      highCritical,
      "policyEscalatedHit",
    ),
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
    blindTrackAvailabilityRate: rate(blindAvailableCases.length, scoredCases.length),
    policyTrackAvailabilityRate: rate(
      policyAvailableCases.length,
      scoredCases.length,
    ),
    unavailableBlindTracks: scoredCases.length - blindAvailableCases.length,
    unavailablePolicyTracks: scoredCases.length - policyAvailableCases.length,
    unavailableTracks:
      scoredCases.length * 2 -
      blindAvailableCases.length -
      policyAvailableCases.length,
    blindExtraReviewRequirements: blindExtraRequirements.length,
    uniqueBlindExtraReviewRequirements: [...new Set(blindExtraRequirements)].sort(compareStrings),
    policyExtraReviewRequirements: policyExtraRequirements.length,
    uniquePolicyExtraReviewRequirements: [...new Set(policyExtraRequirements)].sort(compareStrings),
    negativeControlCases: negativeControls.length,
    blindAvailableNegativeControlCases: blindAvailableControls.length,
    policyAvailableNegativeControlCases: policyAvailableControls.length,
    blindNegativeControlAddedReviewRate: rate(
      blindNegativeWithReview.length,
      blindAvailableControls.length,
    ),
    policyNegativeControlAddedReviewRate: rate(
      policyNegativeWithReview.length,
      policyAvailableControls.length,
    ),
    blindNegativeControlEscalationRate: rate(
      blindNegativeWithEscalation.length,
      blindAvailableControls.length,
    ),
    policyNegativeControlEscalationRate: rate(
      policyNegativeWithEscalation.length,
      policyAvailableControls.length,
    ),
    usage,
    latency,
  };
}
