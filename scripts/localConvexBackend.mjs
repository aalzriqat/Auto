/**
 * SCRUM-892 — a throwaway, self-hosted Convex backend for CI.
 *
 * ## WHY THIS EXISTS
 *
 * Every `convex deploy --preview-create` run reads and writes a Convex CLOUD
 * deployment, and that I/O counts against the team quota. A backend that lives
 * in a Docker container on the runner costs the quota nothing and disappears
 * with the job. The owner accepted local certification on 2026-11-03
 * (SCRUM-892 c24398).
 *
 * Sources this follows (checked 2026-11-03):
 *   - Convex self-hosted README and docker-compose.yml
 *     (github.com/get-convex/convex-backend/tree/main/self-hosted): image,
 *     ports 3210/3211, INSTANCE_NAME / INSTANCE_SECRET / CONVEX_CLOUD_ORIGIN /
 *     CONVEX_SITE_ORIGIN / DISABLE_BEACON, `./generate_admin_key.sh`,
 *     `curl -f http://localhost:3210/version` as the health probe.
 *   - Convex CLI 1.42.1 (`src/cli/deploymentSelection.ts`): the
 *     CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY pair selects a
 *     self-hosted deployment, and `--deployment` conflicts with it.
 *   - GitHub Actions: `::add-mask::` and the GITHUB_ENV file.
 *   - Docker run reference: `-p 127.0.0.1:host:container`, `-e NAME` (value
 *     inherited from the docker CLI's own environment, so it is not in argv).
 *
 * ## THE SAFETY PROPERTY THIS FILE EXISTS TO KEEP
 *
 * Every Convex call it makes goes to `http://127.0.0.1:3210`, and it refuses to run at
 * all while a cloud credential (`CONVEX_DEPLOY_KEY`, `CONVEX_DEPLOYMENT`,
 * `CONVEX_PREVIEW_DEPLOY_KEY`) is present in its environment. The Convex CLI
 * resolves its target from those variables, so "no cloud credential in the
 * child environment" is what makes a cloud deployment, and production above
 * all, unreachable from here. The child environment is rebuilt without them
 * as well, so the guarantee does not rest on the refusal alone.
 *
 * ## SECRETS
 *
 * The per-run INSTANCE_SECRET and the admin key derived from it are masked
 * (`::add-mask::`) before anything else uses them and are never printed. The
 * admin key is exported to GITHUB_ENV so later steps of the same job can use
 * it: it grants full control of a backend that exists for this job only.
 *
 * ## WHAT THE CANDIDATE CAN DO TO THIS BACKEND (PR #757 round 5)
 *
 * The backend runs the candidate's "use node" actions as a child `node`
 * process inside its own container, as the same user (root). That process can
 * read the instance secret (from /convex/data/credentials and from the
 * backend's own argv in /proc; the pinned image passes it as
 * `--instance-secret`, which has no environment form), run /convex/generate_key
 * and so hold an admin key. Reproduced in CI on this image. So the admin key is
 * NOT out of the candidate's reach, and nothing here pretends it is.
 *
 * What holds instead is a tripwire, `mark` before the tests and `verify` after
 * them. Its whole claim is the `TRIPWIRE` table below, and nothing here says
 * more than that table:
 * - `TRIPWIRE.verified` lists the things `verify` checks;
 * - `TRIPWIRE.auditedRoutes` lists the admin routes that write an audit-log row
 *   in the same transaction as their change, so `verify` fails after any of
 *   them through the newest-row check;
 * - `TRIPWIRE.notChecked` lists what the admin key can also change that
 *   `verify` does not check, each with its reason.
 * The container keeps no Linux capability.
 *
 * ACCEPTED RESIDUAL GAP (owner ruling, option A, SCRUM-892): the tripwire
 * prevents nothing. Two `TRIPWIRE.notChecked` rows are that ruling: work
 * inside the container below the admin API, and changes made before `mark`.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clerkTestFrontendApiOrigin } from "./intelligence/clerkPublicJwtKey.mjs";
import {
  SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME,
  SWARM_LOCAL_CONVEX_ORIGIN,
} from "./intelligence/swarmConvexOrigin.mjs";

// ─── Fixed facts ─────────────────────────────────────────────────────────────

/** The one URL every command here may talk to. Compared by exact equality. */
export const LOCAL_CONVEX_URL = SWARM_LOCAL_CONVEX_ORIGIN;
export const LOCAL_CONVEX_SITE_URL = "http://127.0.0.1:3211";

/**
 * Pinned by tag AND digest. The tag is the upstream git SHA of release
 * precompiled-2026-10-10-72ce13c; the digest is the OCI image index digest,
 * re-verified against ghcr.io on 2026-11-03 (the `Docker-Content-Digest`
 * header equals the SHA-256 of the manifest body, and the index lists
 * linux/amd64, which `ubuntu-latest` runs).
 */
export const LOCAL_CONVEX_IMAGE =
  "ghcr.io/convex/convex-backend:72ce13c379fe6dbdfc305bc8ad699c5663c68c2a" +
  "@sha256:294944b33dc55e8f68b2feda11c5e7b195f7778b9ad2951f1bea2744ad392e5a";

export const INSTANCE_NAME = SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME;
/** Exported to GITHUB_ENV so an always() step can find and remove the container. */
export const CONTAINER_ENV_VAR = "AUTOFLOW_LOCAL_CONVEX_CONTAINER";
const CONTAINER_NAME_PATTERN = /^autoflow-local-convex-[a-z0-9][a-z0-9-]{0,62}$/;
/** Written by `mark`, read by `verify`: the deployed-code fingerprint at mark time. */
export const FINGERPRINT_ENV_VAR = "AUTOFLOW_LOCAL_CONVEX_CODE_FINGERPRINT";

