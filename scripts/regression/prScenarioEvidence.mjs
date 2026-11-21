import { createHash } from "node:crypto";
import { isProtectedReplayBinding, isTrustedRoleReplayBinding } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { readBrowserReplayManifest, sameReplayCandidate } from "./trustedBrowserManifest.mjs";
import { selectForPr, summarise } from "./prRunner.mjs";
import { retirementProblems, validateTransitions } from "./scenarioTransitions.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_LOCAL_BYTES = 1024 * 1024;
const MAX_BROWSER_BYTES = 16 * 1024;

export function scenarioEvidenceDigest(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function preserveScenarioObligations({ baseRecords, candidateRecords, selection, changed, protectedRulings }) {
  const byId = new Map();
  for (const record of candidateRecords) {
    if (typeof record?.id !== "string" || !record.id || byId.has(record.id) ||
        !["candidate", "active", "retired"].includes(record.status)) {
      throw new Error("SCENARIO_REGISTRY_INVALID");
    }
    byId.set(record.id, record);
  }
  if (validateTransitions(baseRecords, candidateRecords).length) throw new Error("ACTIVE_SCENARIO_NOT_RETAINED");
  const rulingById = new Map(protectedRulings.map(ruling => [ruling.id, ruling.digest]));
  for (const before of baseRecords) {
    if (before.status !== "active") continue;
    const after = byId.get(before.id);
    if (after.status === "retired") {
      if (retirementProblems(after, rulingById).length) throw new Error("SCENARIO_RETIREMENT_UNPROVEN");
    } else if (isProtectedReplayBinding(before) && !isProtectedReplayBinding(after)) {
      throw new Error("PROTECTED_SCENARIO_CLASS_CHANGED");
    }
  }
  const baseSelection = selectForPr(baseRecords, changed);
  const selectedIds = new Set([...selection.run, ...selection.browserSelected].map(record => record.id));
  for (const before of [...baseSelection.run, ...baseSelection.browserSelected]) {
    if (byId.get(before.id).status === "active" && !selectedIds.has(before.id)) throw new Error("ACTIVE_SCENARIO_NOT_SELECTED");
  }
  return baseSelection.browserSelected.filter(isProtectedReplayBinding);
}

function bindingDigest(record) {
  const { id, fingerprint, impl } = record;
  if (typeof id !== "string" || !id || typeof fingerprint !== "string" || !SHA256.test(fingerprint) ||
      typeof impl?.file !== "string" || !impl.file ||
      typeof impl?.testName !== "string" || !impl.testName) throw new Error("SCENARIO_BINDING_INVALID");
  return scenarioEvidenceDigest(JSON.stringify([id, fingerprint, impl.file, impl.testName]));
}

function localRows(records, results) {
  if (!Array.isArray(results) || results.length !== records.length) throw new Error("LOCAL_SCENARIO_COVERAGE_INVALID");
  const bindings = new Map(records.map(record => [record.id, bindingDigest(record)]));
  const rows = [];
  for (const { id, code } of results) {
    const binding = bindings.get(id);
    if (!binding) throw new Error("LOCAL_SCENARIO_COVERAGE_INVALID");
    bindings.delete(id);
    rows.push({ id, binding, code });
  }
  if (bindings.size) throw new Error("LOCAL_SCENARIO_COVERAGE_INVALID");
  return rows;
}

export function createLocalScenarioEvidence(candidate, { selection, verdicts, browserVerdicts, issues }) {
  return JSON.stringify({
    version: 1,
    candidate,
    backend: localRows(selection.run, verdicts),
    browser: localRows(selection.browserSelected, browserVerdicts),
    issues,
  });
}

function parseEvidence(raw, byteLimit, error) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > byteLimit) throw new Error(error);
  try {
    const value = JSON.parse(raw);
    if (value?.version === 1) return value;
  } catch {
    // A malformed transport may never create a verdict.
  }
  throw new Error(error);
}

function indexRows(records, rows) {
  if (!Array.isArray(rows) || rows.length !== records.length) throw new Error("LOCAL_SCENARIO_COVERAGE_INVALID");
  const expected = new Map(records.map(record => [record.id, record]));
  const matched = [];
  for (const row of rows) {
    const record = expected.get(row?.id);
    if (!record || row.binding !== bindingDigest(record)) throw new Error("LOCAL_SCENARIO_COVERAGE_INVALID");
    expected.delete(row.id);
    matched.push({ id: row.id, code: row.code, record });
  }
  if (expected.size) throw new Error("LOCAL_SCENARIO_COVERAGE_INVALID");
  return matched;
}

export function readLocalScenarioEvidence(raw, digest, candidate, selection) {
  const local = parseEvidence(raw, MAX_LOCAL_BYTES, "LOCAL_SCENARIO_EVIDENCE_INVALID");
  if (scenarioEvidenceDigest(raw) !== digest || !sameReplayCandidate(local.candidate, candidate) ||
      !Array.isArray(local.issues) || local.issues.length !== 0) throw new Error("LOCAL_SCENARIO_EVIDENCE_INVALID");
  const ids = [...selection.run, ...selection.browserSelected].map(record => record.id);
  if (new Set(ids).size !== ids.length) throw new Error("LOCAL_SCENARIO_COVERAGE_INVALID");
  const backend = indexRows(selection.run, local.backend);
  const browser = indexRows(selection.browserSelected, local.browser);
  if (backend.some(row => row.code !== "PASS") || browser.some(({ code, record }) =>
    code !== "PASS" && (!isProtectedReplayBinding(record) ||
      code !== (isTrustedRoleReplayBinding(record) ? "ROLE_AUDIT_EVIDENCE_NOT_JOINED" : "BROWSER_REPLAY_NOT_EXECUTED")))) {
    throw new Error("LOCAL_SCENARIO_VERDICT_REFUSED");
  }
  // This report intentionally carries pending protected browser outcomes. It is
  // never a final PASS, even when every local execution succeeded.
  if (summarise(selection, backend, [], browser, "pr").issues.length) throw new Error("LOCAL_SCENARIO_EVIDENCE_INVALID");
  return { backend, browser };
}

export function finishPrScenarioEvidence({ candidate, selection, protectedSelection, localRaw, localDigest, browserRaw }) {
  const { backend, browser } = readLocalScenarioEvidence(localRaw, localDigest, candidate, selection);
  const manifest = parseEvidence(browserRaw, MAX_BROWSER_BYTES, "PROTECTED_SCENARIO_EVIDENCE_INVALID");
  const expected = selection.browserSelected.filter(isProtectedReplayBinding);
  if (!sameReplayCandidate(manifest.candidate, candidate) ||
      !Array.isArray(protectedSelection) || !Array.isArray(manifest.records) || manifest.records.length !== protectedSelection.length ||
      manifest.records.some(record => !record || Object.hasOwn(record, "code")) ||
      readBrowserReplayManifest(browserRaw, candidate, protectedSelection).length !== protectedSelection.length) {
    throw new Error("PROTECTED_SCENARIO_EVIDENCE_INVALID");
  }
  const protectedPasses = readBrowserReplayManifest(browserRaw, candidate, expected);
  if (protectedPasses.length !== expected.length || protectedPasses.some(({ code }) => code !== "PASS")) {
    throw new Error("PROTECTED_SCENARIO_EVIDENCE_INVALID");
  }
  const verifiedIds = new Set(protectedPasses.map(({ id }) => id));
  const joined = browser.map(({ id, code }) => ({ id, code: verifiedIds.has(id) ? "PASS" : code }));
  return summarise(selection, backend, [], joined, "pr");
}
