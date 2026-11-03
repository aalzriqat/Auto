/**
 * SCRUM-892: the one Convex origin a browser swarm run may talk to.
 *
 * The swarm used to run against a Convex CLOUD preview (https, *.convex.cloud).
 * It now runs against a self-hosted Convex backend that lives inside each
 * GitHub Actions runner (scripts/localConvexBackend.mjs). Every swarm
 * validator that used to demand a *.convex.cloud origin accepts that cloud
 * shape AND exactly this one local origin, and nothing else on loopback.
 *
 * Dependency-free on purpose (no imports, no import.meta, no top-level await):
 * Playwright transpiles the fixtures and configs that read it to CommonJS, the
 * same constraint browserEgressLaunch.mjs documents. A test pins
 * SWARM_LOCAL_CONVEX_ORIGIN equal to scripts/localConvexBackend.mjs's
 * LOCAL_CONVEX_URL, so the two cannot drift apart.
 */

/** Exact origin of the runner-local Convex backend (HTTP API and WebSocket sync). */
export const SWARM_LOCAL_CONVEX_ORIGIN = "http://127.0.0.1:3210";

/** Instance name of the runner-local Convex backend (INSTANCE_NAME in scripts/localConvexBackend.mjs). */
export const SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME = "autoflow-ci";

/** Exact authority (host:port) of the runner-local Convex backend. */
export const SWARM_LOCAL_CONVEX_AUTHORITY = "127.0.0.1:3210";

/**
 * True only for the exact local backend URL: the origin itself, or the origin
 * with one trailing slash. Not a prefix match, so a different port, host name,
 * address, scheme, credentials, path, query or fragment all return false.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSwarmLocalConvexUrl(value) {
  return (
    typeof value === "string" &&
    (value === SWARM_LOCAL_CONVEX_ORIGIN || value === `${SWARM_LOCAL_CONVEX_ORIGIN}/`)
  );
}
