import { isProtectedReplayBinding, isTrustedRoleReplayBinding } from "../intelligence/trustedBrowserReplayPolicy.mjs";

const SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_BYTES = 16 * 1024;
const MAX_RECORDS = 24;

function sameCandidate(left, right) {
  return left && ["repositoryId", "prNumber", "workflowRunId", "workflowAttempt"].every(key =>
    Number.isSafeInteger(right[key]) && right[key] > 0 && left[key] === right[key]) &&
    ["baseSha", "headSha", "testedSha"].every(key => typeof left[key] === "string" && SHA.test(left[key]) && left[key] === right[key]);
}

function validBinding(record) {
  return record?.status === "active" && record.domain === "screen" && record.level === "browser" &&
    typeof record.id === "string" && ID.test(record.id) && typeof record.fingerprint === "string" && FINGERPRINT.test(record.fingerprint) &&
    typeof record.impl?.testName === "string" && record.impl.testName.length > 0 && record.impl.testName.length <= 512 &&
    isProtectedReplayBinding(record);
}

export function buildBrowserReplayManifest(candidate, records, verdicts) {
  const passed = new Map(verdicts.filter(({ code }) => code === "PASS").map(({ id, evidence }) => [id, evidence ?? "browser-replay"]));
  return { version: 1, candidate, records: records.flatMap(record => {
    const evidence = passed.get(record.id);
    if (!validBinding(record) || evidence !== (isTrustedRoleReplayBinding(record) ? "role-audit" : "browser-replay")) return [];
    const { id, status, domain, level, fingerprint, impl: { file, testName } } = record;
    return [{ id, status, domain, level, fingerprint, impl: { file, testName }, evidence }];
  }) };
}

// Transport is the output of the separate verification job in this workflow
// run. This reader independently joins the selected candidate definitions.
export function readBrowserReplayManifest(raw, candidate, selected) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_BYTES) return [];
  try {
    const manifest = JSON.parse(raw);
    if (manifest?.version !== 1 || !sameCandidate(manifest.candidate, candidate) ||
        !Array.isArray(manifest.records) || manifest.records.length > MAX_RECORDS) return [];
    const trusted = new Map();
    for (const record of manifest.records) {
      if (!validBinding(record) || trusted.has(record.id) ||
          record.evidence !== (isTrustedRoleReplayBinding(record) ? "role-audit" : "browser-replay")) return [];
      trusted.set(record.id, record);
    }
    return selected.flatMap(record => {
      const proven = trusted.get(record.id);
      if (!proven || !validBinding(record) || selected.filter(row => row.id === record.id).length !== 1 ||
          record.fingerprint !== proven.fingerprint || record.impl.file !== proven.impl.file || record.impl.testName !== proven.impl.testName) return [];
      return [{ id: record.id, code: "PASS", ...(proven.evidence === "role-audit" ? { evidence: "role-audit" } : {}) }];
    });
  } catch {
    return [];
  }
}
