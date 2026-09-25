// SCRUM-350 KEY-3: Convex answers claim_preview_deployment with a key shaped
// `preview:<a>:<b>|<secret>` — the same shape as the project-wide preview deploy
// key — so a prefix check cannot say whether the key is scoped to one preview.
// This one-off diagnostic answers that behaviourally instead, from trusted main
// only. It claims the two previews the trusted lanes already created for a PR,
// then asks each preview's read-only get_config_hashes endpoint which keys it
// accepts. Its report holds booleans, counts and HTTP statuses — never key bytes.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { previewNameForRef } from "../e2ePreviewBootstrap.mjs";
import {
  assertConvexCloudOrigin,
  parsePreviewDeployKey,
  requestPreviewClaim,
} from "./convexPreviewAuthority.mjs";

const CONVEX_CLI_VERSION = "1.42.1";
const PROBE_TIMEOUT_MS = 15_000;
const REJECTED = new Set([401, 403]);
const DEPLOYMENT_NAME = /^[a-z0-9][a-z0-9-]{0,100}$/;
const KNOWN_RESPONSE_FIELDS = new Set([
  "adminKey",
  "deploymentName",
  "deploymentType",
  "instanceUrl",
  "isNewDeployment",
  "reference",
]);

function safeOrigin(value) {
  try {
    return assertConvexCloudOrigin(typeof value === "string" ? value : undefined);
  } catch {
    return null;
  }
}

export function previewNamesForPr(prNumber) {
  const pr = String(prNumber ?? "");
  if (!/^[1-9]\d{0,6}$/.test(pr)) {
    throw new Error("PR number must be a positive integer.");
  }
  const ref = "refs/pull/" + pr + "/merge";
  return {
    swarm: previewNameForRef({ ref, prNumber: pr }),
    rehearsal: previewNameForRef({ ref: "rehearsal/" + ref, prNumber: pr }),
  };
}

function splitKey(key) {
  const separator = key.indexOf("|");
  return separator <= 0
    ? { prefix: "", secret: "" }
    : { prefix: key.slice(0, separator), secret: key.slice(separator + 1) };
}

function describeKey(key, deployKey, deploy) {
  const { prefix, secret } = splitKey(key);
  const segments = prefix.split(":");
  return {
    prefixSegments: prefix ? segments.length : 0,
    prefixEqualsDeployKeyPrefix: prefix === deploy.prefix,
    prefixNamesDeployKeyTeamAndProject:
      segments.length === 3 &&
      segments[1] === deploy.teamSlug &&
      segments[2] === deploy.projectSlug,
    keyEqualsDeployKey: key === deployKey,
    secretEqualsDeployKeySecret: secret !== "" && secret === deploy.secret,
    secretLength: secret.length,
  };
}

async function probe(fetchImpl, origin, adminKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(origin + "/api/get_config_hashes", {
      method: "POST",
      headers: {
        authorization: "Convex " + adminKey,
        "content-type": "application/json",
        "convex-client": "npm-cli-" + CONVEX_CLI_VERSION,
      },
      body: JSON.stringify({ version: CONVEX_CLI_VERSION, adminKey }),
      redirect: "error",
      signal: controller.signal,
    });
    return response.status;
  } catch {
    // A fetch error can echo request details; only the fact is recorded.
    return "NETWORK_ERROR";
  } finally {
    clearTimeout(timeout);
  }
}

function verdictFor(previews, keyAEqualsKeyB, probes) {
  if (
    previews.some((p) => p.keyEqualsDeployKey) ||
    probes.keyAOnB === 200 ||
    probes.keyBOnA === 200
  ) {
    return "NOT_DEPLOYMENT_SCOPED";
  }
  if (Object.values(probes).includes("NETWORK_ERROR")) {
    return "INCONCLUSIVE_PROBE_FAILED";
  }
  if (
    !keyAEqualsKeyB &&
    probes.keyAOnA === 200 &&
    probes.keyBOnB === 200 &&
    REJECTED.has(probes.keyAOnB) &&
    REJECTED.has(probes.keyBOnA)
  ) {
    return "DEPLOYMENT_SCOPED";
  }
  return "INCONCLUSIVE_UNEXPECTED_STATUS";
}

/**
 * Claims two existing previews and cross-probes their keys. The returned
 * report is safe to print; the keys it used are returned only through
 * `onAdminKeys`, so a caller can mask them before printing anything.
 *
 * @param {{
 *   deployKey: string,
 *   previewNames: readonly string[],
 *   fetchImpl?: typeof fetch,
 *   onAdminKeys?: (keys: string[]) => void,
 * }} options
 */
