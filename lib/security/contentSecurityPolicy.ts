/**
 * SCRUM-892: CI runs the app against a self-hosted Convex backend on the
 * runner's loopback instead of a cloud preview deployment. The browser then
 * talks to `http://127.0.0.1:3210` and `ws://127.0.0.1:3210`, which the
 * cloud-only CSP refuses, so every authenticated page stalls on
 * "Loading your workspace...".
 *
 * ⚠️ The loopback sources are added ONLY when BOTH hold:
 *   - the explicit CI switch `AUTOFLOW_LOCAL_CONVEX_CI` is exactly "1", and
 *   - the build's Convex URL is exactly the local CI backend.
 * With the switch unset (every Vercel preview and production build) the
 * policy is byte-identical to the cloud-only one. A switch that is set where
 * it must not be — on Vercel, or with any other Convex URL — throws, so the
 * build fails instead of shipping a loosened policy.
 */
export const LOCAL_CONVEX_URL = "http://127.0.0.1:3210";
export const LOCAL_CONVEX_CI_FLAG = "AUTOFLOW_LOCAL_CONVEX_CI";

type Env = Record<string, string | undefined>;

export interface LocalConvexCspSources {
  connect: string[];
  img: string[];
}

export function localConvexCspSources(env: Env): LocalConvexCspSources {
  if (env[LOCAL_CONVEX_CI_FLAG] !== "1") return { connect: [], img: [] };
  if (env.VERCEL) {
    throw new Error(`${LOCAL_CONVEX_CI_FLAG} must never be set on a Vercel build.`);
  }
  if (env.NEXT_PUBLIC_CONVEX_URL !== LOCAL_CONVEX_URL) {
    throw new Error(
      `${LOCAL_CONVEX_CI_FLAG}=1 requires NEXT_PUBLIC_CONVEX_URL to be exactly ${LOCAL_CONVEX_URL}.`,
    );
  }
  return {
    connect: [LOCAL_CONVEX_URL, "ws://127.0.0.1:3210"],
    // File storage URLs are served from the backend origin.
    img: [LOCAL_CONVEX_URL],
  };
}

function withSources(directive: string, sources: string[]): string {
  return sources.length > 0 ? `${directive} ${sources.join(" ")}` : directive;
}

/** The Content-Security-Policy header value for this build. */
export function buildContentSecurityPolicy(env: Env): string {
  const local = localConvexCspSources(env);
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://clerk.accounts.dev https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    withSources(
      "img-src 'self' data: blob: https://*.convex.cloud https://img.clerk.com https://lh3.googleusercontent.com https://*.googleusercontent.com",
      local.img,
    ),
    withSources(
      "connect-src 'self' https://*.convex.cloud wss://*.convex.cloud https://*.convex.site https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://clerk-telemetry.com https://vpic.nhtsa.dot.gov https://o4511556361715712.ingest.de.sentry.io https://cloudflareinsights.com https://vitals.vercel-insights.com",
      local.connect,
    ),
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
  ].join("; ");
}