/** Cloudflare's published always-pass Turnstile TEST secret; not a real key. */
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

/**
 * The exact set of backend variables the suite needs, and the only ones the
 * backend may hold. Identical to the allowlist browser-attack-swarm.yml
 * enforces on the cloud preview.
 */
export const ENV_ALLOWLIST = Object.freeze([
  "AUTOFLOW_DEPLOYMENT_CLASS",
  "CLERK_DEV_JWT_ISSUER_DOMAIN",
  "CLERK_JWT_ISSUER_DOMAIN",
  "NEXT_PUBLIC_APP_URL",
  "TURNSTILE_SECRET_KEY",
]);

/**
 * `<instance name>|<opaque token>`, one line, no whitespace. Deliberately
 * shape-only: the token's alphabet is Convex's to define.
 */
export const ADMIN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\|[A-Za-z0-9+/=_-]{16,512}$/;

/** Variables that would point the Convex CLI at a cloud deployment. */
const FORBIDDEN_CLOUD_VARS = ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "CONVEX_PREVIEW_DEPLOY_KEY"];

const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 2_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const LOG_TAIL_LINES = 60;
const MAX_DIAGNOSTIC_CHARS = 6_000;
const PULL_ATTEMPTS = 3;

/** Marks refusals raised by this module so the CLI entry can print them plainly. */
export class LocalConvexRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalConvexRefusal";
  }
}

// ─── Pure guards ─────────────────────────────────────────────────────────────

/**
 * Refuses unless the local backend is the only Convex target this process can
 * resolve.
 *
 * @param {Record<string, string | undefined>} env
 */
export function assertLocalOnly(env) {
  for (const name of FORBIDDEN_CLOUD_VARS) {
    if (env[name] && String(env[name]).trim()) {
      throw new LocalConvexRefusal(
        `${name} is set. The local Convex backend commands refuse to run beside a cloud credential: the Convex CLI ` +
          "would resolve its target from it. Remove it from this step's environment.",
      );
    }
  }
  const url = env.CONVEX_SELF_HOSTED_URL;
  if (url !== undefined && url !== "" && url !== LOCAL_CONVEX_URL) {
    throw new LocalConvexRefusal(
      `CONVEX_SELF_HOSTED_URL is not exactly ${LOCAL_CONVEX_URL}. These commands only ever target that address.`,
    );
  }
}

/** The key the later steps hand to the CLI. Shape-checked, never printed. */
export function assertAdminKey(adminKey) {
  if (typeof adminKey !== "string" || !ADMIN_KEY_PATTERN.test(adminKey)) {
    throw new LocalConvexRefusal(
      "The local backend admin key is missing or malformed. Run the `start` command first in this job.",
    );
  }
  return adminKey;
}

/** Last non-empty line of generate_admin_key.sh output, shape-validated. */
export function parseAdminKey(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.at(-1);
  if (!candidate || !ADMIN_KEY_PATTERN.test(candidate)) {
    throw new LocalConvexRefusal(
      "generate_admin_key.sh did not print an admin key of the expected shape. The output is not reproduced.",
    );
  }
  return candidate;
}

export function generateInstanceSecret(randomBytesImpl = randomBytes) {
  return randomBytesImpl(32).toString("hex");
}

/** Unique per invocation; docker names accept `[a-zA-Z0-9][a-zA-Z0-9_.-]`. */
export function containerNameFor(env, randomHex) {
  const part = (value, fallback) => {
    const cleaned = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
    return cleaned || fallback;
  };
  const name = `autoflow-local-convex-${part(env.GITHUB_RUN_ID, "local")}-${part(env.GITHUB_RUN_ATTEMPT, "0")}-${part(randomHex, "x")}`;
  assertContainerName(name);
  return name;
}

/** Only containers this module names may be removed by `stop`. */
export function assertContainerName(name) {
  if (typeof name !== "string" || !CONTAINER_NAME_PATTERN.test(name)) {
    throw new LocalConvexRefusal(
      `Container name does not look like one this script created (${CONTAINER_NAME_PATTERN}). Refusing to act on it.`,
    );
  }
  return name;
}

/**
 * argv for `docker run`. INSTANCE_SECRET is passed as `-e INSTANCE_SECRET`
 * (no value), so docker takes it from its own environment and the secret is
 * never in argv or in a log of the command.
 */
export function buildDockerRunArgs({ containerName }) {
  assertContainerName(containerName);
  return [
    "run",
    "--detach",
    "--name",
    containerName,
    "--publish",
    "127.0.0.1:3210:3210",
    "--publish",
    "127.0.0.1:3211:3211",
    // Candidate "use node" actions run in here as root (round 5), so the
    // container keeps no capability and a bounded process count.
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "512",
    "--security-opt",
    "no-new-privileges",
    "--env",
    `INSTANCE_NAME=${INSTANCE_NAME}`,
    "--env",
    "INSTANCE_SECRET",
    "--env",
    `CONVEX_CLOUD_ORIGIN=${LOCAL_CONVEX_URL}`,
    "--env",
    `CONVEX_SITE_ORIGIN=${LOCAL_CONVEX_SITE_URL}`,
    "--env",
    "DISABLE_BEACON=1",
    "--env",
    "DISABLE_METRICS_ENDPOINT=true",
    LOCAL_CONVEX_IMAGE,
  ];
}

