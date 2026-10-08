import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPreviewTargeting } from "./e2ePreviewBootstrap.mjs";

const ATTESTATION_QUERY = "e2eBootstrap:assertE2EBootstrap";

/** Return only fixed categories and public source locations; raw errors may contain tenant data. */
export function summarizeAttestationLogs(jsonl) {
  const summaries = [];
  for (const line of jsonl.split(/\r?\n/)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.kind !== "Completion" || event.identifier !== ATTESTATION_QUERY || typeof event.error !== "string") continue;
    const requestId = /^[a-f0-9]{8,64}$/i.test(event.requestId ?? "") ? event.requestId : "unavailable";
    const errorClass = /\b(ConvexError|TypeError|RangeError|ReferenceError|SyntaxError|Error)\b/.exec(event.error)?.[1] ?? "UnknownError";
    const category = /fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(event.error)
      ? "network"
      : /too many bytes|read limit|too many documents|time limit|timed out/i.test(event.error)
        ? "resource-limit"
        : "unclassified";
    const location = /\b(convex\/[A-Za-z0-9_./-]+\.ts:\d+:\d+)\b/.exec(event.error)?.[1] ?? "unavailable";
    summaries.push(`request=${requestId} class=${errorClass} category=${category} location=${location}`);
  }
  return summaries.slice(-3);
}

/** Run only after the scenario job fails, before its disposable preview is deleted. */
export function diagnosePreviewAttestation(env = process.env, spawn = spawnSync) {
  const previewName = env.CONVEX_PREVIEW_NAME;
  try {
    assertPreviewTargeting({ deployKey: env.CONVEX_DEPLOY_KEY, previewName, env });
    if (!/^e2e-[a-z0-9._-]+$/.test(previewName)) throw new Error("Not a scenario preview name.");
  } catch {
    return "Attestation log diagnostic unavailable: preview targeting was not verified.";
  }

  let result;
  try {
    result = spawn(process.execPath, [
      resolve("node_modules/convex/bin/main.js"),
      "logs", "--deployment", previewName, "--history", "300", "--jsonl",
    ], {
      env,
      encoding: "utf8",
      timeout: 12_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return "Attestation log diagnostic unavailable: Convex log command failed.";
  }
  const summaries = summarizeAttestationLogs(result.stdout ?? "");
  if (summaries.length > 0) return `Attestation backend failures: ${summaries.join("; ")}`;
  if ((result.error && result.error.code !== "ETIMEDOUT") || (result.status !== 0 && result.error?.code !== "ETIMEDOUT")) {
    return "Attestation log diagnostic unavailable: Convex log command failed.";
  }
  return "No attestation backend error found in the captured preview log history.";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(diagnosePreviewAttestation());
}
