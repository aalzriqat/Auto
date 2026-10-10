import { spawnSync } from "node:child_process";
import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPreviewTargeting } from "./e2ePreviewBootstrap.mjs";
import { deploymentNameFromUrl } from "./previewDeploymentLifecycle.mjs";

const ATTESTATION_QUERY = "e2eBootstrap:assertE2EBootstrap";
const SCENARIO_LOG = "deal-scenarios-output.log";
const APPROVER_PERMISSIONS_ERROR = /E2E_BOOTSTRAP: E2E_APPROVER_USER holds role "[^"\r\n]{1,128}", which is missing [^\r\n]{1,256}\. The approval E2E path cannot be driven without it\./;

/** Only the bounded tail is needed: the form explorer runs near the end. */
function readScenarioTail(runnerTemp) {
  const fd = openSync(join(runnerTemp, SCENARIO_LOG), "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function failedAttestationRequestIds(scenarioLog) {
  return [...new Set(
    [...scenarioLog.matchAll(/Preview attestation failed:[^\r\n]*?\[Request ID: ([a-f0-9]{8,64})\]/gi)]
      .map((match) => match[1]),
  )].slice(-3);
}

/** Return only fixed categories and public source locations; raw errors may contain tenant data. */
export function summarizeAttestationLogs(jsonl, requestIds) {
  const summaries = [];
  const wanted = new Set(requestIds);
  for (const line of jsonl.split(/\r?\n/)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.kind !== "Completion" || event.identifier !== ATTESTATION_QUERY || typeof event.error !== "string" || !wanted.has(event.requestId)) continue;
    const requestId = event.requestId;
    const errorClass = /\b(ConvexError|TypeError|RangeError|ReferenceError|SyntaxError|Error)\b/.exec(event.error)?.[1] ?? "UnknownError";
    let category = "unclassified";
    if (APPROVER_PERMISSIONS_ERROR.test(event.error)) {
      category = "qa-approver-permissions";
    } else if (/fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(event.error)) {
      category = "network";
    } else if (/too many bytes|read limit|too many documents|time limit|timed out/i.test(event.error)) {
      category = "resource-limit";
    }
    const locationMatch = /\bconvex\/e2eBootstrap\.ts:(\d{1,6}):(\d{1,4})\b/.exec(event.error);
    const location = locationMatch ? `convex/e2eBootstrap.ts:${locationMatch[1]}:${locationMatch[2]}` : "unavailable";
    summaries.push(`request=${requestId} class=${errorClass} category=${category} location=${location}`);
  }
  return summaries.slice(-3);
}

/** Run only after the scenario job fails, before its disposable preview is deleted. */
/** @param {NodeJS.ProcessEnv} [env]
 * @param {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => { status: number | null, stdout: string, stderr?: string, error?: { code?: string } }} [spawn]
 */
export function diagnosePreviewAttestation(env = process.env, spawn = spawnSync) {
  const previewName = env.CONVEX_PREVIEW_NAME;
  try {
    assertPreviewTargeting({ deployKey: env.CONVEX_DEPLOY_KEY, previewName, env });
    if (!/^e2e-[a-z0-9._-]+$/.test(previewName)) throw new Error("Not a scenario preview name.");
    deploymentNameFromUrl(env.CONVEX_PREVIEW_URL);
    if (!Number.isSafeInteger(Number(env.CONVEX_PREVIEW_CREATED_AT)) || Number(env.CONVEX_PREVIEW_CREATED_AT) <= 0) {
      throw new Error("No pinned preview creation time.");
    }
  } catch {
    return "Attestation log diagnostic unavailable: preview targeting was not verified.";
  }

  let requestIds;
  try {
    requestIds = failedAttestationRequestIds(readScenarioTail(env.RUNNER_TEMP));
  } catch {
    return "Attestation log diagnostic unavailable: scenario output was not captured.";
  }
  if (requestIds.length === 0) {
    return "No backend request ID was captured for preview attestation; log correlation unavailable.";
  }

  let result;
  try {
    result = spawn(process.execPath, [
      resolve("node_modules/convex/bin/main.js"),
      // The installed CLI hides --preview-name in help, but supports it for
      // preview-key authorization. --deployment with the bare identifier does not.
      "logs", "--preview-name", previewName, "--history", "300", "--jsonl",
    ], {
      env,
      encoding: "utf8",
      timeout: 12_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return "Attestation log diagnostic unavailable: Convex log command failed.";
  }
  // A failed or timed-out log command may have produced only a partial stream.
  // Do not promote that output to a request-correlated backend verdict.
  if (result.error || result.status !== 0) {
    return "Attestation log diagnostic unavailable: Convex log command failed.";
  }
  const summaries = summarizeAttestationLogs(result.stdout ?? "", requestIds);
  if (summaries.length > 0) return `Attestation backend failures: ${summaries.join("; ")}`;
  return "Attestation log diagnostic unavailable: no matching completion arrived before the bounded log read ended.";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(diagnosePreviewAttestation());
}
