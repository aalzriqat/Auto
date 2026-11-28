/**
 * Which Convex backend the production release path addresses, and the refusals
 * that must hold before anything is deployed to a SELF-HOSTED one (SCRUM-1026).
 *
 * Pure functions plus one injectable `fetch`, so a test can call every decision.
 *
 * ## Precedents reused (mechanism, not surface)
 * - `requireBoundProductionKey` (releaseGuard.ts): the target is NAMED in a
 *   non-secret variable and every credential must be shown to address exactly
 *   that name; an unreadable shape is never granted the dangerous meaning; no
 *   secret is printed.
 * - `scripts/localConvexBackend.mjs`: the admin-key shape check and the refusal
 *   to run while any cloud-pointing variable is present, so the CLI cannot be
 *   steered to a cloud deployment.
 *
 * ## Sources (checked 2026-11-28)
 * - get-convex/convex-backend `self-hosted/README.md`: the CLI is pointed with
 *   CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY.
 * - get-convex/convex-backend `crates/local_backend/src/router.rs`
 *   (`health_check_routes`): `GET /instance_name` answers with the backend's
 *   configured INSTANCE_NAME as plain text, no credential.
 * - GitHub Actions: `secrets` are not readable in `if:`; untrusted input goes
 *   through `env:`, never interpolated into `run:`.
 * - convex 1.42.1 `cli/lib/deploymentSelection.js` (`getDeploymentSelectionFromEnv`)
 *   and `cli/lib/utils/utils.js` (`readDeployKeyFromEnv`): the CLI reads a deploy
 *   key (`CONVEX_DEPLOY_KEY`, else `CONVEX_DEPLOYMENT_TOKEN`) FIRST and returns
 *   before it looks at `CONVEX_SELF_HOSTED_URL` / `_ADMIN_KEY`. It refuses only
 *   `CONVEX_DEPLOYMENT` set together with the self-hosted pair. So the CLI does
 *   NOT protect a self-hosted step from a cloud key: `assertSelfHostedCliEnv`
 *   does, and every self-hosted step must run it.
 * - WHATWG URL Standard, `URL.origin`: the serialisation that the raw URL must
 *   equal (see `parseSelfHostedUrl`).
 *
 * ## TRUTHFUL LIMITS (not fixed here)
 * - A self-hosted backend has ONE admin key with full power. The cloud path's
 *   separation of deploy / operator / observer credentials does not exist on
 *   this target: every step holds the same key.
 * - The instance name is SELF-DECLARED by the backend. Matching it is a
 *   targeting check (right machine, right configuration), not authentication.
 *   Whoever controls DNS for the URL controls the answer.
 */

export type Refusal = { ok: false; reason: string };
export type ReleaseTarget = "cloud" | "self-hosted";

/** Variables that would point the Convex CLI at a cloud deployment. */
export const CLOUD_POINTING_VARS = [
  "CONVEX_DEPLOY_KEY",
  // Read by the CLI exactly like CONVEX_DEPLOY_KEY (`readDeployKeyFromEnv`, convex 1.42.1).
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_DEPLOYMENT",
  "CONVEX_PREVIEW_DEPLOY_KEY",
] as const;

/**
 * Everything that means "self-hosted" and so must be absent from the cloud
 * branch. `_PRESENT` is the boolean the cloud credential step is given instead
 * of the secret itself.
 */
export const SELF_HOSTED_VARS = [
  "CONVEX_PROD_SELF_HOSTED_URL",
  "CONVEX_PROD_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_PROD_SELF_HOSTED_ADMIN_KEY_PRESENT",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
] as const;

const refuse = (reason: string): Refusal => ({ ok: false, reason });

type Env = Record<string, string | undefined>;
const present = (env: Env, name: string): boolean => (env[name] ?? "").trim() !== "";

// ─── Target selection ───────────────────────────────────────────────────────

/**
 * Exactly two accepted values: unset/empty or `cloud`, and `self-hosted`.
 * Case, whitespace and near-misses refuse: a typo must not fall through to a
 * deploy with a different identity check than the one the operator intended.
 */
export function parseReleaseTarget(raw: string | undefined): { ok: true; target: ReleaseTarget } | Refusal {
  if (raw === undefined || raw === "" || raw === "cloud") return { ok: true, target: "cloud" };
  if (raw === "self-hosted") return { ok: true, target: "self-hosted" };
  return refuse(
    "CONVEX_PROD_TARGET must be unset, `cloud` or `self-hosted`; any other value is refused before anything is deployed."
  );
}

// ─── The backend URL ────────────────────────────────────────────────────────

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isCloudHost(host: string): boolean {
  return ["convex.cloud", "convex.site"].some((zone) => host === zone || host.endsWith(`.${zone}`));
}

