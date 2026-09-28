import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewNameForRef } from "../e2ePreviewBootstrap.mjs";

const CONVEX_PROVISION_ORIGIN = "https://api.convex.dev";
// The Convex CLI deploys to a preview through claim_preview_deployment and uses
// the admin key it returns. authorize_preview answers a preview deploy key with a
// project-scoped key (SCRUM-350 KEY-2); claim_preview_deployment turned out to
// return the project-wide key too (KEY-3), see classifyPreviewClaimAdminKey.
// reuse:true claims the preview the trusted step already created. If that
// preview is gone (a concurrent run deleted it), the claim provisions an empty
// one; the isNewDeployment check below refuses to use it, but it is not undone.
const CLAIM_PREVIEW_URL = CONVEX_PROVISION_ORIGIN + "/api/claim_preview_deployment";
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

  const convexCloudUrl = assertConvexCloudOrigin(
    typeof artifact.convexCloudUrl === "string"
      ? artifact.convexCloudUrl
      : undefined,
  );
  if (
    new URL(convexCloudUrl).hostname !==
    artifact.deploymentName + ".convex.cloud"
  ) {
    throw new Error(
      "Convex preview authority deployment name does not match its deployment URL.",
    );
  }

  return {
    version: 1,
    authority: "CONVEX_CONTROL_PLANE_AUTHORIZE_PREVIEW",
    previewName: artifact.previewName,
    convexCloudUrl,
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

// What claim_preview_deployment hands back, and what it may be used for.
//
// A deployment admin key is `<name>|<secret>` or `<type>:<name>|<secret>`, the
// shapes the Convex CLI itself parses (deploymentNameFromAdminKey: the name is
// the last `:` segment). Convex does not return one for previews: run
// 36114902831 (SCRUM-350 KEY-3) proved the claim returns the project-wide
// preview DEPLOY key itself, `preview:<team>:<project>|<secret>`, accepted by
// every preview in the project. No check on its bytes can make it narrower.
//
// So the claim key is accepted in two shapes, and says which:
// - DEPLOYMENT: scoped to the resolved preview, should Convex ever issue one;
// - PROJECT_PREVIEW: the project-wide key, only when its team and project are
//   the deploy key's own.
// Either way it may reach TRUSTED code only. That is enforced where code runs,
// not here: scripts/intelligence/convexCredentialBoundary.test.ts refuses any
// workflow step that runs candidate code beside a Convex credential, and the
// candidate backend is deployed by the trusted CLI from a staged copy.
// A typed deployment key is accepted only as a PREVIEW key: a "prod:" or
// "dev:" key naming the preview is not one this lane may hold (Sol on PR #341).
const ADMIN_KEY_DEPLOYMENT_TYPES = new Set(["preview"]);

export function classifyPreviewClaimAdminKey(value, expectedDeploymentName, deployKey) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("Convex control plane did not return a preview admin key.");
  }
  const separator = value.indexOf("|");
  const secret = value.slice(separator + 1);
  if (separator <= 0 || !secret || /\s/.test(secret)) {
    // Fixed literal: the refusal reaches public CI logs before any ::add-mask::.
    throw new Error("Convex preview admin key is malformed.");
  }
  const prefixParts = value.slice(0, separator).split(":");

  const deploymentName = prefixParts.at(-1);
  const deploymentShape =
    prefixParts.length === 1 ||
    (prefixParts.length === 2 && ADMIN_KEY_DEPLOYMENT_TYPES.has(prefixParts[0]));
  if (deploymentShape && deploymentName === expectedDeploymentName) {
    return { adminKey: value, scope: "DEPLOYMENT" };
  }

  if (prefixParts.length === 3 && prefixParts[0] === "preview") {
    const { teamSlug, projectSlug } = parsePreviewDeployKey(deployKey);
    if (prefixParts[1] === teamSlug && prefixParts[2] === projectSlug) {
      return { adminKey: value, scope: "PROJECT_PREVIEW" };
    }
    throw new Error(
      "Convex control plane returned a preview key for a different team or project.",
    );
  }

  throw new Error(
    "Convex control plane returned an admin key for neither the resolved preview nor this project (" +
      (deploymentShape ? "deployment name differs" : "unrecognized shape") +
      ").",
  );
}

/**
 * The raw claim_preview_deployment call, shared by the resolver and the
 * key-scope diagnostic so both send exactly the same request. Returns the
 * unvalidated response object; callers own every check on it.
 */
export async function requestPreviewClaim({
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
    response = await fetchImpl(CLAIM_PREVIEW_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer " + deployKey,
        "content-type": "application/json",
        accept: "application/json",
        "convex-client": CONVEX_CLIENT_HEADER,
      },
      body: JSON.stringify({
        projectSelection: {
          kind: "teamAndProjectSlugs",
          teamSlug,
          projectSlug,
        },
        identifier: previewName,
        reuse: true,
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

  return readBoundedJsonObject(response);
}

export async function resolveConvexPreviewCredentials({
  deployKey,
  previewName,
  fetchImpl = fetch,
}) {
  const responseObject = await requestPreviewClaim({
    deployKey,
    previewName,
    fetchImpl,
  });
  if (
    responseObject.deploymentType !== undefined &&
    responseObject.deploymentType !== "preview"
  ) {
    throw new Error(
      "Convex control plane resolved a non-preview deployment.",
    );
  }
  // Every caller runs after a trusted step created and bootstrapped this
  // preview. A claim that created one instead would hand back a blank
  // deployment, so anything but an explicit reuse is refused.
  if (responseObject.isNewDeployment !== false) {
    throw new Error(
      "Convex control plane did not reuse the existing preview deployment.",
    );
  }

  const artifact = validateConvexPreviewAuthority(
    {
      version: 1,
      authority: "CONVEX_CONTROL_PLANE_AUTHORIZE_PREVIEW",
      previewName,
      convexCloudUrl: assertConvexCloudOrigin(
        typeof responseObject.instanceUrl === "string"
          ? responseObject.instanceUrl
          : undefined,
      ),
      deploymentName:
        typeof responseObject.deploymentName === "string"
          ? responseObject.deploymentName
          : "",
    },
    previewName,
  );
  const { adminKey, scope } = classifyPreviewClaimAdminKey(
    responseObject.adminKey,
    artifact.deploymentName,
    deployKey,
  );

  return { authority: artifact, adminKey, scope };
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