function parseAppUrl(appUrl) {
  let parsed;
  try {
    parsed = new URL(String(appUrl ?? ""));
  } catch {
    throw new LocalConvexRefusal("NEXT_PUBLIC_APP_URL is missing or not a URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new LocalConvexRefusal("NEXT_PUBLIC_APP_URL must be a plain http(s) URL without credentials.");
  }
  return parsed.origin;
}

/**
 * The ordered `[name, value]` pairs to set. Names equal ENV_ALLOWLIST by
 * construction (a test pins it). Every value is a public origin or a
 * published test value, so printing the plan would leak nothing, and none can
 * start with `-`.
 *
 * Both Clerk variables get the Clerk TEST frontend API origin derived from the
 * pk_test publishable key; a live key is refused by `clerkTestFrontendApiOrigin`.
 */
export function buildEnvPlan({ publishableKey, appUrl }) {
  let issuer;
  try {
    issuer = clerkTestFrontendApiOrigin(publishableKey);
  } catch (error) {
    throw new LocalConvexRefusal(
      `Cannot derive the Clerk test issuer: ${error instanceof Error ? error.message : "invalid publishable key"}`,
    );
  }
  return [
    ["AUTOFLOW_DEPLOYMENT_CLASS", "preview"],
    ["CLERK_DEV_JWT_ISSUER_DOMAIN", issuer],
    ["CLERK_JWT_ISSUER_DOMAIN", issuer],
    ["NEXT_PUBLIC_APP_URL", parseAppUrl(appUrl)],
    ["TURNSTILE_SECRET_KEY", TURNSTILE_TEST_SECRET],
  ];
}

/**
 * Orders strings by UTF-16 code unit, the order `Array#sort` uses with no
 * comparator. Never `localeCompare`: a locale order varies between machines.
 */
export function compareCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * `convex env list --names-only` output to a sorted list of names. The pinned
 * CLI ends each line with "\n" only (node_modules/convex/dist/esm/cli/lib/env.js:125-142,
 * convex 1.42.1), so only the empty string after the final "\n" is dropped; a
 * "\r" is part of what the backend stored and fails the name check.
 */
export function parseEnvNames(stdout) {
  const names = String(stdout ?? "").split("\n");
  if (names.at(-1) === "") names.pop();
  for (const name of names) {
    if (!ENV_NAME.test(name)) {
      throw new LocalConvexRefusal("The backend's variable listing contained an unexpected value.");
    }
  }
  return names.sort(compareCodeUnits);
}

/** Exact equality with the allowlist; neither extra nor missing names pass. */
export function assertEnvMatchesAllowlist(actualNames) {
  const expected = [...ENV_ALLOWLIST].sort(compareCodeUnits);
  const actual = [...actualNames].sort(compareCodeUnits);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    const missing = expected.filter((name) => !actual.includes(name));
    const extra = actual.filter((name) => !expected.includes(name));
    throw new LocalConvexRefusal(
      "The local backend environment does not match the allowlist. " +
        `Missing: [${missing.join(", ")}]. Unexpected: [${extra.join(", ")}].`,
    );
  }
}

/**
 * The backend's stored variables, as `ENV_QUERY` returns them, must be exactly
 * the plan's (name, value) pairs, in any order. Values are compared too, not
 * just names: a candidate holding an admin key can rewrite a value without
 * changing the name set. Both strings are compared code unit for code unit,
 * with nothing trimmed or decoded, because the backend stores whatever string
 * a caller sends (`EnvVarValue::from_str` checks no characters at the pinned
 * revision). Pairs are counted, so a duplicate cannot stand in for a missing
 * one. The refusal names variables only, never a value.
 */
export function assertEnvMatchesPlan(variables, plan) {
  const wellFormed =
    Array.isArray(variables) && variables.every((v) => typeof v?.name === "string" && typeof v?.value === "string");
  if (!wellFormed) {
    throw new LocalConvexRefusal("The backend's variable listing was not a list of names and values.");
  }
  const counts = new Map();
  const count = (name, value, by) => {
    const key = JSON.stringify([name, value]);
    const entry = counts.get(key) ?? { name, count: 0 };
    entry.count += by;
    counts.set(key, entry);
  };
  for (const [name, value] of plan) count(name, value, 1);
  for (const { name, value } of variables) count(name, value, -1);
  const differing = [...counts.values()]
    .filter((entry) => entry.count !== 0)
    .map((entry) => (ENV_NAME.test(entry.name) ? entry.name : "<malformed name>"));
  if (differing.length > 0) {
    const names = [...new Set(differing)].sort(compareCodeUnits);
    throw new LocalConvexRefusal(
      `The local backend environment differs from the trusted plan. Variables that differ: [${names.join(", ")}].`,
    );
  }
}

/** JSON with object keys sorted at every depth, so equal values serialise equally. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort(compareCodeUnits);
    const entries = keys.map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]));
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The system queries the fingerprint reads besides `/api/get_config_hashes`.
 * They are compiled into the backend binary: a push cannot define a `_system/`
 * module (crates/model/src/modules/mod.rs:116-117 and :286-287 at the pinned
 * revision), so deployed candidate code cannot answer them.
 */
export const COMPONENTS_QUERY = "_system/frontend/components:list";
export const COMPONENT_MODULES_QUERY = "_system/frontend/modules:listForAllComponents";
export const LAST_PUSH_QUERY = "_system/frontend/deploymentEvents:lastPushEvent";
/**
 * The stored variables, as the pinned CLI's own `env list` reads them
 * (node_modules/convex/dist/esm/cli/lib/env.js:43-50): every
 * `_environment_variables` row with its exact `name` and `value` strings
 * (npm-packages/system-udfs/convex/_system/cli/queryEnvironmentVariables.ts).
 */
export const ENV_QUERY = "_system/cli/queryEnvironmentVariables";
/**
 * Every `_deployment_audit_log` row at or after `fromTimestamp`, oldest first
 * (npm-packages/system-udfs/convex/_system/frontend/listDeploymentEventsFromTime.ts).
 * The start is clamped to the retention window, so a listing that does not
 * begin with the push it was asked from is refused, not trusted.
 */
