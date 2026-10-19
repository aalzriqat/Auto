import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTrustedImpact } from "./prepareTrustedBrowserSwarmRun.mjs";
import { assertMandatoryBrowserSwarmCoverage } from "./browserAttackSwarm.ts";

/**
 * SCRUM-826 — trusted pre-provisioning coverage gate.
 *
 * Runs immediately after the trusted canonical impact is derived and BEFORE
 * any preview is recreated, any candidate is built, or any E2E is run. It
 * refuses an impact set whose mandatory deterministic missions include a
 * family with no executable handler, and records the mandatory missions it
 * accepted as plan evidence. Jev is deliberately not consulted: exploration
 * may add missions later, but it can never remove or satisfy an obligation.
 *
 * @param {{ repoRoot?: string, env?: Record<string, string | undefined> }} [options]
 */
export async function runBrowserSwarmCoverageGate({
  repoRoot = process.cwd(),
  env = process.env,
} = {}) {
  const baseSha = env.BASE_SHA ?? "";
  const headSha = env.HEAD_SHA ?? "";
  if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error("BASE_SHA and HEAD_SHA must be exact 40-character commit SHAs.");
  }
  const impactPath = path.join(repoRoot, "artifacts/browser-swarm-trusted-impact.json");
  let impactArtifact;
  try {
    impactArtifact = JSON.parse(await readFile(impactPath, "utf8"));
  } catch {
    throw new Error("Trusted browser impact artifact is missing or is not valid JSON.");
  }
  const impactedInvariants = assertTrustedImpact(impactArtifact, { baseSha, headSha });

  const outputDir = path.join(repoRoot, "artifacts");
  const writeEvidence = async (/** @type {Record<string, unknown>} */ value) => {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, "browser-swarm-coverage.json"),
      JSON.stringify(value, null, 2) + "\n",
      "utf8",
    );
  };
  const header = {
    version: 1,
    authority: "TRUSTED_MAIN_BROWSER_SWARM_COVERAGE",
    baseSha,
    headSha,
    impactedInvariants,
  };

  let mandatoryMissions = [];
  if (impactedInvariants.length > 0) {
    try {
      mandatoryMissions = assertMandatoryBrowserSwarmCoverage(
        impactedInvariants,
      ).missions.map((mission) => ({
        id: mission.id,
        family: mission.family,
        invariantIds: [...mission.invariantIds],
        oracle: mission.oracle,
      }));
    } catch (error) {
      // Record the refusal as evidence, then fail the job. Never a pass.
      await writeEvidence({
        ...header,
        status: "REFUSED_UNEXECUTABLE_MANDATORY_MISSIONS",
        reason: error instanceof Error ? error.message : String(error),
        mandatoryMissions: [],
      });
      throw error;
    }
  }

  const result = {
    ...header,
    status: impactedInvariants.length === 0 ? "NO_MANDATORY_IMPACT" : "EXECUTABLE",
    mandatoryMissions,
  };
  await writeEvidence(result);
  process.stdout.write(
    "Trusted browser swarm coverage: " +
      result.status +
      " (" +
      mandatoryMissions.length +
      " mandatory mission(s))\n",
  );
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runBrowserSwarmCoverageGate();
}
