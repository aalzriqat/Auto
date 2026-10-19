/**
 * Offline browser-swarm Clerk mode (SCRUM-350 G4).
 *
 * The trusted browser attack swarm runs the exact candidate build in a Docker
 * container on an `--internal` network, with NO real CLERK_SECRET_KEY. Clerk's
 * middleware asserts a non-empty secret key, so without help every page behind
 * `proxy.ts` answers 500 while `/api/health` (excluded from the matcher) stays
 * green. The workflow therefore hands the candidate:
 *
 *   - AUTOFLOW_OFFLINE_SWARM_CLERK=1
 *   - CLERK_SECRET_KEY = OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET (public, fixed,
 *     nonfunctional; it authenticates nothing anywhere)
 *   - a pk_test_ publishable key
 *   - CLERK_JWT_KEY (the PUBLIC verification key of the dev instance)
 *
 * and this module decides, per request, whether `proxy.ts` may pass the JWT
 * key to Clerk as the networkless `jwtKey` middleware option.
 *
 * Fail-closed contract: the flag being set is a promise that ALL the conditions
 * hold. If any does not, the decision is `refused` and the proxy answers 503 to
 * every request it handles. Outside the flag the decision is `off` and the
 * middleware options are exactly what they were before this module existed, so a
 * production CLERK_JWT_KEY can never change production behaviour.
 *
 * The placeholder is public by design and is NOT described as "never sent":
 * Clerk may use the secret as a bearer credential on Backend API paths. It is
 * harmless because it is not a real key, and the candidate network is internal.
 */

export const OFFLINE_SWARM_CLERK_FLAG = "AUTOFLOW_OFFLINE_SWARM_CLERK";

export const OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET =
  "sk_test_autoflow_offline_swarm_placeholder_nonfunctional";

const TEST_PUBLISHABLE_PREFIX = "pk_test_";

type Env = Readonly<Record<string, string | undefined>>;

export type OfflineSwarmClerkDecision =
  | { readonly mode: "off" }
  | { readonly mode: "offline"; readonly jwtKey: string }
  | { readonly mode: "refused"; readonly reasons: readonly string[] };

export function decideOfflineSwarmClerk(env: Env): OfflineSwarmClerkDecision {
  const flag = env[OFFLINE_SWARM_CLERK_FLAG];
  // Unset or empty is "off". Anything else, including "0" or "true", is an
  // attempt to enter the mode that is not the exact opt-in, so it is refused
  // rather than silently interpreted either way.
  if (flag === undefined || flag === "") return { mode: "off" };

  const reasons: string[] = [];
  if (flag !== "1") {
    reasons.push(`${OFFLINE_SWARM_CLERK_FLAG} must be exactly "1"`);
  }
  if (env.CLERK_SECRET_KEY !== OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET) {
    reasons.push("CLERK_SECRET_KEY is not the offline swarm placeholder");
  }
  if (
    !env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith(TEST_PUBLISHABLE_PREFIX)
  ) {
    reasons.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not a pk_test_ key");
  }
  const jwtKey = env.CLERK_JWT_KEY;
  if (!jwtKey || jwtKey.trim() === "") {
    reasons.push("CLERK_JWT_KEY is empty");
  }

  if (reasons.length > 0 || !jwtKey) return { mode: "refused", reasons };
  return { mode: "offline", jwtKey };
}

/** Middleware options for one request: `{ jwtKey }` in offline mode, else `{}`. */
export function offlineSwarmClerkOptions(decision: OfflineSwarmClerkDecision): {
  jwtKey?: string;
} {
  return decision.mode === "offline" ? { jwtKey: decision.jwtKey } : {};
}