export const AUDIT_EVENTS_QUERY = "_system/frontend/listDeploymentEventsFromTime";
/**
 * The URLs functions read as CONVEX_CLOUD_URL / CONVEX_SITE_URL
 * (crates/udf/src/environment.rs:68-87). An admin key can override them
 * persistently (crates/local_backend/src/canonical_urls.rs:54-109), and this
 * endpoint reports the effective pair, defaulting to the container's origins
 * (:121-173).
 */
export const CANONICAL_URLS_ENDPOINT = "/api/v1/get_canonical_urls";
const PUSH_ACTIONS = new Set(["push_config", "push_config_with_components"]);

/**
 * What the `mark` / `verify` tripwire covers, against every state-changing
 * route an admin key reaches on the pinned backend (72ce13c3,
 * crates/local_backend/src/router.rs:286-616). This table is the claim: the
 * file header, browser-attack-swarm.yml and the PR body refer to it and say
 * nothing broader. Paths are in get-convex/convex-backend at 72ce13c3; "lb" is
 * crates/local_backend/src, "app" is crates/application/src.
 *
 * - `verified`: `mark` reads it, records or checks it, and `verify` reads it
 *   back and compares it exactly.
 * - `auditedRoutes`: these routes are not read back one by one. Each writes a
 *   `_deployment_audit_log` row in the same transaction as its change, which
 *   moves the newest row, which is `verified`. So `verify` fails after any of
 *   them, even when the state was put back. Read from the source; the first
 *   CI run after merge is the first runtime proof.
 * - `notChecked`: the admin key can also change these, and `verify` does not
 *   check them, with the reason each one is left.
 */
export const TRIPWIRE = Object.freeze({
  verified: Object.freeze([
    "the backend variables: every name and value, exactly (ENV_QUERY), against the trusted plan",
    "the canonical URLs functions read as CONVEX_CLOUD_URL / CONVEX_SITE_URL (CANONICAL_URLS_ENDPOINT), equal to the local origins",
    "the root component's config, module content hashes, UDF server and Node versions (/api/get_config_hashes)",
    "every component, its mount arguments and state, and every component's analysed modules with their source package (COMPONENTS_QUERY, COMPONENT_MODULES_QUERY)",
    "the identity of the latest code push (LAST_PUSH_QUERY), which also moves on a dependency-only push",
    "the identity of the newest audit-log row since that push (AUDIT_EVENTS_QUERY)",
  ]),
  auditedRoutes: Object.freeze([
    "POST /api/update_environment_variables and /api/v1 env routes (lb/environment_variables.rs:109,165-174; app/lib.rs:1803-1862)",
    "POST /api/update_canonical_url and /api/v1/update_canonical_url (lb/canonical_urls.rs:54-109)",
    "POST /api/push_config, /api/deploy2/finish_push (app/deploy_config.rs:861-969; app/lib.rs:2292)",
    "POST /api/prepare_schema (lb/schema.rs:309)",
    "POST /api/cancel_job, /api/cancel_all_jobs (lb/scheduling.rs:143-166; app/lib.rs:3308-3356)",
    "dashboard delete_tables, delete_component, delete_scheduled_functions_table (lb/dashboard.rs:345-357; app/lib.rs:2935-2959, 2971-2985, 3279-3297)",
    "POST /api/export/request/zip, set_expiration, cancel (app/lib.rs:1659-1728; lb/snapshot_export.rs:206-235)",
    "POST /api/import, /api/perform_import and the snapshot-import routes (router.rs:479-491; app/snapshot_import/audit_log.rs:38)",
    "/api/v1 usage limits create, update, delete (lb/usage_limits.rs:302-438)",
    "/api/v1 pause and unpause deployment (lb/deployment_state.rs:131-132; app/deployment_state.rs:21-44)",
    "/api/v1 log streams create, update, delete, rotate secret (lb/log_sinks.rs:1581-1586, 814-815; app/log_streaming.rs:56-120, 204-231)",
    "/api/v1 data sync (lb/streaming_export.rs:236, 519-521)",
    "the dashboard's _system/frontend data mutations: addDocument, clearTablePage, createTable, deleteDocuments, patchDocumentsFields, replaceDocument, fileStorageV2 deleteFile(s) and generateUploadUrl (writeAuditLog)",
  ]),
  notChecked: Object.freeze([
    "the public function API and the action callbacks: /api/query, /api/mutation, /api/action, /api/function, /api/actions/*, /api/storage/upload, the sync websocket (lb/public_api.rs:769-783; router.rs:446-473). They write table data and files, which the deployed candidate code can already write itself; the tripwire claims nothing about data.",
    "the streaming-import routes: replace_tables, clear_tables, fivetran_truncate_table, fivetran_create_table, import_airbyte_records, apply_fivetran_operations (router.rs:568-591; app/lib.rs:2691, 3734-3809). They write table data without an audit row; same reason as above.",
    "PUT /api/streaming_import/add_primary_key_indexes (app/lib.rs:3616-3634): adds a reserved system index that functions cannot query.",
    "POST /api/run_test_function (app/lib.rs:2710-2858): runs a query only (:2849-2858 refuses mutations); its uploaded package is not deployed, and it sets the UDF config only when no push exists yet (:2758-2766).",
    "POST /api/deploy2/start_push, evaluate_push, evaluate_schema, wait_for_schema (app/deploy_config.rs:205, 569): staged state that goes live only through finish_push, which is audited.",
    "anything done inside the backend container below the admin API (owner ruling SCRUM-892, option A): root code there can write the backend's storage, including the audit log, or replace the process that answers these reads.",
    "a change made before `mark`, which `mark` records as the baseline.",
  ]),
});

function auditIdentity(event) {
  if (typeof event?._id !== "string" || typeof event._creationTime !== "number" || typeof event.action !== "string") {
    return null;
  }
  return { id: event._id, creationTime: event._creationTime, action: event.action };
}