/**
 * Accepts one shape: `https://<dns hostname>` with at most one trailing `/`,
 * written exactly as the WHATWG parser would emit it (`raw === URL.origin`, or
 * `URL.origin + "/"`; the same rule `lib/security/contentSecurityPolicy.ts`
 * applies). The raw value is what the Convex CLI receives, so a spelling the
 * parser would normalise (`:443`, `:0443`, `https:/host`, `/.`, `/%2e`, upper
 * case, percent-encoding) is refused, not silently accepted. The error text
 * names the rule and never repeats the candidate, which may carry userinfo.
 */
export function parseSelfHostedUrl(raw: string | undefined): { ok: true; origin: string; host: string } | Refusal {
  const shape = "CONVEX_PROD_SELF_HOSTED_URL must be a bare https origin on a DNS hostname of your own";
  const text = raw ?? "";
  if (text === "" || text !== text.trim() || /[\s\u0000-\u001f\\?#@]/.test(text)) {
    return refuse(`${shape} (no whitespace, userinfo, query or fragment).`);
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse(`${shape}; the value is not a URL.`);
  }
  if (url.protocol !== "https:") return refuse(`${shape}; the scheme must be https.`);
  if (url.username !== "" || url.password !== "") return refuse(`${shape}; userinfo is refused.`);
  if (url.port !== "") return refuse(`${shape}; an explicit port is refused.`);
  if (url.pathname !== "/") return refuse(`${shape}; a path is refused.`);

  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  // WHATWG normalises decimal/hex/octal IPv4 forms to dotted decimal, so a
  // numeric last label catches every IPv4 spelling; IPv6 keeps brackets/colons.
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label)) || /^[0-9]+$/.test(labels[labels.length - 1])) {
    return refuse(`${shape}; it must be a DNS name (no IP literal, no single label).`);
  }
  if (host === "localhost" || host.endsWith(".localhost")) return refuse(`${shape}; loopback names are refused.`);
  if (isCloudHost(host)) return refuse(`${shape}; a Convex Cloud host is not a self-hosted backend.`);
  // WHATWG URL elides the default port, so `https://host:443` can never equal
  // `URL.origin`; it is refused here with its own message.
  if (text !== url.origin && text !== `${url.origin}/`) {
    return refuse(
      /:0*443\/?$/.test(text)
        ? `${shape}; drop :443, the default https port.`
        : `${shape}; write it exactly as ${url.origin} (canonical form: lowercase, no empty port, no percent-encoding, at most one trailing slash).`
    );
  }
  return { ok: true, origin: url.origin, host };
}

// ─── The admin key ──────────────────────────────────────────────────────────

/**
 * `<instance name>|<opaque token>`. Shape only: the token alphabet is Convex's.
 * Same pattern as `ADMIN_KEY_PATTERN` in localConvexBackend.mjs (not imported:
 * that module is the CI harness and drags in unrelated dependencies). A cloud
 * key (`prod:<name>|…`) cannot match, because `:` is not in the name alphabet.
 */
const ADMIN_KEY = /^([A-Za-z0-9][A-Za-z0-9._-]{0,62})\|[A-Za-z0-9+/=_-]{16,512}$/;
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export type SelfHostedKey = { kind: "self-hosted"; instance: string } | { kind: "missing" | "malformed"; instance: null };

export function parseSelfHostedAdminKey(rawKey: string | undefined): SelfHostedKey {
  const key = rawKey ?? "";
  if (key.trim() === "") return { kind: "missing", instance: null };
  const match = ADMIN_KEY.exec(key);
  return match ? { kind: "self-hosted", instance: match[1] } : { kind: "malformed", instance: null };
}

/** The key must address exactly the instance this repository expects. */
export function requireBoundSelfHostedKey(
  rawKey: string | undefined,
  expectedInstance: string | undefined
): { ok: true; instance: string } | Refusal {
  const expected = (expectedInstance ?? "").trim();
  if (expected === "") {
    return refuse("CONVEX_PROD_DEPLOYMENT is not set. This workflow will not act on a backend it cannot name in advance.");
  }
  if (!INSTANCE_NAME.test(expected)) {
    return refuse("CONVEX_PROD_DEPLOYMENT is not a readable instance name.");
  }
  const key = parseSelfHostedAdminKey(rawKey);
  if (key.kind === "missing") {
    return refuse("Refusing: no self-hosted admin key was provided; the production environment's secret is not configured.");
  }
  if (key.kind === "malformed") {
    return refuse("Refusing: the self-hosted admin key is not of the shape `<instance name>|<token>`. Not reproduced.");
  }
  if (key.instance !== expected) {
    return refuse(
      "Refusing: the self-hosted admin key addresses a different instance name than CONVEX_PROD_DEPLOYMENT. " +
        "A valid key for the wrong backend would deploy and report success there."
    );
  }
  return { ok: true, instance: expected };
}

// ─── What the backend says about itself ─────────────────────────────────────

const MAX_INSTANCE_BODY = 256;
const REQUEST_TIMEOUT_MS = 10_000;

