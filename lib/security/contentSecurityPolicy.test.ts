import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  LOCAL_CONVEX_CI_FLAG,
  LOCAL_CONVEX_URL,
  localConvexCspSources,
} from "./contentSecurityPolicy";
import { SWARM_LOCAL_CONVEX_ORIGIN } from "../../scripts/intelligence/swarmConvexOrigin.mjs";

describe("local Convex origin", () => {
  it("is the same origin the CI backend runner and the swarm validators use", () => {
    expect(LOCAL_CONVEX_URL).toBe(SWARM_LOCAL_CONVEX_ORIGIN);
  });
});

/**
 * The exact header value origin/main shipped before SCRUM-892 (next.config.ts
 * at 803c73c08). Every build without the CI switch must reproduce it byte for
 * byte.
 */
const PRODUCTION_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://clerk.accounts.dev https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
  "worker-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: https://*.convex.cloud https://img.clerk.com https://lh3.googleusercontent.com https://*.googleusercontent.com; " +
  "connect-src 'self' https://*.convex.cloud wss://*.convex.cloud https://*.convex.site https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://clerk-telemetry.com https://vpic.nhtsa.dot.gov https://o4511556361715712.ingest.de.sentry.io https://cloudflareinsights.com https://vitals.vercel-insights.com; " +
  "frame-src https://challenges.cloudflare.com; " +
  "frame-ancestors 'none'";

const PROD_URL = "https://clever-mockingbird-719.convex.cloud";

describe("buildContentSecurityPolicy (SCRUM-892)", () => {
  it.each([
    ["no switch, production URL", { NEXT_PUBLIC_CONVEX_URL: PROD_URL }],
    ["no switch, Vercel build", { NEXT_PUBLIC_CONVEX_URL: PROD_URL, VERCEL: "1" }],
    ["no switch, even with the local URL", { NEXT_PUBLIC_CONVEX_URL: LOCAL_CONVEX_URL }],
    ["switch not exactly 1", { [LOCAL_CONVEX_CI_FLAG]: "true", NEXT_PUBLIC_CONVEX_URL: LOCAL_CONVEX_URL }],
    ["empty environment", {}],
  ])("is byte-identical to the production policy: %s", (_label, env) => {
    expect(buildContentSecurityPolicy(env)).toBe(PRODUCTION_CSP);
  });

  it("adds only the local backend's HTTP and websocket origins when the CI switch and URL both match", () => {
    const policy = buildContentSecurityPolicy({
      [LOCAL_CONVEX_CI_FLAG]: "1",
      NEXT_PUBLIC_CONVEX_URL: LOCAL_CONVEX_URL,
    });
    expect(policy).toBe(
      PRODUCTION_CSP.replace(
        "https://*.googleusercontent.com;",
        "https://*.googleusercontent.com http://127.0.0.1:3210;",
      ).replace(
        "https://vitals.vercel-insights.com;",
        "https://vitals.vercel-insights.com http://127.0.0.1:3210 ws://127.0.0.1:3210;",
      ),
    );
  });

  it("refuses the switch on a Vercel build instead of loosening its policy", () => {
    expect(() =>
      buildContentSecurityPolicy({
        [LOCAL_CONVEX_CI_FLAG]: "1",
        NEXT_PUBLIC_CONVEX_URL: LOCAL_CONVEX_URL,
        VERCEL: "1",
      }),
    ).toThrow(/never be set on a Vercel build/);
  });

  it.each([
    PROD_URL,
    "http://127.0.0.1:3210/",
    "http://localhost:3210",
    "http://127.0.0.1:3211",
    "https://127.0.0.1:3210",
    "",
    undefined,
  ])("refuses the switch with any Convex URL but the local backend: %s", (url) => {
    expect(() =>
      localConvexCspSources({ [LOCAL_CONVEX_CI_FLAG]: "1", NEXT_PUBLIC_CONVEX_URL: url }),
    ).toThrow(/requires NEXT_PUBLIC_CONVEX_URL/);
  });
});
