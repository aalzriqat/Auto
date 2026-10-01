// SCRUM-377: disposable Convex preview deployments count against the team's
// deployment quota until they expire (5 days by default). Every CI run that
// creates one therefore also retires it:
//
//   pin     right after `convex deploy --preview-create`: confirm the deployment
//           that command handed back (CONVEX_PREVIEW_URL, written by its own
//           `--cmd`, never by a later lookup) is a preview carrying this run's
//           identifier,
//           record its createTime, and shorten its expiry to PIN_TTL_MS so a run
//           that crashes or is cancelled before `delete` still frees the slot
//           within hours instead of days.
//   delete  at the end of the run (`if: always()`): delete that same deployment,
//           and only if name, identifier AND createTime all still match.
//
// Invariant: a run deletes only the preview deployment it created itself —
// named by the URL its own `--preview-create` returned, re-confirmed as a preview
// with this run's identifier, and created at the instant `pin` recorded. A
// `--preview-create` for the same identifier deletes the old deployment and makes
// a NEW one under a new random name (observed on main: optimistic-panda-920,
// lovely-dotterel-607, beloved-jackal-758, industrious-chickadee-155), so the
// URL names this run's deployment alone; createTime is a second check on it.
// A later lookup by preview identifier (claim_preview_deployment) may already
// return a newer run's replacement, which is why it must never feed `pin`.
//
// The key is a project PREVIEW deploy key; the Management API allows it only on
// preview deployments, so production is out of reach by construction. The
// checks below are defence in depth, not the only barrier.
//
// Known gap: the CLI claims the preview before its config/AuthKit checks and
// canonical-URL lookup, and only then runs `--cmd`. A failure in that window
// leaves no captured URL, so neither command can act, and that preview keeps
// Convex's default expiry. Nothing here can name it safely without the URL.
//
// Both commands only ever warn: a cleanup problem must not fail the tests it
// follows. Messages carry fixed literals and deployment names, never key bytes.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertConvexCloudOrigin,
  parsePreviewDeployKey,
} from "./intelligence/convexPreviewAuthority.mjs";

const MANAGEMENT_API = "https://api.convex.dev/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
// Only a backstop for runs that die before `delete`. The browser attack swarm
// chains ~120 minutes of job timeouts, and runner queueing between its jobs is
// unbounded; twelve hours keeps a live run's preview alive through long queues.
export const PIN_TTL_MS = 12 * 60 * 60 * 1000;
const SAFE_PREVIEW_NAME = /^[a-z0-9][a-z0-9._-]{0,60}$/;
export const DEPLOYMENT_NAME = /^[a-z]+-[a-z]+-\d+$/;
// Production. The key cannot reach it; this list makes the refusal local too.
export const PROTECTED_DEPLOYMENTS = new Set(["kindly-hound-172"]);

export class PreviewLifecycleRefusal extends Error {}

function refuse(message) {
  throw new PreviewLifecycleRefusal(message);
}

/** The deployment this run was handed, from its canonical convex.cloud URL. */
export function deploymentNameFromUrl(convexUrl) {
  const origin = assertConvexCloudOrigin(convexUrl);
  const name = new URL(origin).hostname.slice(0, -".convex.cloud".length);
  if (!DEPLOYMENT_NAME.test(name)) refuse("Deployment name is malformed.");
  if (PROTECTED_DEPLOYMENTS.has(name)) refuse("Refusing a protected deployment: " + name + ".");
  return name;
}

function readInputs(env) {
  const deployKey = env.CONVEX_PREVIEW_DEPLOY_KEY;
  parsePreviewDeployKey(deployKey);
  const previewName = env.CONVEX_PREVIEW_NAME ?? "";
  if (!SAFE_PREVIEW_NAME.test(previewName)) refuse("CONVEX_PREVIEW_NAME is missing or malformed.");
  const deploymentName = deploymentNameFromUrl(env.CONVEX_PREVIEW_URL);
  return { deployKey, previewName, deploymentName };
}

