import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertExistingE2EPreview, runConvex } from "./e2ePreviewBootstrap.mjs";
import { diagnosePreviewAttestation } from "./previewAttestationDiagnostic.mjs";

const REQUEST_ID = /\[Request ID: ([a-f0-9]{8,64})\]/i;
const CATEGORY = "qa-approver-permissions";

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
  let refused = false;
  let raw = "";

  try {
    await assertPreview(env, {
      run: (args, label) => {
        attempted = true;
        runConvex(args, label, (command, argv) => {
          const result = spawn(command, argv, {
            env,
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          });
          raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
          return { status: result.status, error: result.error };
        });
      },
    });
  } catch {
    refused = attempted;
  }

  if (!attempted) throw new Error("Probe unavailable: preview attestation was not invoked.");
  if (!refused) throw new Error("Probe failed: attestation unexpectedly accepted the reset manager role.");

  const requestId = REQUEST_ID.exec(raw)?.[1]?.toLowerCase();
  raw = "";
  if (!requestId) throw new Error("Probe failed closed, but no backend request ID was captured.");

  // The existing diagnostic reads this bounded scenario-log format. It never
  // sees the unredacted CLI output, and the file contains only the request ID.
  write(
    join(env.RUNNER_TEMP, "deal-scenarios-output.log"),
    `Preview attestation failed: ConvexError: [Request ID: ${requestId}] Server Error\n`,
  );

  let diagnostic = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    diagnostic = diagnose(env);
    const matchingFailure = diagnostic.split("; ").some((entry) =>
      entry.includes(`request=${requestId} `) && entry.includes(`category=${CATEGORY}`),
    );
    if (matchingFailure) {
      return `Controlled preview attestation refused as expected. ${diagnostic}`;
    }
  }
  throw new Error("Probe failed closed, but a matching redacted backend reason was unavailable.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probePreviewAttestation()
    .then((message) => console.log(message))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Controlled preview probe failed.");
      process.exitCode = 1;
    });
}