function lastPushIdentity(event) {
  const identity = auditIdentity(event);
  if (!identity || !PUSH_ACTIONS.has(identity.action)) {
    throw new LocalConvexRefusal("The backend reported no code push; the deployed code cannot be fingerprinted.");
  }
  return identity;
}

/**
 * The newest audit row since the latest push. Every audited admin action
 * writes its row in the same transaction as its change (see `TRIPWIRE`), so
 * any of them after `mark` moves this identity, even when the state it
 * changed was put back.
 */
function lastAuditIdentity(events, lastPush) {
  const refuse = () =>
    new LocalConvexRefusal("The backend's audit log does not reach back to the latest code push; it cannot be fingerprinted.");
  if (!Array.isArray(events) || events.length === 0 || auditIdentity(events[0])?.id !== lastPush.id) throw refuse();
  const last = auditIdentity(events.at(-1));
  if (!last || events.some((event) => !auditIdentity(event))) throw refuse();
  return last;
}

function rootModuleHashes(configHashes) {
  const modules = Array.isArray(configHashes?.moduleHashes) ? configHashes.moduleHashes : [];
  if (modules.length === 0 || modules.some((m) => typeof m?.path !== "string" || typeof m?.hash !== "string")) {
    throw new LocalConvexRefusal("The backend reported no module hashes; the deployed code cannot be fingerprinted.");
  }
  return [...modules].sort((a, b) => compareCodeUnits(a.path, b.path));
}

const isVersionedModule = (entry) =>
  Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1]?.sourcePackageId === "string";

/**
 * Every component's analysed modules, each with the source package the backend
 * renews whenever that module's contents change. The listing skips modules
 * with no analysis, which is every `_deps/` module
 * (npm-packages/system-udfs/convex/_system/frontend/modules.ts:94-99,
 * mod.rs:289-292); `lastPushIdentity` covers those. Refuses unless there is
 * exactly one root entry and every mounted component (every component but the
 * root, whose path is "") has a listing.
 */
function componentModuleListings(components, componentModules) {
  const malformed = () =>
    new LocalConvexRefusal("The backend's component listing is incomplete; mounted component code cannot be fingerprinted.");
  if (!Array.isArray(components) || !Array.isArray(componentModules)) throw malformed();
  const mounted = components.filter((c) => c?.path !== "").length;
  const roots = componentModules.filter((entry) => Array.isArray(entry) && entry[0] === null).length;
  const listed = componentModules.filter((entry) => Array.isArray(entry) && entry[0] !== null).length;
  const wellFormed = componentModules.every((entry) => Array.isArray(entry?.[1]) && entry[1].every(isVersionedModule));
  if (roots !== 1 || listed !== mounted || !wellFormed) throw malformed();
  return componentModules
    .map(([id, modules]) => stableStringify([id, [...modules].sort((a, b) => compareCodeUnits(a[0], b[0]))]))
    .sort(compareCodeUnits);
}

/**
 * SHA-256 over the deployed code, read from the backend binary on the host:
 * - the root's config, one content hash per module, the UDF server version and
 *   the Node version, from `/api/get_config_hashes`. That endpoint reads the
 *   root component only and reports no Node dependencies
 *   (crates/local_backend/src/deploy_config.rs:76-81 and :231);
 * - every component (id, path, mount arguments, state) and every component's
 *   modules with their analysed functions and source package, from the two
 *   system queries above. A module's source package changes when its contents
 *   change (crates/model/src/modules/mod.rs:329-353), so a component redeploy
 *   changes the fingerprint even though no content hash is exposed for it;
 * - the identity of the latest code push. No pinned read lists a component's
 *   `_deps/` modules, and an unchanged importing module keeps its old source
 *   package, so a dependency-only push would otherwise leave the fingerprint
 *   unchanged. Every push writes a push audit row in its own transaction
 *   (crates/application/src/deploy_config.rs:861-969 and lib.rs:2292), and
 *   `lastPushEvent` returns the newest one, so any push after `mark` moves it;
 * - the identity of the newest audit-log row since that push
 *   (`lastAuditIdentity`), which any route in `TRIPWIRE.auditedRoutes` moves.
 * Refuses a backend with no root module hashes, no recorded push, or an audit
 * listing that does not start at that push, so an empty backend never matches.
 */
export function codeFingerprint(state) {
  const root = state?.configHashes;
  const moduleHashes = rootModuleHashes(root);
  const componentModules = componentModuleListings(state.components, state.componentModules);
  const lastPush = lastPushIdentity(state.lastPush);
  const material = {
    config: root.config ?? null,
    moduleHashes,
    udfServerVersion: root.udfServerVersion ?? null,
    nodeVersion: root.nodeVersion ?? null,
    components: state.components.map((c) => stableStringify(c)).sort(compareCodeUnits),
    componentModules,
    lastPush,
    lastAudit: lastAuditIdentity(state.auditEvents, lastPush),
  };
  return createHash("sha256").update(stableStringify(material)).digest("hex");
}

/** Bounded, control-free, secret-free text for a log line. */
export function boundedDiagnostic(text, secrets = [], maxChars = MAX_DIAGNOSTIC_CHARS) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  out = out.replace(/[^\n\t\x20-\x7e]/g, "?");
  return out.length > maxChars ? `…${out.slice(-maxChars)}` : out;
}

/** Appends `NAME=value` lines to the GITHUB_ENV file; refuses anything that could inject a line. */
export function appendGithubEnv(file, entries, append = appendFileSync) {
  if (!file) return false;
  let body = "";
  for (const [name, value] of entries) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n]/.test(String(value))) {
      throw new LocalConvexRefusal("Refusing to write a malformed entry to the job environment file.");
    }
    body += `${name}=${value}\n`;
  }
  append(file, body, "utf8");
  return true;
}

