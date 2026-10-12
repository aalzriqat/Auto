import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EGRESS_DENIAL_REASONS } from "./browserEgressContainment.mjs";

/**
 * Independent check of the evidence written by browserEgressProof.mjs
 * (SCRUM-350 G4-02). The workflow runs it on the saved JSON before any
 * authenticated candidate traffic, so a proof that failed, produced nothing, or
 * produced something other than a full pass cannot be followed by tests or a
 * trusted verdict. It prints only fixed strings: the evidence is never echoed.
 *
 * @param {unknown} evidence
 * @returns {string[]} failures (empty when the evidence is a full pass)
 */
export function verifyEgressProofEvidence(evidence) {
  const failures = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return ["evidence is not a JSON object"];
  }
  const e = /** @type {Record<string, any>} */ (evidence);
  if (e.ok !== true) failures.push("ok is not true");
  if (!Array.isArray(e.failures) || e.failures.length !== 0) failures.push("failures is not an empty array");
  if (e.collector?.tcpEvents !== 0) failures.push("collector tcpEvents is not 0");
  if (e.collector?.udpPackets !== 0) failures.push("collector udpPackets is not 0");
  if (e.allowedStatus !== 200) failures.push("allowlisted origin status is not 200");
  if (e.channels?.["service-worker"] !== "blocked") failures.push("service worker was not reported blocked");

  const denials = e.proxyDenials;
  if (!denials || typeof denials !== "object" || Array.isArray(denials)) {
    failures.push("proxyDenials is missing");
  } else {
    for (const [key, value] of Object.entries(denials)) {
      if (key !== "unrecognized" && !EGRESS_DENIAL_REASONS.includes(key)) {
        failures.push("proxyDenials has a key outside the fixed vocabulary");
      }
      if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) {
        failures.push("proxyDenials has a non-count value");
      }
    }
    if ((denials["not-allowlisted-loopback"] ?? 0) < 1) {
      failures.push("no denial of the loopback collector probe was recorded");
    }
    if ((denials.unrecognized ?? 0) !== 0) failures.push("the proxy log held lines outside the fixed vocabulary");
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failures;
  try {
    const file = process.argv[2];
    if (!file) throw new Error("no evidence file");
    failures = verifyEgressProofEvidence(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    failures = ["evidence file is missing or is not valid JSON"];
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`::error::Egress proof evidence rejected: ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write("Egress proof evidence verified.\n");
}
