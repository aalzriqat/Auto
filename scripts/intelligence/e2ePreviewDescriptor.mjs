import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PreviewTargetingError,
  previewNameForRef,
} from "../e2ePreviewBootstrap.mjs";

const DESCRIPTOR_VERSION = 2;

/**
 * Re-validates the candidate-produced handoff as identity data only.
 *
 * Deliberately absent: any Convex deployment URL. The trusted workflow resolves
 * previewName -> deployment URL independently through Convex's control plane.
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

  if (descriptor.version !== DESCRIPTOR_VERSION) {
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
    version: DESCRIPTOR_VERSION,
    previewName: descriptor.previewName,
    headSha: descriptor.headSha,
    prNumber: descriptor.prNumber,
  };
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function buildE2EPreviewDescriptor(env) {
  const prNumberRaw = env.PR_NUMBER?.trim();
  if (!/^\d+$/.test(prNumberRaw ?? "")) {
    throw new PreviewTargetingError(
      "PR_NUMBER must be the numeric pull-request number.",
    );
  }
  const prNumber = Number(prNumberRaw);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new PreviewTargetingError(
      "PR_NUMBER must be a positive safe integer.",
    );
  }

  const previewName = env.CONVEX_PREVIEW_NAME;
  const expectedPreviewName = previewNameForRef({
    ref: "refs/pull/" + prNumber + "/merge",
    prNumber: String(prNumber),
  });
  if (previewName !== expectedPreviewName) {
    throw new PreviewTargetingError(
      "CONVEX_PREVIEW_NAME does not match the deterministic PR preview identity.",
    );
  }

  const headSha = env.HEAD_SHA;
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? "")) {
    throw new PreviewTargetingError(
      "HEAD_SHA must be an exact 40-character candidate commit SHA.",
    );
  }

  return {
    version: DESCRIPTOR_VERSION,
    previewName,
    headSha,
    prNumber,
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
  process.stdout.write("Wrote sanitized E2E preview identity descriptor.\n");
  return descriptor;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await writeE2EPreviewDescriptor();
}