export async function diagnosePreviewKeyScope({
  deployKey,
  previewNames,
  fetchImpl = fetch,
  onAdminKeys = () => {},
}) {
  const { teamSlug, projectSlug } = parsePreviewDeployKey(deployKey);
  const deploy = { teamSlug, projectSlug, ...splitKey(deployKey) };

  const claims = [];
  const keys = [];
  for (const previewName of previewNames) {
    const claim = await requestPreviewClaim({ deployKey, previewName, fetchImpl });
    const key = typeof claim.adminKey === "string" ? claim.adminKey : "";
    // Mask each key and its secret part as soon as it exists: GitHub masks
    // exact strings, so the whole key does not cover its secret on its own.
    onAdminKeys([key, splitKey(key).secret].filter(Boolean));
    claims.push(claim);
    keys.push(key);
  }

  // Control-plane strings are never reflected: only booleans, counts and the
  // names of fields this diagnostic already knows.
  const previews = claims.map((claim, index) => {
    const origin = safeOrigin(claim.instanceUrl);
    const name = claim.deploymentName;
    const fields = Object.keys(claim);
    return {
      previewName: previewNames[index],
      hasAdminKey: keys[index] !== "",
      deploymentNameValid: typeof name === "string" && DEPLOYMENT_NAME.test(name),
      deploymentNameMatchesUrl:
        origin !== null && new URL(origin).hostname === name + ".convex.cloud",
      deploymentTypeIsPreviewOrAbsent:
        claim.deploymentType === undefined || claim.deploymentType === "preview",
      isNewDeployment:
        typeof claim.isNewDeployment === "boolean" ? claim.isNewDeployment : null,
      responseFields: fields.filter((field) => KNOWN_RESPONSE_FIELDS.has(field)).sort(),
      unknownResponseFieldCount: fields.filter((field) => !KNOWN_RESPONSE_FIELDS.has(field))
        .length,
      ...describeKey(keys[index], deployKey, deploy),
      origin,
      name,
    };
  });
  const keyAEqualsKeyB = keys[0] === keys[1];
  const base = {
    version: 1,
    diagnostic: "SCRUM-350-KEY-3",
    previews: previews.map(({ origin: _origin, name: _name, ...rest }) => rest),
    keyAEqualsKeyB,
  };

  // A claim that created a preview means the lanes' preview is gone; probing a
  // blank deployment would answer a different question.
  if (previews.some((p) => p.isNewDeployment !== false)) {
    return { ...base, probes: null, verdict: "INCONCLUSIVE_PREVIEW_MISSING" };
  }

  // A scope verdict is only about two distinct, valid previews.
  const [a, b] = previews;
  const identityValid =
    previews.every(
      (p) =>
        p.hasAdminKey &&
        p.deploymentNameValid &&
        p.deploymentNameMatchesUrl &&
        p.deploymentTypeIsPreviewOrAbsent,
    ) &&
    a.name !== b.name &&
    a.origin !== b.origin;
  if (!identityValid) {
    return { ...base, probes: null, verdict: "INCONCLUSIVE_INVALID_IDENTITY" };
  }

  const probes = {
    keyAOnA: await probe(fetchImpl, a.origin, keys[0]),
    keyAOnB: await probe(fetchImpl, b.origin, keys[0]),
    keyBOnB: await probe(fetchImpl, b.origin, keys[1]),
    keyBOnA: await probe(fetchImpl, a.origin, keys[1]),
    deployKeyOnA: await probe(fetchImpl, a.origin, deployKey),
  };
  return { ...base, probes, verdict: verdictFor(previews, keyAEqualsKeyB, probes) };
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const mask = (value) => {
    if (value) process.stdout.write("::add-mask::" + value + "\n");
  };
  try {
    const deployKey = process.env.CONVEX_PREVIEW_DEPLOY_KEY ?? "";
    mask(splitKey(deployKey).secret);
    const names = previewNamesForPr(process.env.PR_NUMBER);
    const report = await diagnosePreviewKeyScope({
      deployKey,
      previewNames: [names.swarm, names.rehearsal],
      onAdminKeys: (values) => values.forEach(mask),
    });
    const text = JSON.stringify(report, null, 2);
    process.stdout.write(text + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        "## Convex preview key-scope diagnostic\n\n```json\n" + text + "\n```\n",
      );
    }
  } catch {
    // Claim and parse errors can carry request or response text; this public
    // workflow prints only that it failed.
    process.stderr.write("Convex preview key-scope diagnostic failed before producing a report.\n");
    process.exitCode = 1;
  }
}