/** Exact equality, one trailing newline tolerated. Empty, prefix and superset all refuse. */
export function checkInstanceNameBody(body: string, expectedInstance: string): { ok: true } | Refusal {
  if (body.length > MAX_INSTANCE_BODY) return refuse("The backend's instance_name answer was not a short plain name.");
  const reported = body.endsWith("\n") ? body.slice(0, -1) : body;
  if (reported === "" || !INSTANCE_NAME.test(reported)) {
    return refuse("The backend's instance_name answer was empty or not a plain instance name.");
  }
  if (reported !== expectedInstance) {
    return refuse("The backend at that URL reports a different instance name than CONVEX_PROD_DEPLOYMENT.");
  }
  return { ok: true };
}

/**
 * Asks the backend, WITHOUT credentials, which instance it is. Never follows a
 * redirect (a 3xx is a refusal, so the answer cannot come from another host),
 * requires exactly 200, and never echoes the transport error.
 */
export async function fetchInstanceName(
  origin: string,
  expectedInstance: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true } | Refusal> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/instance_name`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return refuse("The backend did not answer /instance_name; its identity cannot be confirmed.");
  }
  if (response.status !== 200) {
    return refuse(`The backend answered /instance_name with HTTP ${response.status}, not 200 (redirects are never followed).`);
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return refuse("The backend's /instance_name answer could not be read.");
  }
  return checkInstanceNameBody(body, expectedInstance);
}

// ─── Environment separation ─────────────────────────────────────────────────

/** A self-hosted CLI step must not hold anything the CLI could resolve to a cloud deployment. */
export function assertSelfHostedCliEnv(env: Env): { ok: true } | Refusal {
  for (const name of CLOUD_POINTING_VARS) {
    if (present(env, name)) {
      return refuse(`${name} is present in a self-hosted step. The Convex CLI would resolve its target from it. Remove it.`);
    }
  }
  return { ok: true };
}

/** The cloud branch must see none of the self-hosted configuration, and a target that says cloud. */
export function assertCloudTargetEnv(env: Env): { ok: true } | Refusal {
  const target = parseReleaseTarget(env.CONVEX_PROD_TARGET);
  if (!target.ok) return target;
  if (target.target !== "cloud") {
    return refuse("CONVEX_PROD_TARGET is `self-hosted` but the cloud credential gate ran. Mixed configuration is refused.");
  }
  for (const name of SELF_HOSTED_VARS) {
    // The `_PRESENT` flag is the string `false` when the secret is absent.
    if (present(env, name) && !(name.endsWith("_PRESENT") && env[name]?.trim() === "false")) {
      return refuse(`${name} is set while the target is cloud. Mixed configuration is refused; unset it or choose the self-hosted target.`);
    }
  }
  return { ok: true };
}

// ─── The whole pre-deploy decision ──────────────────────────────────────────

export type SelfHostedRelease = { ok: true; instance: string; host: string; origin: string };

/**
 * Everything that must hold, in order, before a self-hosted deploy. Offline
 * checks run first so a misconfiguration never causes a network call.
 */
export async function verifySelfHostedRelease(env: Env, fetchImpl: typeof fetch = fetch): Promise<SelfHostedRelease | Refusal> {
  const target = parseReleaseTarget(env.CONVEX_PROD_TARGET);
  if (!target.ok) return target;
  if (target.target !== "self-hosted") return refuse("The self-hosted gate ran while CONVEX_PROD_TARGET is not `self-hosted`.");

  const cli = assertSelfHostedCliEnv(env);
  if (!cli.ok) return cli;
  const url = parseSelfHostedUrl(env.CONVEX_PROD_SELF_HOSTED_URL);
  if (!url.ok) return url;
  const key = requireBoundSelfHostedKey(env.CONVEX_PROD_SELF_HOSTED_ADMIN_KEY, env.CONVEX_PROD_DEPLOYMENT);
  if (!key.ok) return key;
  const answered = await fetchInstanceName(url.origin, key.instance, fetchImpl);
  if (!answered.ok) return answered;
  return { ok: true, instance: key.instance, host: url.host, origin: url.origin };
}

/**
 * The function runtime's own `CONVEX_CLOUD_URL` must be the configured origin:
 * the deployment states its identity over the connection the rollout uses. The
 * operator must therefore set the backend's CONVEX_CLOUD_ORIGIN to that same
 * public URL, or the rollout refuses (loudly, never silently).
 */
export function assertSelfHostedDeploymentIdentity(
  reportedUrl: string | null | undefined,
  expectedOrigin: string
): { ok: true } | Refusal {
  // The runtime's answer is data: only a non-empty string is examined.
  if (typeof reportedUrl !== "string" || reportedUrl === "") {
    return refuse("The backend did not report its own URL, so its identity cannot be confirmed.");
  }
  const parsed = parseSelfHostedUrl(reportedUrl.trim());
  if (!parsed.ok) return refuse("The backend reported a URL that is not a self-hosted https origin.");
  if (parsed.origin !== expectedOrigin) {
    return refuse("The backend reported a different URL than the one configured; verification was pointed somewhere else.");
  }
  return { ok: true };
}