// ─── Side effects behind seams ───────────────────────────────────────────────

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string, error?: Error | undefined }} ExecResult
 * @typedef {{
 *   exec: (command: string, args: string[], options: { env: Record<string, string | undefined>, capture: boolean }) => ExecResult,
 *   fetchImpl: typeof fetch,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   randomBytesImpl: (size: number) => Buffer,
 *   log: (message: string) => void,
 *   append: typeof appendFileSync,
 *   convexCli: string,
 *   cliVersion: () => string,
 * }} Deps
 */

/** @returns {ExecResult} */
function defaultExec(command, args, { env, capture }) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: 20 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/** @returns {Deps} */
function defaultDeps() {
  return {
    exec: defaultExec,
    fetchImpl: fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    randomBytesImpl: randomBytes,
    log: console.log,
    append: appendFileSync,
    // The repo's own pinned CLI, invoked with node: no pnpm shim, no PATH lookup.
    convexCli: path.join(process.cwd(), "node_modules", "convex", "bin", "main.js"),
    // The fingerprint request names the CLI version, as the CLI's own call does.
    cliVersion: () =>
      JSON.parse(readFileSync(path.join(process.cwd(), "node_modules", "convex", "package.json"), "utf8")).version,
  };
}

const inCi = (env) => env.GITHUB_ACTIONS === "true";

/** `::add-mask::` only in CI; locally it would PRINT the value. */
function mask(env, log, value) {
  if (inCi(env)) log(`::add-mask::${value}`);
}

/** The environment a Convex CLI child gets: the caller's, minus cloud credentials, plus the local pair. */
function convexChildEnv(env, adminKey) {
  const child = { ...env };
  for (const name of FORBIDDEN_CLOUD_VARS) delete child[name];
  child.CONVEX_SELF_HOSTED_URL = LOCAL_CONVEX_URL;
  child.CONVEX_SELF_HOSTED_ADMIN_KEY = adminKey;
  return child;
}

