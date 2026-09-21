import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewNameForRef } from "../e2ePreviewBootstrap.mjs";
import { validateE2EPreviewDescriptor } from "./e2ePreviewDescriptor.mjs";
import { validateConvexPreviewAuthority } from "./convexPreviewAuthority.mjs";

function exactSha(value, label) {
  if (!/^[0-9a-f]{40}$/i.test(value ?? "")) {
    throw new Error(label + " must be an exact 40-character commit SHA.");
  }
  return value;
}

function positivePrNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }
  return number;
}

function assertTrustedImpact(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Trusted browser impact artifact must be an object.");
  }
  const impact = value;
  if (
    impact.version !== 1 ||
    impact.authority !== "TRUSTED_MAIN_CANONICAL_GIT_IMPACT"
  ) {
    throw new Error("Trusted browser impact artifact has invalid authority metadata.");
  }
  if (impact.baseSha !== expected.baseSha || impact.headSha !== expected.headSha) {
    throw new Error("Trusted browser impact artifact does not match exact base/head.");
  }
  if (!Array.isArray(impact.impactedInvariants)) {
    throw new Error("Trusted browser impact artifact is missing impacted invariants.");
  }
  const impactedInvariants = impact.impactedInvariants.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      (entry.severity !== "CRITICAL" && entry.severity !== "HIGH")
    ) {
      throw new Error(
        "Trusted browser impact invariant " + index + " is malformed.",
      );
    }
    return { id: entry.id.trim(), severity: entry.severity };
  });
  const shouldRun = impactedInvariants.length > 0;
  if (impact.shouldRun !== shouldRun) {
    throw new Error(
      "Trusted browser impact shouldRun does not match its deterministic invariant set.",
    );
  }
  return impactedInvariants;
}

/**
 * @param {{
 *   impactArtifact: unknown,
 *   descriptorArtifact: unknown,
 *   authorityArtifact: unknown,
 *   baseSha: string,
 *   headSha: string,
 *   prNumber: number,
 * }} input
 */
export function assembleTrustedBrowserSwarmRun(input) {
  const baseSha = exactSha(input.baseSha, "baseSha");
  const headSha = exactSha(input.headSha, "headSha");
  const prNumber = positivePrNumber(input.prNumber);
  const expectedPreviewName = previewNameForRef({
    ref: "refs/pull/" + prNumber + "/merge",
    prNumber: String(prNumber),
  });
  const impactedInvariants = assertTrustedImpact(input.impactArtifact, {
    baseSha,
    headSha,
  });
  const descriptor = validateE2EPreviewDescriptor(input.descriptorArtifact, {
    expectedHeadSha: headSha,
    expectedPrNumber: prNumber,
    expectedPreviewName,
  });
  const convexAuthority = validateConvexPreviewAuthority(
    input.authorityArtifact,
    expectedPreviewName,
  );

  const shouldRun = impactedInvariants.length > 0;
  // Two is the initial bounded rollout. Keep the matrix derived from the same
  // trusted workerCount so GitHub cannot drift from the run evidence.
  const workerCount = shouldRun ? 2 : 0;
  const workerMatrix = {
    worker_index: Array.from({ length: workerCount }, (_, index) => index + 1),
  };

  return {
    version: 1,
    authority: "TRUSTED_MAIN_BROWSER_SWARM_RUN",
    baseSha,
    headSha,
    prNumber,
    previewName: descriptor.previewName,
    convexCloudUrl: convexAuthority.convexCloudUrl,
    convexDeploymentName: convexAuthority.deploymentName,
    impactedInvariants,
    shouldRun,
    workerCount,
    workerMatrix,
    planningMode: "TRUSTED_WORKER_RECONSTRUCTION",
  };
}

/**
 * @param {{
 *   repoRoot?: string,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 */
export async function prepareTrustedBrowserSwarmRun({
  repoRoot = process.cwd(),
  env = process.env,
} = {}) {
  const baseSha = exactSha(env.BASE_SHA, "BASE_SHA");
  const headSha = exactSha(env.HEAD_SHA, "HEAD_SHA");
  const prNumber = positivePrNumber(env.PR_NUMBER);
  const impactPath =
    env.TRUSTED_IMPACT_PATH ??
    path.join(repoRoot, "artifacts/browser-swarm-trusted-impact.json");
  const descriptorPath = env.PREVIEW_DESCRIPTOR_PATH;
  if (!descriptorPath) {
    throw new Error("PREVIEW_DESCRIPTOR_PATH is required.");
  }
  const authorityPath =
    env.CONVEX_AUTHORITY_PATH ??
    path.join(repoRoot, "artifacts/browser-swarm-convex-authority.json");

  const [impactRaw, descriptorRaw, authorityRaw] = await Promise.all([
    readFile(impactPath, "utf8"),
    readFile(descriptorPath, "utf8"),
    readFile(authorityPath, "utf8"),
  ]);
  let impactArtifact;
  let descriptorArtifact;
  let authorityArtifact;
  try {
    impactArtifact = JSON.parse(impactRaw);
    descriptorArtifact = JSON.parse(descriptorRaw);
    authorityArtifact = JSON.parse(authorityRaw);
  } catch {
    throw new Error("Trusted browser swarm handoff artifacts must be valid JSON.");
  }

  const payload = assembleTrustedBrowserSwarmRun({
    impactArtifact,
    descriptorArtifact,
    authorityArtifact,
    baseSha,
    headSha,
    prNumber,
  });

  const outputDir = path.join(repoRoot, "artifacts");
  const outputPath = path.join(outputDir, "browser-swarm-trusted-run.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

  if (env.GITHUB_OUTPUT) {
    await appendFile(
      env.GITHUB_OUTPUT,
      [
        "should_run=" + String(payload.shouldRun),
        "worker_count=" + String(payload.workerCount),
        "worker_matrix=" + JSON.stringify(payload.workerMatrix),
        "impacted_invariants_json=" + JSON.stringify(payload.impactedInvariants),
        "preview_name=" + payload.previewName,
        "convex_cloud_url=" + payload.convexCloudUrl,
        "head_sha=" + payload.headSha,
        "pr_number=" + String(payload.prNumber),
        "",
      ].join("\n"),
      "utf8",
    );
  }

  process.stdout.write(
    "Trusted browser swarm run: " +
      payload.impactedInvariants.length +
      " impacted invariant(s), " +
      payload.workerCount +
      " worker(s)\n",
  );
  return payload;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await prepareTrustedBrowserSwarmRun();
}
