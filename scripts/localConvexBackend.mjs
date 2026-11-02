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
 * It can only ever talk to `http://127.0.0.1:3210`, and it refuses to run at
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
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clerkTestFrontendApiOrigin } from "./intelligence/clerkPublicJwtKey.mjs";

// ─── Fixed facts ─────────────────────────────────────────────────────────────

/** The one URL every command here may talk to. Compared by exact equality. */
export const LOCAL_CONVEX_URL = "http://127.0.0.1:3210";
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

export const INSTANCE_NAME = "autoflow-ci";
/** Exported to GITHUB_ENV so an always() step can find and remove the container. */
export const CONTAINER_ENV_VAR = "AUTOFLOW_LOCAL_CONVEX_CONTAINER";
const CONTAINER_NAME_PATTERN = /^autoflow-local-convex-[a-z0-9][a-z0-9-]{0,62}$/;

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
 * Refuses unless this process could only reach the local backend.
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
  const candidate = lines[lines.length - 1];
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

/** `convex env list --names-only` output to a sorted list of names. */
export function parseEnvNames(stdout) {
  const names = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new LocalConvexRefusal("The backend's variable listing contained an unexpected value.");
    }
  }
  return names.sort();
}

/** Exact equality with the allowlist; neither extra nor missing names pass. */
export function assertEnvMatchesAllowlist(actualNames) {
  const expected = [...ENV_ALLOWLIST].sort();
  const actual = [...actualNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    const missing = expected.filter((name) => !actual.includes(name));
    const extra = actual.filter((name) => !expected.includes(name));
    throw new LocalConvexRefusal(
      "The local backend environment does not match the allowlist. " +
        `Missing: [${missing.join(", ")}]. Unexpected: [${extra.join(", ")}].`,
    );
  }
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
    throw new LocalConvexRefusal(
      `convex ${args[0]}${args[1] && !args[1].startsWith("-") ? ` ${args[1]}` : ""} failed with exit code ${result.status}. ` +
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
  return (
    `Container state: ${boundedDiagnostic(state.stdout || state.stderr, secrets, 300).trim()}\n` +
    `Last ${LOG_TAIL_LINES} log lines:\n${boundedDiagnostic(`${logs.stdout}${logs.stderr}`, secrets)}`
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
  for (;;) {
    if (!isRunning()) return { ok: false, reason: "the container stopped before the backend answered" };
    try {
      const response = await deps.fetchImpl(`${LOCAL_CONVEX_URL}/version`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true };
    } catch {
      // Not listening yet: keep polling until the deadline.
    }
    if (deps.now() + intervalMs > deadline) {
      return { ok: false, reason: `no healthy answer from ${LOCAL_CONVEX_URL}/version within ${Math.round(timeoutMs / 1000)}s` };
    }
    await deps.sleep(intervalMs);
  }
}

async function pullImage(deps, env) {
  let last;
  for (let attempt = 1; attempt <= PULL_ATTEMPTS; attempt += 1) {
    last = docker(deps, env, ["pull", "--quiet", LOCAL_CONVEX_IMAGE]);
    if (last.status === 0) return;
    if (attempt < PULL_ATTEMPTS) await deps.sleep(2_000 * attempt);
  }
  throw new LocalConvexRefusal(
    `docker pull of the pinned image failed after ${PULL_ATTEMPTS} attempts: ${boundedDiagnostic(last?.stderr, [], 500).trim()}`,
  );
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
    case "stop":
      return stopBackend(env, deps);
    default:
      throw new LocalConvexRefusal("Usage: node scripts/localConvexBackend.mjs <start|env|deploy|stop>");
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