function runConvexCli(deps, env, adminKey, args, { capture = false } = {}) {
  const result = deps.exec(process.execPath, [deps.convexCli, ...args], {
    env: convexChildEnv(env, adminKey),
    capture,
  });
  if (result.error) {
    throw new LocalConvexRefusal(`Could not start the Convex CLI for "${args[0]}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    const subcommand = args[1] && !args[1].startsWith("-") ? ` ${args[1]}` : "";
    throw new LocalConvexRefusal(
      `convex ${args[0]}${subcommand} failed with exit code ${result.status}. ` +
        "The CLI's own output is above.",
    );
  }
  return result;
}

function docker(deps, env, args, extraEnv = {}) {
  return deps.exec("docker", args, { env: { ...env, ...extraEnv }, capture: true });
}

/** Container state and a bounded log tail. Platform logs, bounded anyway. */
function describeContainer(deps, env, name, secrets) {
  const state = docker(deps, env, [
    "inspect",
    "--format",
    "status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}",
    name,
  ]);
  const logs = docker(deps, env, ["logs", "--tail", String(LOG_TAIL_LINES), name]);
  const logText = logs.stdout + logs.stderr;
  return (
    `Container state: ${boundedDiagnostic(state.stdout || state.stderr, secrets, 300).trim()}\n` +
    `Last ${LOG_TAIL_LINES} log lines:\n${boundedDiagnostic(logText, secrets)}`
  );
}

function containerIsRunning(deps, env, name) {
  const result = docker(deps, env, ["inspect", "--format", "{{.State.Running}}", name]);
  return result.status === 0 && result.stdout.trim() === "true";
}

/**
 * Polls GET /version until it answers 2xx. Fails fast if the container has
 * exited, and fails closed at the deadline.
 */
export async function waitForBackend({
  deps,
  isRunning,
  timeoutMs = HEALTH_TIMEOUT_MS,
  intervalMs = HEALTH_INTERVAL_MS,
}) {
  const deadline = deps.now() + timeoutMs;
  // Each poll must wait for the previous one, so this recurses rather than
  // awaiting inside a loop. Depth is bounded by timeoutMs / intervalMs.
  const poll = async () => {
    if (!isRunning()) return { ok: false, reason: "the container stopped before the backend answered" };
    if (await backendAnswers(deps)) return { ok: true };
    if (deps.now() + intervalMs > deadline) {
      return { ok: false, reason: `no healthy answer from ${LOCAL_CONVEX_URL}/version within ${Math.round(timeoutMs / 1000)}s` };
    }
    await deps.sleep(intervalMs);
    return poll();
  };
  return poll();
}

async function backendAnswers(deps) {
  try {
    const response = await deps.fetchImpl(`${LOCAL_CONVEX_URL}/version`, {
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    // Not listening yet: keep polling until the deadline.
    return false;
  }
}

/** Retries with linear backoff; attempts are sequential by design, so it recurses. */
async function pullImage(deps, env, attempt = 1) {
  const result = docker(deps, env, ["pull", "--quiet", LOCAL_CONVEX_IMAGE]);
  if (result.status === 0) return;
  if (attempt >= PULL_ATTEMPTS) {
    throw new LocalConvexRefusal(
      `docker pull of the pinned image failed after ${PULL_ATTEMPTS} attempts: ${boundedDiagnostic(result.stderr, [], 500).trim()}`,
    );
  }
  await deps.sleep(2_000 * attempt);
  return pullImage(deps, env, attempt + 1);
}

// ─── Commands ────────────────────────────────────────────────────────────────

/** Starts the container, waits for health, derives and exports the admin key. */
export async function startBackend(env, deps) {
  assertLocalOnly(env);

  const secret = generateInstanceSecret(deps.randomBytesImpl);
  // Masked BEFORE any other use, including the docker call that receives it.
  mask(env, deps.log, secret);

  const containerName = containerNameFor(env, deps.randomBytesImpl(4).toString("hex"));
  // Recorded before `docker run`, so the always() stop step can find the
  // container even if this step dies half way.
  appendGithubEnv(env.GITHUB_ENV, [[CONTAINER_ENV_VAR, containerName]], deps.append);

  await pullImage(deps, env);

  const run = docker(deps, env, buildDockerRunArgs({ containerName }), { INSTANCE_SECRET: secret });
  if (run.error || run.status !== 0) {
    throw new LocalConvexRefusal(
      `docker run failed: ${boundedDiagnostic(run.error?.message ?? run.stderr, [secret], 800).trim()}`,
    );
  }

  const health = await waitForBackend({ deps, isRunning: () => containerIsRunning(deps, env, containerName) });
  if (!health.ok) {
    deps.log(describeContainer(deps, env, containerName, [secret]));
    throw new LocalConvexRefusal(`The local Convex backend did not become healthy: ${health.reason}.`);
  }

  const keyResult = docker(deps, env, ["exec", containerName, "./generate_admin_key.sh"]);
  if (keyResult.error || keyResult.status !== 0) {
    deps.log(describeContainer(deps, env, containerName, [secret]));
    throw new LocalConvexRefusal("generate_admin_key.sh failed inside the backend container.");
  }
  const adminKey = parseAdminKey(keyResult.stdout);
  mask(env, deps.log, adminKey);

  appendGithubEnv(
    env.GITHUB_ENV,
    [
      ["CONVEX_SELF_HOSTED_URL", LOCAL_CONVEX_URL],
      ["CONVEX_SELF_HOSTED_ADMIN_KEY", adminKey],
      ["NEXT_PUBLIC_CONVEX_URL", LOCAL_CONVEX_URL],
    ],
    deps.append,
  );
  deps.log(`Local Convex backend ${containerName} is healthy at ${LOCAL_CONVEX_URL} (image pinned by digest).`);
  return { containerName };
}

function listEnvNames(deps, env, adminKey) {
  const listed = runConvexCli(deps, env, adminKey, ["env", "list", "--names-only"], { capture: true });
  return parseEnvNames(listed.stdout);
}

/** Sets the allowlisted variables and proves the backend holds exactly those. */
export function setBackendEnv(env, deps) {
  assertLocalOnly(env);
  const adminKey = assertAdminKey(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  const plan = buildEnvPlan({
    publishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    appUrl: env.NEXT_PUBLIC_APP_URL,
  });
  for (const [name, value] of plan) {
    runConvexCli(deps, env, adminKey, ["env", "set", name, value, "--force"]);
  }
  assertEnvMatchesAllowlist(listEnvNames(deps, env, adminKey));
  deps.log(`Local backend environment verified: ${ENV_ALLOWLIST.join(", ")}.`);
}

/**
 * Deploys the repository's convex/ directory, then mints the preview marker.
 * Environment first: convex/auth.config.ts is evaluated at deploy time and
 * needs both Clerk issuer variables.
 */
export function deployBackend(env, deps) {
  assertLocalOnly(env);
  const adminKey = assertAdminKey(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  assertEnvMatchesAllowlist(listEnvNames(deps, env, adminKey));
  runConvexCli(deps, env, adminKey, ["deploy", "--typecheck", "enable", "--yes"]);
  runConvexCli(deps, env, adminKey, ["run", "e2eBootstrap:markPreviewDeployment", "{}"]);
  deps.log("Local backend deployed and marked as a disposable preview deployment.");
}

/** `TRIPWIRE.verified`: the stored variables equal the trusted plan exactly. */
async function assertEnvMatchesTrustedPlan(deps, env, adminKey) {
  const plan = buildEnvPlan({
    publishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    appUrl: env.NEXT_PUBLIC_APP_URL,
  });
  assertEnvMatchesPlan(await systemQuery(deps, adminKey, ENV_QUERY), plan);
}

/**
 * `TRIPWIRE.verified`: the canonical URLs are exactly the local origins, with
 * no other field, so a function reading CONVEX_CLOUD_URL or CONVEX_SITE_URL
 * sees this backend and nothing a candidate set.
 */
async function assertCanonicalUrlsAreLocal(deps, adminKey) {
  const urls = await adminRequest(deps, adminKey, "GET", CANONICAL_URLS_ENDPOINT, undefined, "the canonical URLs read");
  const keys = urls && typeof urls === "object" ? Object.keys(urls).sort(compareCodeUnits) : [];
  const exact =
    keys.join(",") === "convexCloudUrl,convexSiteUrl" &&
    urls.convexCloudUrl === LOCAL_CONVEX_URL &&
    urls.convexSiteUrl === LOCAL_CONVEX_SITE_URL;
  if (!exact) {
    throw new LocalConvexRefusal("The backend's canonical URLs are not the local origins; functions would read another deployment's URLs.");
  }
}

/**
 * One admin request to the backend on the host. `what` names the read in every
 * refusal; nothing from the request or the response body is echoed.
 */
async function adminRequest(deps, adminKey, method, endpoint, payload, what) {
  let response;
  try {
    response = await deps.fetchImpl(`${LOCAL_CONVEX_URL}${endpoint}`, {
      method,
      headers: {
        authorization: `Convex ${adminKey}`,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        "convex-client": `npm-cli-${deps.cliVersion()}`,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      redirect: "error",
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS * 6),
    });
  } catch {
    // A fetch error can echo request details, and the request carries the key.
    throw new LocalConvexRefusal(`The local backend did not answer ${what}.`);
  }
  if (!response.ok) {
    throw new LocalConvexRefusal(`${what} failed with HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new LocalConvexRefusal(`${what} did not return JSON.`);
  }
}

/**
 * A system query, posted the way the pinned CLI's ConvexHttpClient posts one.
 * `args` is plain JSON numbers and strings only, which convex_encoded_json
 * carries unchanged.
 */
async function systemQuery(deps, adminKey, functionPath, args = {}) {
  const what = `the ${functionPath} read`;
  const payload = { path: functionPath, format: "convex_encoded_json", args: [args] };
  const body = await adminRequest(deps, adminKey, "POST", "/api/query", payload, what);
  if (body?.status !== "success") {
    throw new LocalConvexRefusal(`${what} did not succeed.`);
  }
  return body.value;
}

/** The deployed-code fingerprint, read from the backend's admin API on the host. */
async function fetchCodeFingerprint(deps, adminKey) {
  const configHashes = await adminRequest(
    deps,
    adminKey,
    "POST",
    "/api/get_config_hashes",
    { version: deps.cliVersion(), adminKey },
    "the deployed-code fingerprint request",
  );
  const components = await systemQuery(deps, adminKey, COMPONENTS_QUERY);
  const componentModules = await systemQuery(deps, adminKey, COMPONENT_MODULES_QUERY);
  const lastPush = await systemQuery(deps, adminKey, LAST_PUSH_QUERY);
  const fromTimestamp = lastPushIdentity(lastPush).creationTime;
  const auditEvents = await systemQuery(deps, adminKey, AUDIT_EVENTS_QUERY, { fromTimestamp });
  return codeFingerprint({ configHashes, components, componentModules, lastPush, auditEvents });
}

/** Every `TRIPWIRE.verified` read except the fingerprint comparison itself. */
async function readTripwire(deps, env, adminKey) {
  await assertEnvMatchesTrustedPlan(deps, env, adminKey);
  await assertCanonicalUrlsAreLocal(deps, adminKey);
  return fetchCodeFingerprint(deps, adminKey);
}

/**
 * Mints the preview marker on a backend that already holds deployed functions
 * (SCRUM-892). `deploy` deploys this checkout's convex/ and marks in one go; the
 * browser swarm instead deploys a STAGED candidate backend in a hardened
 * container, so only the marker step runs here, from the trusted checkout.
 *
 * Round 5: the candidate's "use node" actions run inside the backend container
 * and can recover the instance secret, so they can mint an admin key. Before
 * minting, `mark` checks the variables and canonical URLs and records the
 * fingerprint, which together are `TRIPWIRE.verified`.
 */
export async function markBackend(env, deps) {
  assertLocalOnly(env);
  const adminKey = assertAdminKey(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  const fingerprint = await readTripwire(deps, env, adminKey);
  runConvexCli(deps, env, adminKey, ["run", "e2eBootstrap:markPreviewDeployment", "{}"]);
  appendGithubEnv(env.GITHUB_ENV, [[FINGERPRINT_ENV_VAR, fingerprint]], deps.append);
  deps.log(`Local backend marked as a disposable preview deployment. Deployed-code fingerprint ${fingerprint}.`);
}

/**
 * The tripwire, run on the host after the job's last test and before the
 * verdict is uploaded. Fails closed unless the backend still answers and every
 * `TRIPWIRE.verified` read equals what `mark` checked or recorded. It reads
 * through the backend binary's admin API from the runner, a path deployed
 * functions cannot serve. What it does not check is `TRIPWIRE.notChecked`; it
 * prevents nothing (owner ruling SCRUM-892, option A).
 */
export async function verifyBackend(env, deps) {
  assertLocalOnly(env);
  const adminKey = assertAdminKey(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  const baseline = env[FINGERPRINT_ENV_VAR];
  if (typeof baseline !== "string" || !/^[0-9a-f]{64}$/.test(baseline)) {
    throw new LocalConvexRefusal(`${FINGERPRINT_ENV_VAR} is missing. Run \`mark\` earlier in this job.`);
  }
  if (!(await backendAnswers(deps))) {
    throw new LocalConvexRefusal("The local backend no longer answers; its state cannot be verified.");
  }
  const fingerprint = await readTripwire(deps, env, adminKey);
  if (fingerprint !== baseline) {
    throw new LocalConvexRefusal(
      "The deployed code changed after it was marked, or an audited admin action ran " +
        `(fingerprint ${fingerprint}, recorded ${baseline}).`,
    );
  }
  deps.log(
    `Local backend unchanged since it was marked. Checked: ${TRIPWIRE.verified.join("; ")}. ` +
      `Not checked: ${TRIPWIRE.notChecked.length} disclosed items (TRIPWIRE.notChecked in scripts/localConvexBackend.mjs).`,
  );
}

/** Removes the container. Idempotent: a missing container or name is fine. */
export function stopBackend(env, deps) {
  assertLocalOnly(env);
  const name = env[CONTAINER_ENV_VAR];
  if (!name) {
    deps.log("No local Convex container was recorded for this job; nothing to stop.");
    return;
  }
  assertContainerName(name);
  const result = docker(deps, env, ["rm", "--force", name]);
  if (result.status !== 0 && !/no such container/i.test(`${result.stderr}${result.stdout}`)) {
    throw new LocalConvexRefusal(`docker rm failed: ${boundedDiagnostic(result.stderr, [], 400).trim()}`);
  }
  deps.log(`Local Convex container ${name} removed.`);
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @param {Partial<Deps>} [overrides]
 */
export async function main(argv, env = process.env, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const [command] = argv;
  switch (command) {
    case "start":
      return startBackend(env, deps);
    case "env":
      return setBackendEnv(env, deps);
    case "deploy":
      return deployBackend(env, deps);
    case "mark":
      return markBackend(env, deps);
    case "verify":
      return verifyBackend(env, deps);
    case "stop":
      return stopBackend(env, deps);
    default:
      throw new LocalConvexRefusal("Usage: node scripts/localConvexBackend.mjs <start|env|deploy|mark|verify|stop>");
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