async function callManagementApi(fetchImpl, deployKey, method, pathname, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(MANAGEMENT_API + pathname, {
      method,
      headers: {
        authorization: "Bearer " + deployKey,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
      refuse("Convex Management API response exceeds the size limit.");
    }
    return { status: response.status, ok: response.ok, raw };
  } catch (error) {
    if (error instanceof PreviewLifecycleRefusal) throw error;
    // Neither branch echoes request details: the header holds the key.
    refuse(
      controller.signal.aborted
        ? "Convex Management API request timed out."
        : "Convex Management API request failed.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET the deployment and prove it is this run's preview. Returns null when it
 * no longer exists (already expired, or replaced by a newer run).
 */
export async function readOwnPreview({ deployKey, previewName, deploymentName, fetchImpl }) {
  const res = await callManagementApi(
    fetchImpl,
    deployKey,
    "GET",
    "/deployments/" + encodeURIComponent(deploymentName),
  );
  if (res.status === 404) return null;
  if (!res.ok) refuse("Reading deployment " + deploymentName + " failed with HTTP " + res.status + ".");
  let d;
  try {
    d = JSON.parse(res.raw);
  } catch {
    refuse("Convex Management API returned invalid JSON.");
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) refuse("Convex Management API returned a non-object.");
  if (d.name !== deploymentName) refuse("Deployment name does not match the requested deployment.");
  if (d.deploymentType !== "preview") refuse("Deployment " + deploymentName + " is not a preview deployment.");
  if (d.kind !== undefined && d.kind !== "cloud") refuse("Deployment " + deploymentName + " is not a cloud deployment.");
  if (d.isDefault === true) refuse("Deployment " + deploymentName + " is a default deployment.");
  if (d.previewIdentifier !== previewName) {
    refuse("Deployment " + deploymentName + " does not carry this run's preview identifier.");
  }
  if (!Number.isSafeInteger(d.createTime) || d.createTime <= 0) refuse("Deployment createTime is missing.");
  return d;
}

function publish(env, entries) {
  for (const [file, key] of [
    [env.GITHUB_ENV, "CONVEX_PREVIEW_CREATED_AT"],
    [env.GITHUB_OUTPUT, "preview_created_at"],
  ]) {
    if (file) appendFileSync(file, key + "=" + entries.createdAt + "\n", "utf8");
  }
}

export async function pinPreview({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const inputs = readInputs(env);
  const d = await readOwnPreview({ ...inputs, fetchImpl });
  if (!d) refuse("Deployment " + inputs.deploymentName + " does not exist right after creation.");
  // Record ownership first: even if shortening the expiry fails, delete works.
  publish(env, { createdAt: d.createTime });
  const expiresAt = now() + PIN_TTL_MS;
  if (typeof d.expiresAt === "number" && d.expiresAt <= expiresAt) {
    return { deploymentName: inputs.deploymentName, createdAt: d.createTime, expiresAt: d.expiresAt };
  }
  const res = await callManagementApi(
    fetchImpl,
    inputs.deployKey,
    "PATCH",
    "/deployments/" + encodeURIComponent(inputs.deploymentName),
    { expiresAt },
  );
  if (!res.ok) refuse("Shortening the expiry of " + inputs.deploymentName + " failed with HTTP " + res.status + ".");
  return { deploymentName: inputs.deploymentName, createdAt: d.createTime, expiresAt };
}

export async function deletePreview({ env = process.env, fetchImpl = fetch } = {}) {
  const inputs = readInputs(env);
  const recorded = Number(env.CONVEX_PREVIEW_CREATED_AT);
  if (!env.CONVEX_PREVIEW_CREATED_AT || !Number.isSafeInteger(recorded) || recorded <= 0) {
    refuse("No recorded createTime for this run's preview; leaving it to expire.");
  }
  const d = await readOwnPreview({ ...inputs, fetchImpl });
  if (!d) return { deploymentName: inputs.deploymentName, deleted: false, reason: "already gone" };
  if (d.createTime !== recorded) {
    refuse("Deployment " + inputs.deploymentName + " was recreated after this run pinned it; not deleting.");
  }
  const res = await callManagementApi(
    fetchImpl,
    inputs.deployKey,
    "POST",
    "/deployments/" + encodeURIComponent(inputs.deploymentName) + "/delete",
  );
  if (res.status === 404) return { deploymentName: inputs.deploymentName, deleted: false, reason: "already gone" };
  if (!res.ok) refuse("Deleting " + inputs.deploymentName + " failed with HTTP " + res.status + ".");
  return { deploymentName: inputs.deploymentName, deleted: true };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const write = options.write ?? ((line) => process.stdout.write(line + "\n"));
  const [command] = argv;
  try {
    if (command === "pin") {
      const r = await pinPreview(options);
      write("Pinned preview " + r.deploymentName + ": created " + r.createdAt + ", expires " + new Date(r.expiresAt).toISOString() + ".");
    } else if (command === "delete") {
      const r = await deletePreview(options);
      write(r.deleted ? "Deleted preview " + r.deploymentName + "." : "Preview " + r.deploymentName + " " + r.reason + ".");
    } else {
      write("::warning::previewDeploymentLifecycle: unknown command.");
    }
  } catch (error) {
    const message =
      error instanceof PreviewLifecycleRefusal || error instanceof Error
        ? error.message
        : "unexpected failure";
    write("::warning::Preview " + (command === "pin" ? "pin" : "cleanup") + " skipped: " + message);
  }
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
