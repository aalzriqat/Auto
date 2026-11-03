import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewNameForRef } from "../e2ePreviewBootstrap.mjs";
import {
  SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME,
  SWARM_LOCAL_CONVEX_ORIGIN,
} from "./swarmConvexOrigin.mjs";

/**
 * SCRUM-892: the swarm's backend authority is no longer a Convex control-plane
 * answer (convexPreviewAuthority.mjs asked api.convex.dev which cloud preview
 * holds a name). The backend is now a self-hosted Convex that every job starts
 * inside its own runner, at one fixed loopback address. There is nothing to
 * resolve, so this artifact is a trusted constant, written by trusted main
 * code and validated strictly, field by field, before the run is assembled.
 *
 * The artifact keeps the `convexCloudUrl` and `deploymentName` field names so
 * the run payload and every downstream reader keep one shape; the values are
 * the local ones.
 */
export const LOCAL_CONVEX_AUTHORITY = "LOCAL_SELF_HOSTED_CONVEX";
export const LOCAL_CONVEX_MODE = "LOCAL_SELF_HOSTED";

const ALLOWED_FIELDS = Object.freeze([
  "version",
  "authority",
  "mode",
  "previewName",
  "convexCloudUrl",
  "deploymentName",
]);

/**
 * @param {unknown} value
 * @param {string} expectedPreviewName
 */
export function validateLocalConvexAuthority(value, expectedPreviewName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local Convex authority artifact must be an object.");
  }
  const artifact = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(artifact);
  if (keys.length !== ALLOWED_FIELDS.length || keys.some((key) => !ALLOWED_FIELDS.includes(key))) {
    throw new Error("Local Convex authority artifact contains unexpected or missing fields.");
  }
  if (
    artifact.version !== 1 ||
    artifact.authority !== LOCAL_CONVEX_AUTHORITY ||
    artifact.mode !== LOCAL_CONVEX_MODE
  ) {
    throw new Error("Local Convex authority metadata is invalid.");
  }
  if (typeof artifact.previewName !== "string" || artifact.previewName !== expectedPreviewName) {
    throw new Error("Local Convex authority does not match the trusted preview name.");
  }
  // Exact string, not a normalised origin: the one value the whole run uses.
  if (artifact.convexCloudUrl !== SWARM_LOCAL_CONVEX_ORIGIN) {
    throw new Error("Local Convex authority must name the exact local Convex origin.");
  }
  if (artifact.deploymentName !== SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME) {
    throw new Error("Local Convex authority deployment name is not the local instance name.");
  }
  return {
    version: 1,
    authority: LOCAL_CONVEX_AUTHORITY,
    mode: LOCAL_CONVEX_MODE,
    previewName: artifact.previewName,
    convexCloudUrl: SWARM_LOCAL_CONVEX_ORIGIN,
    deploymentName: SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME,
  };
}

function positivePrNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }
  return number;
}

/**
 * @param {{ repoRoot?: string, env?: Record<string, string | undefined> }} [options]
 */
export async function writeLocalConvexAuthority({
  repoRoot = process.cwd(),
  env = process.env,
} = {}) {
  const prNumber = positivePrNumber(env.PR_NUMBER);
  const previewName = previewNameForRef({
    ref: "refs/pull/" + prNumber + "/merge",
    prNumber: String(prNumber),
  });
  const artifact = validateLocalConvexAuthority(
    {
      version: 1,
      authority: LOCAL_CONVEX_AUTHORITY,
      mode: LOCAL_CONVEX_MODE,
      previewName,
      convexCloudUrl: SWARM_LOCAL_CONVEX_ORIGIN,
      deploymentName: SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME,
    },
    previewName,
  );
  const outputDir = path.join(repoRoot, "artifacts");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "browser-swarm-convex-authority.json"),
    JSON.stringify(artifact, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write("Wrote the local Convex authority for " + previewName + ".\n");
  return artifact;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await writeLocalConvexAuthority();
}
