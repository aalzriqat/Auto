// Review-evidence validator (SCRUM-644 S3a).
//
// A pure function. It performs no git, network or GitHub calls: the caller
// supplies every identity, the commit history answers, the head's test
// registrations and any trusted runtime evidence. That keeps the trust decision
// in one place — whoever assembles those inputs. Only a controller running
// main's code may do that for a pull request (see .github/review-policy.json);
// output computed by a candidate's own job is a self-report.

import { compareCodeUnits } from "../contractSkew/compareCodeUnits.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;

// COMPLETE is reachable only when no review requirement exists: a review can
// never be proven here, so proofs that all hold beside a required review give
// REVIEW_UNRESOLVED, never COMPLETE.
export const VERDICTS = Object.freeze({
  NOT_REQUIRED: "NOT_REQUIRED",
  COMPLETE: "COMPLETE",
  REVIEW_UNRESOLVED: "REVIEW_UNRESOLVED",
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
  "MALFORMED_RECORD",
]);

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// Formats a value for a reason's detail. String() throws on a JSON object such
// as {"toString":"x"}, so anything that is not a primitive is named by type.
const show = (value) => (value !== null && typeof value === "object" ? typeof value : String(value));

const SCALAR_EVIDENCE_FIELDS = ["kind", "status", "workflow", "file", "title", "sha"];
const isScalar = (value) => value === undefined || value === null || typeof value !== "object";

// The record is candidate-controlled, so its shape is checked before any field
// is used: a hostile shape must produce a verdict, never a crash.
function recordShapeProblem(record) {
  if (!isPlainObject(record)) return "record is not an object";
  if (record.obligations !== undefined && !Array.isArray(record.obligations)) return "obligations is not an array";
  if (record.exceptions !== undefined && !Array.isArray(record.exceptions)) return "exceptions is not an array";
  for (const obligation of record.obligations ?? []) {
    if (!isPlainObject(obligation) || typeof obligation.requirement !== "string") {
      return "an obligation has no string requirement";
    }
    if (obligation.evidence !== undefined && !Array.isArray(obligation.evidence)) {
      return `evidence for ${obligation.requirement} is not an array`;
    }
    for (const item of obligation.evidence ?? []) {
      if (!isPlainObject(item)) return `evidence for ${obligation.requirement} holds a non-object`;
      const nested = SCALAR_EVIDENCE_FIELDS.find((field) => !isScalar(item[field]));
      if (nested) return `evidence for ${obligation.requirement} has a non-scalar ${nested}`;
    }
  }
  for (const exception of record.exceptions ?? []) {
    if (!isPlainObject(exception) || typeof exception.requirement !== "string") {
      return "an exception has no string requirement";
    }
    if (!isScalar(exception.jira)) return `the exception for ${exception.requirement} has a non-scalar jira`;
  }
  if (!isScalar(record.policyVersion)) return "policyVersion is not a scalar";
  // Lookups take the first entry for a requirement, so a second entry would go
  // unread and its order would decide the verdict.
  for (const list of ["obligations", "exceptions"]) {
    const duplicate = firstDuplicate((record[list] ?? []).map((entry) => entry.requirement));
    if (duplicate !== undefined) return `${list} lists ${duplicate} more than once`;
  }
  return undefined;
}

function firstDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

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
// nothing material changed between it and head. changedFilesSince must report
// both sides of a rename (git diff --no-renames), or a material file renamed
// into a non-material path would show only its harmless new name.
function checkFreshness(sha, policy, history) {
  if (!isCommitSha(sha)) return { code: "BAD_SHA", detail: `evidence SHA ${show(sha)} is not 40-hex` };
  if (!history.isAncestor(sha)) {
    return { code: "STALE_EVIDENCE", detail: `${sha} is not an ancestor of head` };
  }
  const material = history.changedFilesSince(sha).filter((file) => !isNonMaterialPath(policy, file));
  if (material.length > 0) {
    return { code: "STALE_EVIDENCE", detail: `material change since ${sha}: ${material.join(", ")}` };
  }
  return undefined;
}

