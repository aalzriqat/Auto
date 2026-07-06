import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import "./lib/env";

const nextConfig: NextConfig = {
  // Baked into the client bundle at build time — compared at runtime against
  // /api/build-id (read fresh on every request) to detect when a tab is
  // running an older build than what's currently deployed. Falls back to a
  // constant outside Vercel (local dev) where this never differs.
  env: {
    NEXT_PUBLIC_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  },
  async redirects() {
    return [
      // Some E2E tools (and users) guess /login; send them to the real Clerk page.
      { source: "/login", destination: "/sign-in", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://clerk.accounts.dev https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://challenges.cloudflare.com https://static.cloudflareinsights.com",
              "worker-src 'self' blob:",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: blob: https://*.convex.cloud https://img.clerk.com",
              "connect-src 'self' https://*.convex.cloud wss://*.convex.cloud https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://clerk-telemetry.com https://vpic.nhtsa.dot.gov https://o4511556361715712.ingest.de.sentry.io https://cloudflareinsights.com https://vitals.vercel-insights.com",
              "frame-src https://challenges.cloudflare.com",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

if (!process.env.SENTRY_ORG || !process.env.SENTRY_PROJECT) {
  console.warn("⚠️  WARNING: SENTRY_ORG or SENTRY_PROJECT is missing. Application errors will not be tracked in production.");
}

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true,
  widenClientFileUpload: true,
});
