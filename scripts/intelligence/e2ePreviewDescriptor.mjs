import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PreviewTargetingError,
  assertPreviewTargeting,
} from "../e2ePreviewBootstrap.mjs";

function assertConvexCloudOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value ?? "");
  } catch {
    throw new PreviewTargetingError(
      "NEXT_PUBLIC_CONVEX_URL must be a valid Convex cloud deployment origin.",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    !/^[a-z0-9-]+\.convex\.cloud$/.test(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PreviewTargetingError(
      "NEXT_PUBLIC_CONVEX_URL must be a bare https://*.convex.cloud origin.",
    );
  }
  return parsed.origin;
}

/**
 * Re-validates an untrusted descriptor artifact in a trusted workflow.
 *
 * @param {unknown} value
 * @param {{
 *   expectedHeadSha: string,
 *   expectedPrNumber: number,
 *   expectedPreviewName: string,
 * }} expected
 */
export function validateE2EPreviewDescriptor(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreviewTargetingError(
      "E2E preview descriptor must be an object.",
    );
  }

  const descriptor = /** @type {Record<string, unknown>} */ (value);
  const allowedKeys = new Set([
    "version",
    "previewName",
    "convexCloudUrl",
    "headSha",
    "prNumber",
  ]);
  const unexpected = Object.keys(descriptor).filter(
    (key) => !allowedKeys.has(key),
  );
  if (unexpected.length > 0) {
    throw new PreviewTargetingError(
      "E2E preview descriptor contains unexpected fields.",
    );
  }

  if (descriptor.version !== 1) {
    throw new PreviewTargetingError(
      "E2E preview descriptor version is not supported.",
    );
  }
  if (
    typeof descriptor.previewName !== "string" ||
    descriptor.previewName !== expected.expectedPreviewName
  ) {
    throw new PreviewTargetingError(
      "E2E preview descriptor preview name does not match the trusted workflow expectation.",
    );
  }

  const convexCloudUrl = assertConvexCloudOrigin(
    typeof descriptor.convexCloudUrl === "string"
      ? descriptor.convexCloudUrl
      : undefined,
  );

  if (
    typeof descriptor.headSha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(descriptor.headSha) ||
    descriptor.headSha !== expected.expectedHeadSha
  ) {
    throw new PreviewTargetingError(
      "E2E preview descriptor head SHA does not match the trusted workflow head.",
    );
  }

  if (
    typeof descriptor.prNumber !== "number" ||
    !Number.isSafeInteger(descriptor.prNumber) ||
    descriptor.prNumber <= 0 ||
    descriptor.prNumber !== expected.expectedPrNumber
  ) {
    throw new PreviewTargetingError(
      "E2E preview descriptor PR number does not match the trusted workflow PR.",
    );
  }

  return {
    version: 1,
    previewName: descriptor.previewName,
    convexCloudUrl,
    headSha: descriptor.headSha,
    prNumber: descriptor.prNumber,
  };
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function buildE2EPreviewDescriptor(env) {
  const deployKey = env.CONVEX_DEPLOY_KEY;
  const previewName = env.CONVEX_PREVIEW_NAME;
  assertPreviewTargeting({ deployKey, previewName, env });

  const convexCloudUrl = assertConvexCloudOrigin(env.NEXT_PUBLIC_CONVEX_URL);
  const headSha = env.HEAD_SHA;
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? "")) {
    throw new PreviewTargetingError(
      "HEAD_SHA must be an exact 40-character candidate commit SHA.",
    );
  }

  const prNumber = env.PR_NUMBER?.trim();
  if (!/^\d+$/.test(prNumber ?? "")) {
    throw new PreviewTargetingError(
      "PR_NUMBER must be the numeric pull-request number.",
    );
  }

  return {
    version: 1,
    previewName,
    convexCloudUrl,
    headSha,
    prNumber: Number(prNumber),
  };
}

/**
 * @param {{
 *   repoRoot?: string,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 */
export async function writeE2EPreviewDescriptor({
  repoRoot = process.cwd(),
  env = process.env,
} = {}) {
  const descriptor = buildE2EPreviewDescriptor(env);
  const outputDir = path.join(repoRoot, "artifacts");
  const outputPath = path.join(outputDir, "e2e-preview-descriptor.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(descriptor, null, 2) + "\n", "utf8");
  process.stdout.write("Wrote sanitized E2E preview descriptor.\n");
  return descriptor;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await writeE2EPreviewDescriptor();
}
