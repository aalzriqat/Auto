/**
 * SCRUM-784 / SCRUM-350 G4: the browser-side egress launch surface.
 *
 * Loaded by playwright.config.ts and playwright/containedContext.ts, which
 * Playwright transpiles to CommonJS. Keep this file free of imports,
 * `import.meta` and top-level await: any of them breaks every spec at load
 * time ("No tests found"). scripts/intelligence/browserEgressLaunch.test.ts
 * enforces that. The trusted proxy itself lives in browserEgressContainment.mjs,
 * which re-exports everything here.
 */

export const BROWSER_EGRESS_PROXY_ENV = "BROWSER_EGRESS_PROXY_SERVER";
export const BROWSER_EGRESS_REQUIRED_ENV = "BROWSER_EGRESS_REQUIRED";

/** Context options every candidate-facing browser context must use. */
export const EGRESS_CONTEXT_OPTIONS = Object.freeze({ serviceWorkers: "block" });

/**
 * Chromium flags that close paths a proxy setting alone leaves open:
 * - no local DNS resolution at all (the proxy resolves; a page cannot make the
 *   browser process resolve an attacker name, which would be a DNS channel);
 * - WebRTC may only use the proxy, never direct UDP (STUN/TURN is an exfil
 *   channel that ignores --proxy-server);
 * - no QUIC/HTTP3 (UDP that would bypass an HTTP proxy).
 */
export const EGRESS_CHROMIUM_ARGS = Object.freeze([
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-quic",
]);

/**
 * Playwright `launchOptions` for the egress proxy, or undefined when egress
 * containment is not requested. When BROWSER_EGRESS_REQUIRED=1 a missing or
 * malformed proxy is an error, never a silent fall-back to open egress.
 *
 * Playwright adds `--proxy-bypass-list=<-loopback>` itself when no bypass is
 * given, so loopback traffic (including the candidate) also traverses the proxy.
 *
 * @param {Record<string, string | undefined>} env
 */
export function browserEgressLaunchOptions(env) {
  const server = env[BROWSER_EGRESS_PROXY_ENV]?.trim();
  if (!server) {
    if (env[BROWSER_EGRESS_REQUIRED_ENV] === "1") {
      throw new Error(
        `${BROWSER_EGRESS_REQUIRED_ENV}=1 but ${BROWSER_EGRESS_PROXY_ENV} is not set; refusing to launch a browser with open egress.`,
      );
    }
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(server);
  } catch {
    throw new Error(`${BROWSER_EGRESS_PROXY_ENV} must be a valid URL.`);
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${BROWSER_EGRESS_PROXY_ENV} must be exactly http://127.0.0.1:<port>.`,
    );
  }
  return { proxy: { server: parsed.origin }, args: [...EGRESS_CHROMIUM_ARGS] };
}
