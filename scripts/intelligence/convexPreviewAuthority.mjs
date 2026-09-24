import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewNameForRef } from "../e2ePreviewBootstrap.mjs";

const CONVEX_PROVISION_ORIGIN = "https://api.convex.dev";
const AUTHORIZE_PREVIEW_URL =
  CONVEX_PROVISION_ORIGIN + "/api/deployment/authorize_preview";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CONVEX_CLIENT_HEADER = "npm-cli-1.42.1";
const SAFE_PREVIEW_NAME = /^[a-z0-9][a-z0-9._-]{0,60}$/;

function positivePrNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }
  return number;
}

export function parsePreviewDeployKey(deployKey) {
  if (typeof deployKey !== "string" || !deployKey.trim()) {
    throw new Error("CONVEX_PREVIEW_DEPLOY_KEY is required.");
  }

  const separator = deployKey.indexOf("|");
  if (separator <= 0 || separator === deployKey.length - 1) {
    throw new Error("CONVEX_PREVIEW_DEPLOY_KEY is malformed.");
  }

  const prefix = deployKey.slice(0, separator);
  const secret = deployKey.slice(separator + 1);
  const parts = prefix.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== "preview" ||
    !parts[1] ||
    !parts[2] ||
    parts[1].length > 200 ||
    parts[2].length > 200 ||
    !secret
  ) {
    throw new Error(
      "CONVEX_PREVIEW_DEPLOY_KEY must be a preview:team:project deploy key.",
    );
  }

  return {
    teamSlug: parts[1],
    projectSlug: parts[2],
  };
}

export function assertConvexCloudOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value ?? "");
  } catch {
    throw new Error(
      "Convex control plane returned an invalid deployment URL.",
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
    throw new Error(
      "Convex control plane returned a non-canonical convex.cloud deployment origin.",
    );
  }
  return parsed.origin;
}

export function validateConvexPreviewAuthority(value, expectedPreviewName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Convex preview authority artifact must be an object.");
  }
  const artifact = /** @type {Record<string, unknown>} */ (value);
  const allowed = new Set([
    "version",
    "authority",
    "previewName",
    "convexCloudUrl",
    "deploymentName",
  ]);
  if (Object.keys(artifact).some((key) => !allowed.has(key))) {
    throw new Error(
      "Convex preview authority artifact contains unexpected fields.",
    );
  }
  if (
    artifact.version !== 1 ||
    artifact.authority !== "CONVEX_CONTROL_PLANE_AUTHORIZE_PREVIEW"
  ) {
    throw new Error("Convex preview authority metadata is invalid.");
  }
  if (
    typeof artifact.previewName !== "string" ||
    artifact.previewName !== expectedPreviewName
  ) {
    throw new Error(
      "Convex preview authority does not match the trusted preview name.",
    );
  }
  if (
    typeof artifact.deploymentName !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,100}$/.test(artifact.deploymentName)
  ) {
    throw new Error("Convex preview authority deployment name is malformed.");
  }

  return {
    version: 1,
    authority: "CONVEX_CONTROL_PLANE_AUTHORIZE_PREVIEW",
    previewName: artifact.previewName,
    convexCloudUrl: assertConvexCloudOrigin(
      typeof artifact.convexCloudUrl === "string"
        ? artifact.convexCloudUrl
        : undefined,
    ),
    deploymentName: artifact.deploymentName,
  };
}

async function readBoundedJsonObject(response) {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Convex preview authority response exceeds the size limit.");
  }

  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Convex preview authority response exceeds the size limit.");
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Convex preview authority response is not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Convex preview authority response must be an object.");
  }
  return /** @type {Record<string, unknown>} */ (payload);
}

export function assertPreviewDeploymentAdminKey(value, expectedDeploymentName) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("Convex control plane did not return a preview deployment admin key.");
  }
  const separator = value.indexOf("|");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("Convex preview deployment admin key is malformed.");
  }
  const deploymentName = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (
    deploymentName !== expectedDeploymentName ||
    !secret ||
    /[\r\n]/.test(secret)
  ) {
    throw new Error(
      "Convex control plane returned an admin key that is not scoped to the resolved preview deployment.",
    );
  }
  return value;
}

export async function resolveConvexPreviewCredentials({
  deployKey,
  previewName,
  fetchImpl = fetch,
}) {
  if (!SAFE_PREVIEW_NAME.test(previewName ?? "")) {
    throw new Error("Trusted Convex preview name is malformed.");
  }
  const { teamSlug, projectSlug } = parsePreviewDeployKey(deployKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(AUTHORIZE_PREVIEW_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer " + deployKey,
        "content-type": "application/json",
        accept: "application/json",
        "convex-client": CONVEX_CLIENT_HEADER,
      },
      body: JSON.stringify({
        previewName,
        projectSelection: {
          kind: "teamAndProjectSlugs",
          teamSlug,
          projectSlug,
        },
      }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Convex preview authority request timed out.");
    }
    throw new Error(
      "Convex preview authority request failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      "Convex preview authority request failed with HTTP " +
        String(response.status) +
        ".",
    );
  }

  const responseObject = await readBoundedJsonObject(response);
  if (
    responseObject.deploymentType !== undefined &&
    responseObject.deploymentType !== "preview"
  ) {
    throw new Error(
      "Convex control plane resolved a non-preview deployment.",
    );
  }

  const artifact = validateConvexPreviewAuthority(
    {
      version: 1,
      authority: "CONVEX_CONTROL_PLANE_AUTHORIZE_PREVIEW",
      previewName,
      convexCloudUrl: assertConvexCloudOrigin(
        typeof responseObject.url === "string" ? responseObject.url : undefined,
      ),
      deploymentName:
        typeof responseObject.deploymentName === "string"
          ? responseObject.deploymentName
          : "",
    },
    previewName,
  );
  const adminKey = assertPreviewDeploymentAdminKey(
    responseObject.adminKey,
    artifact.deploymentName,
  );

  return { authority: artifact, adminKey };
}

export async function resolveConvexPreviewAuthority(options) {
  const resolved = await resolveConvexPreviewCredentials(options);
  return resolved.authority;
}

export async function writeConvexPreviewAuthority({
  repoRoot = process.cwd(),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const prNumber = positivePrNumber(env.PR_NUMBER);
  const previewName = previewNameForRef({
    ref: "refs/pull/" + prNumber + "/merge",
    prNumber: String(prNumber),
  });

  const artifact = await resolveConvexPreviewAuthority({
    deployKey: env.CONVEX_PREVIEW_DEPLOY_KEY,
    previewName,
    fetchImpl,
  });

  const outputDir = path.join(repoRoot, "artifacts");
  const outputPath = path.join(
    outputDir,
    "browser-swarm-convex-authority.json",
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(artifact, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(
    "Resolved trusted Convex preview authority for " + previewName + ".\n",
  );
  return artifact;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await writeConvexPreviewAuthority();
}
