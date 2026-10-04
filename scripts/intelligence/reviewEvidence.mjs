// Review-evidence validator (SCRUM-644 S3a).
//
// A pure function. It performs no git, network or GitHub calls: the caller
// supplies every identity, the commit history answers, the head's test
// registrations and any trusted runtime evidence. That keeps the trust decision
// in one place — whoever assembles those inputs. Only a controller running
// main's code may do that for a pull request (see .github/review-policy.json);
// output computed by a candidate's own job is a self-report.

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export const VERDICTS = Object.freeze({
  NOT_REQUIRED: "NOT_REQUIRED",
  COMPLETE: "COMPLETE",
  INCOMPLETE: "INCOMPLETE",
  INVALID: "INVALID",
});

export const OBLIGATION_STATUS = Object.freeze({
  SATISFIED: "SATISFIED",
  MISSING: "MISSING",
  EXCEPTED: "EXCEPTED",
  UNPROVEN: "UNPROVEN",
  REPORTED_UNRESOLVED: "REPORTED_UNRESOLVED",
});

// Reasons that make the whole evaluation INVALID rather than INCOMPLETE: the
// inputs do not describe one coherent change, so no obligation result is
// meaningful.
const INVALIDATING = new Set([
  "BAD_IDENTITY",
  "EMPTY_RANGE",
  "MERGE_NOT_OF_HEAD",
  "POLICY_VERSION",
  "MISSING_RECORD",
]);

export function isCommitSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

export function isNonMaterialPath(policy, file) {
  if (typeof file !== "string" || file.split("/").includes("..")) return false;
  return (policy.nonMaterialPaths ?? []).some(
    (rule) => file.startsWith(rule.prefix) && file.endsWith(rule.extension),
  );
}

function hasPrefix(prefixes, requirement) {
  return (prefixes ?? []).some((prefix) => requirement.startsWith(prefix));
}

function checkIdentities({ head, base, merge, mergeParents }, reasons) {
  for (const [name, value] of Object.entries({ head, base, merge })) {
    if (!isCommitSha(value)) {
      reasons.push({ code: "BAD_IDENTITY", detail: `${name} is not a 40-hex commit SHA` });
    }
  }
  if (head === base) {
    reasons.push({ code: "EMPTY_RANGE", detail: "base equals head; the change is empty" });
  }
  if (
    !Array.isArray(mergeParents) ||
    mergeParents.length !== 2 ||
    mergeParents[1] !== head
  ) {
    reasons.push({
      code: "MERGE_NOT_OF_HEAD",
      detail: "the tested merge is not a two-parent merge whose second parent is head",
    });
  }
}

// An evidence SHA is fresh when it is a full SHA, an ancestor of head, and
// nothing material changed between it and head.
function checkFreshness(sha, policy, history) {
  if (!isCommitSha(sha)) return { code: "BAD_SHA", detail: `evidence SHA ${String(sha)} is not 40-hex` };
  if (!history.isAncestor(sha)) {
    return { code: "STALE_EVIDENCE", detail: `${sha} is not an ancestor of head` };
  }
  const material = history.changedFilesSince(sha).filter((file) => !isNonMaterialPath(policy, file));
  if (material.length > 0) {
    return { code: "STALE_EVIDENCE", detail: `material change since ${sha}: ${material.join(", ")}` };
  }
  return undefined;
}

function checkTestEvidence(item, policy, history, testRegistry) {
  const stale = checkFreshness(item.sha, policy, history);
  if (stale) return stale;
  const registrations = testRegistry[item.file];
  const matches = (registrations ?? []).filter((entry) => entry.title === item.title);
  if (matches.length === 0) {
    return { code: "TEST_NOT_REGISTERED", detail: `${item.file} has no active test titled "${item.title}" at head` };
  }
  if (matches.some((entry) => entry.parameterized)) {
    return { code: "TEST_PARAMETERIZED", detail: `"${item.title}" is a .each registration and may run zero cases` };
  }
  return undefined;
}

function checkRuntimeEvidence(item, policy, merge, runtimeEvidence) {
  if (item.status !== "EXECUTED") {
    return { code: "RUNTIME_UNAVAILABLE", detail: `${item.workflow} is ${String(item.status)}` };
  }
  const admitted = (policy.runtimeWorkflows ?? []).find((workflow) => workflow.path === item.workflow);
  if (!admitted) {
    return { code: "RUNTIME_UNPROVEN", detail: `${item.workflow} is not an admissible runtime workflow` };
  }
  const runs = runtimeEvidence.filter(
    (run) => run.workflowPath === admitted.path && run.artifact === admitted.artifact,
  );
  if (runs.length === 0) {
    return { code: "RUNTIME_UNPROVEN", detail: `no trusted ${admitted.path} evidence was supplied` };
  }
  if (runs.length > 1) {
    return { code: "RUNTIME_AMBIGUOUS", detail: `${runs.length} trusted ${admitted.path} runs match` };
  }
  const [run] = runs;
  if (run.testedSha !== merge) {
    return { code: "RUNTIME_WRONG_MERGE", detail: `run tested ${String(run.testedSha)}, current merge is ${merge}` };
  }
  if (run.conclusion !== "success") {
    return { code: "RUNTIME_UNPROVEN", detail: `run concluded ${String(run.conclusion)}` };
  }
  return undefined;
}

