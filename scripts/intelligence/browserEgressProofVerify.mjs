import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EGRESS_DENIAL_REASONS } from "./browserEgressContainment.mjs";
import { EGRESS_PROOF_CHANNELS, EGRESS_PROOF_NAVIGATION_OUTCOMES } from "./browserEgressChannels.mjs";

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

  // Every mandatory probe must be present with a contained outcome; unknown
  // probes are rejected so the record cannot drift from the proof's source.
  const channels = e.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    failures.push("channels is missing");
  } else {
    for (const [name, accepted] of Object.entries(EGRESS_PROOF_CHANNELS)) {
      if (!Object.hasOwn(channels, name)) failures.push(`mandatory probe "${name}" is missing`);
      else if (!accepted.includes(channels[name])) failures.push(`mandatory probe "${name}" has an uncontained outcome`);
    }
    for (const name of Object.keys(channels)) {
      if (!Object.hasOwn(EGRESS_PROOF_CHANNELS, name)) failures.push("an unlisted probe is present");
    }
  }
  if (!EGRESS_PROOF_NAVIGATION_OUTCOMES.includes(e.topLevelNavigation)) {
    failures.push("top-level navigation outcome is missing or uncontained");
  }

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

/**
 * The one evidence file this verifier ever reads: the path browser-attack-swarm.yml
 * writes browserEgressProof.mjs output to and passes back on the command line.
 */
export const EGRESS_EVIDENCE_PATH = "egress-evidence/browser-egress-proof.json";

/**
 * Returns the path of the fixed evidence file under `cwd`. The command-line
 * argument is accepted only to keep the workflow interface: it is compared with
 * EGRESS_EVIDENCE_PATH by exact string equality and never used as a path, so no
 * caller-supplied value reaches the filesystem. The returned path is built from
 * the constant alone, and must be a regular file that is not a symbolic link
 * (readFileSync would follow a link to anywhere).
 *
 * @param {string | undefined} file
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveEvidencePath(file, cwd = process.cwd()) {
  if (file !== EGRESS_EVIDENCE_PATH) {
    throw new Error("evidence path is not the fixed egress evidence path");
  }
  const fixed = path.join(cwd, EGRESS_EVIDENCE_PATH);
  const stat = lstatSync(fixed);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("evidence path is not a regular file");
  }
  return fixed;
}

/**
 * CLI body. Every failure to obtain readable, valid JSON evidence (including any
 * argument other than the fixed evidence path, or a symlinked evidence file) is
 * reported with the same fixed message.
 *
 * @param {string | undefined} file
 * @param {{ stdout?: (text: string) => void, stderr?: (text: string) => void, exit?: (code: number) => void, cwd?: string }} [io]
 */
export function runEvidenceVerifierCli(file, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const exit = io.exit ?? ((code) => process.exit(code));
  let failures;
  try {
    if (!file) throw new Error("no evidence file");
    failures = verifyEgressProofEvidence(JSON.parse(readFileSync(resolveEvidencePath(file, io.cwd), "utf8")));
  } catch {
    failures = ["evidence file is missing or is not valid JSON"];
  }
  if (failures.length > 0) {
    for (const failure of failures) stderr(`::error::Egress proof evidence rejected: ${failure}\n`);
    exit(1);
    return;
  }
  stdout("Egress proof evidence verified.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEvidenceVerifierCli(process.argv[2]);
}