// A test counts for a requirement only when its own title carries that
// requirement's id as a whole token, so proof:BOUNDARY_X is not proof:BOUNDARY.
// This binding is nominal. It stops a record from citing an unrelated test,
// but the change under review writes both the title and the body, and a title
// such as "does not prove proof:REPLAY" still carries the token. Binding to the
// catalog's unique proof markers is S4 work.
function carriesRequirement(title, requirement) {
  const escaped = requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w:-])${escaped}(?![\\w:-])`).test(title);
}

function checkTestEvidence(item, requirement, policy, history, testRegistry) {
  if (typeof item.title !== "string" || !carriesRequirement(item.title, requirement)) {
    return { code: "EVIDENCE_NOT_FOR_REQUIREMENT", detail: `test title does not carry ${requirement}` };
  }
  const stale = checkFreshness(item.sha, policy, history);
  if (stale) return stale;
  const registrations = typeof item.file === "string" && Object.hasOwn(testRegistry, item.file)
    ? testRegistry[item.file]
    : [];
  const matches = registrations.filter((entry) => entry.title === item.title);
  if (matches.length === 0) {
    return { code: "TEST_NOT_REGISTERED", detail: `${show(item.file)} has no active test titled "${item.title}" at head` };
  }
  if (matches.some((entry) => entry.parameterized)) {
    return { code: "TEST_PARAMETERIZED", detail: `"${item.title}" is a .each registration and may run zero cases` };
  }
  return undefined;
}

// A workflow proves only the requirements its policy entry lists in `proves`.
// Runs are narrowed to the current merge before counting, so an earlier push's
// run neither makes the current one ambiguous nor stands in for it.
function checkRuntimeEvidence(item, requirement, policy, merge, runtimeEvidence) {
  if (item.status !== "EXECUTED") {
    return { code: "RUNTIME_UNAVAILABLE", detail: `${show(item.workflow)} is ${show(item.status)}` };
  }
  const admitted = (policy.runtimeWorkflows ?? []).find((workflow) => workflow.path === item.workflow);
  if (!admitted) {
    return { code: "RUNTIME_UNPROVEN", detail: `${show(item.workflow)} is not an admissible runtime workflow` };
  }
  if (!(admitted.proves ?? []).includes(requirement)) {
    return { code: "EVIDENCE_NOT_FOR_REQUIREMENT", detail: `${admitted.path} is not admitted as proof of ${requirement}` };
  }
  const runs = runtimeEvidence.filter(
    (run) => run.workflowPath === admitted.path && run.artifact === admitted.artifact,
  );
  if (runs.length === 0) {
    return { code: "RUNTIME_UNPROVEN", detail: `no trusted ${admitted.path} evidence was supplied` };
  }
  const forMerge = runs.filter((run) => run.testedSha === merge);
  if (forMerge.length === 0) {
    return { code: "RUNTIME_WRONG_MERGE", detail: `no trusted ${admitted.path} run tested the current merge ${merge}` };
  }
  if (forMerge.length > 1) {
    return { code: "RUNTIME_AMBIGUOUS", detail: `${forMerge.length} trusted ${admitted.path} runs tested ${merge}` };
  }
  const [run] = forMerge;
  if (run.conclusion !== "success") {
    return { code: "RUNTIME_UNPROVEN", detail: `run concluded ${show(run.conclusion)}` };
  }
  return undefined;
}

function checkEvidenceItem(item, requirement, context) {
  if (item.kind === "test") {
    return checkTestEvidence(item, requirement, context.policy, context.history, context.testRegistry);
  }
  if (item.kind === "runtime") {
    return checkRuntimeEvidence(item, requirement, context.policy, context.identities.merge, context.runtimeEvidence);
  }
  return { code: "UNKNOWN_EVIDENCE", detail: `evidence kind ${show(item.kind)} is not admissible` };
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
        reasons: [{ code: "EXCEPTED", requirement, detail: `excepted under ${show(exception.jira)}` }],
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
    .map((item) => checkEvidenceItem(item, requirement, context))
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
    return { verdict: VERDICTS.NOT_REQUIRED, reasons: [], obligations: [], unresolvedReviews: [] };
  }
  if (!record) {
    reasons.push({ code: "MISSING_RECORD", detail: "requirements exist and no evidence record was found" });
  } else {
    const shapeProblem = recordShapeProblem(record);
    if (shapeProblem) {
      reasons.push({ code: "MALFORMED_RECORD", detail: shapeProblem });
    } else if (record.policyVersion !== policy.policyVersion) {
      reasons.push({
        code: "POLICY_VERSION",
        detail: `record is stamped ${show(record.policyVersion)}, policy is ${policy.policyVersion}`,
      });
    }
  }
  if (reasons.some((reason) => INVALIDATING.has(reason.code))) {
    return { verdict: VERDICTS.INVALID, reasons, obligations: [], unresolvedReviews: [] };
  }

  // record.base, if present, is deliberately never read: the range comes from
  // the caller's identities alone.
  const context = { policy, identities, history, testRegistry, runtimeEvidence };
  // Code-unit order, explicitly: localeCompare would make obligation order
  // depend on the runner's locale.
  const obligations = [...new Set(requirements)].sort(compareCodeUnits).map((requirement) => {
    const result = evaluateRequirement(requirement, record, context);
    reasons.push(...result.reasons);
    return { requirement, status: result.status };
  });

  // Two axes: reasons say whether the proofs hold; unresolvedReviews say what
  // still needs a review nobody here can authenticate.
  const unresolvedReviews = obligations
    .filter((obligation) => obligation.status === OBLIGATION_STATUS.REPORTED_UNRESOLVED)
    .map((obligation) => obligation.requirement);
  let verdict = VERDICTS.COMPLETE;
  if (reasons.length > 0) verdict = VERDICTS.INCOMPLETE;
  else if (unresolvedReviews.length > 0) verdict = VERDICTS.REVIEW_UNRESOLVED;
  return { verdict, reasons, obligations, unresolvedReviews };
}