function checkEvidenceItem(item, context) {
  if (item?.kind === "test") {
    return checkTestEvidence(item, context.policy, context.history, context.testRegistry);
  }
  if (item?.kind === "runtime") {
    return checkRuntimeEvidence(item, context.policy, context.identities.merge, context.runtimeEvidence);
  }
  return { code: "UNKNOWN_EVIDENCE", detail: `evidence kind ${String(item?.kind)} is not admissible` };
}

function evaluateRequirement(requirement, record, context) {
  const { policy } = context;
  const entry = (record.obligations ?? []).find((obligation) => obligation.requirement === requirement);

  if (hasPrefix(policy.reportedRequirementPrefixes, requirement)) {
    // A review cannot be proven by tests or runs; a record that claims to has
    // misdescribed what its evidence shows.
    const reasons = entry && (entry.evidence ?? []).length > 0
      ? [{ code: "REVIEW_NOT_PROVABLE", requirement, detail: "review requirements cannot be satisfied by evidence" }]
      : [];
    return { status: OBLIGATION_STATUS.REPORTED_UNRESOLVED, reasons };
  }

  if (!hasPrefix(policy.enforceableRequirementPrefixes, requirement)) {
    return {
      status: OBLIGATION_STATUS.UNPROVEN,
      reasons: [{ code: "UNCLASSIFIED_REQUIREMENT", requirement, detail: "policy names no rule for this requirement" }],
    };
  }

  if (!entry) {
    const exception = (record.exceptions ?? []).find((item) => item.requirement === requirement);
    if (exception) {
      return {
        status: OBLIGATION_STATUS.EXCEPTED,
        reasons: [{ code: "EXCEPTED", requirement, detail: `excepted under ${String(exception.jira)}` }],
      };
    }
    return {
      status: OBLIGATION_STATUS.MISSING,
      reasons: [{ code: "MISSING_OBLIGATION", requirement, detail: "the record does not answer this requirement" }],
    };
  }

  const evidence = entry.evidence ?? [];
  if (evidence.length === 0) {
    return {
      status: OBLIGATION_STATUS.UNPROVEN,
      reasons: [{ code: "NO_EVIDENCE", requirement, detail: "the obligation lists no evidence" }],
    };
  }
  // Every listed item must hold: one fabricated claim is not rescued by a
  // genuine one beside it.
  const failures = evidence
    .map((item) => checkEvidenceItem(item, context))
    .filter(Boolean)
    .map((failure) => ({ ...failure, requirement }));
  return failures.length > 0
    ? { status: OBLIGATION_STATUS.UNPROVEN, reasons: failures }
    : { status: OBLIGATION_STATUS.SATISFIED, reasons: [] };
}

/**
 * @param {object} input
 * @param {object} input.policy            the trusted policy (main's copy)
 * @param {object|null} input.record       the candidate's evidence record
 * @param {{head: string, base: string, merge: string, mergeParents: string[]}} input.identities
 *        derived by the caller; never read from the record
 * @param {string[]} input.requirements    deterministic requirements for base..head
 * @param {{isAncestor: (sha: string) => boolean, changedFilesSince: (sha: string) => string[]}} input.history
 *        answers relative to head
 * @param {Record<string, readonly {title: string, parameterized: boolean}[]>} input.testRegistry
 *        active registrations at head, only for files a required CI check runs
 * @param {{workflowPath: string, artifact: string, testedSha: string, conclusion: string}[]} input.runtimeEvidence
 *        trusted runs, latest attempt only, as resolved by the caller
 */
export function evaluateReviewEvidence({
  policy,
  record,
  identities,
  requirements,
  history,
  testRegistry = {},
  runtimeEvidence = [],
}) {
  const reasons = [];
  checkIdentities(identities, reasons);

  if (requirements.length === 0 && reasons.length === 0) {
    return { verdict: VERDICTS.NOT_REQUIRED, reasons: [], obligations: [] };
  }
  if (!record) {
    reasons.push({ code: "MISSING_RECORD", detail: "requirements exist and no evidence record was found" });
  } else if (record.policyVersion !== policy.policyVersion) {
    reasons.push({
      code: "POLICY_VERSION",
      detail: `record is stamped ${String(record.policyVersion)}, policy is ${policy.policyVersion}`,
    });
  }
  if (reasons.some((reason) => INVALIDATING.has(reason.code))) {
    return { verdict: VERDICTS.INVALID, reasons, obligations: [] };
  }

  // record.base, if present, is deliberately never read: the range comes from
  // the caller's identities alone.
  const context = { policy, identities, history, testRegistry, runtimeEvidence };
  const obligations = [...new Set(requirements)].sort().map((requirement) => {
    const result = evaluateRequirement(requirement, record, context);
    reasons.push(...result.reasons);
    return { requirement, status: result.status };
  });

  return {
    verdict: reasons.length > 0 ? VERDICTS.INCOMPLETE : VERDICTS.COMPLETE,
    reasons,
    obligations,
  };
}
