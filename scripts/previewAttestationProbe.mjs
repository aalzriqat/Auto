import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertExistingE2EPreview, runConvex } from "./e2ePreviewBootstrap.mjs";
import { diagnosePreviewAttestation, failedAttestationRequestIds } from "./previewAttestationDiagnostic.mjs";

const CATEGORY = "qa-approver-permissions";
const REDACTED_ENTRY = /^request=([a-f0-9]{8,64}) class=(?:ConvexError|TypeError|RangeError|ReferenceError|SyntaxError|Error|UnknownError) category=([a-z-]+) location=(?:convex\/e2eBootstrap\.ts:\d{1,6}:\d{1,4}|unavailable)$/;

function matchingRedactedEntry(diagnostic, requestId) {
  const prefix = "Attestation backend failures: ";
  if (!diagnostic.startsWith(prefix)) return null;
  for (const part of diagnostic.slice(prefix.length).split("; ")) {
    const fields = REDACTED_ENTRY.exec(part);
    if (fields?.[1] === requestId && fields[2] === CATEGORY) return part;
  }
  return null;
}

// Keep this selection aligned with attestedPreview.ts, the real form explorer's
// failure-line producer. A split-line Request ID must fail this probe too.
export function scenarioFailureLine(stderr, errorMessage, status) {
  const lines = (stderr || errorMessage || "").split("\n").filter((line) => line.trim());
  const reason = (lines.find((line) => /Error/.test(line)) ?? lines.at(-1))?.trim() ?? `exit ${status}`;
  return `Preview attestation failed: ${reason}`;
}

/**
 * Exercise the expected attestation refusal after the disposable preview's
 * approver is reset to the ordinary MANAGER template. Raw CLI output stays in
 * memory: this public repository's Actions log receives only fixed text and
 * the request-correlated, redacted backend category.
 */
export async function probePreviewAttestation(env = process.env, deps = {}) {
  const {
    assertPreview = assertExistingE2EPreview,
    diagnose = diagnosePreviewAttestation,
    spawn = spawnSync,
    write = writeFileSync,
  } = deps;

  if (!env.RUNNER_TEMP) throw new Error("Probe unavailable: RUNNER_TEMP is missing.");
  let attempted = false;
  let exitStatus = null;
  let launchError = false;
  let failureLine = "";

  try {
    await assertPreview(env, {
      run: (args, label) => {
        attempted = true;
        runConvex(args, label, (command, argv) => {
          const result = spawn(command, argv, {
            env,
            encoding: "utf8",
            // Match the real form explorer's attestation deadline.
            timeout: 180_000,
            maxBuffer: 1024 * 1024,
          });
          exitStatus = result.status;
          launchError = Boolean(result.error);
          failureLine = scenarioFailureLine(result.stderr, result.error?.message, result.status);
          return { status: result.status, error: result.error };
        });
      },
    });
  } catch {}

  if (!attempted) throw new Error("Probe unavailable: preview attestation was not invoked.");
  if (exitStatus === 0 && !launchError) throw new Error("Probe failed: attestation unexpectedly accepted the reset manager role.");
  if (!Number.isInteger(exitStatus) || exitStatus <= 0 || launchError) {
    throw new Error("Probe failed: attestation refusal was not confirmed.");
  }

  const requestId = failedAttestationRequestIds(failureLine)[0];
  if (!requestId) throw new Error("Probe failed closed, but no backend request ID was captured.");

  // The scenario log is runner-local and is never uploaded or printed. The
  // public job log receives only the diagnostic's fixed redacted fields.
  write(
    join(env.RUNNER_TEMP, "deal-scenarios-output.log"),
    `${failureLine}\n`,
  );

  let diagnostic = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    diagnostic = diagnose(env);
    const matchingFailure = matchingRedactedEntry(diagnostic, requestId);
    if (matchingFailure) {
      return `Controlled preview attestation refused as expected. Attestation backend failure: ${matchingFailure}`;
    }
  }
  throw new Error("Probe failed closed, but a matching redacted backend reason was unavailable.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(await probePreviewAttestation());
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Controlled preview probe failed.");
    process.exitCode = 1;
  }
}
