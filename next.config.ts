import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import "./lib/env";
import { buildContentSecurityPolicy } from "./lib/security/contentSecurityPolicy";

// Byte-identical to the cloud-only policy unless the explicit CI switch is set
// (SCRUM-892); a misconfigured switch throws and fails the build.
const contentSecurityPolicy = buildContentSecurityPolicy(process.env);

const nextConfig: NextConfig = {
  // SCRUM-350 builds a self-contained runtime exactly once in the trusted
  // browser controller. Normal development/production builds keep their
  // existing shape.
  output:
    process.env.AUTOFLOW_SWARM_STANDALONE === "1" ? "standalone" : undefined,
  transpilePackages: ["@autoflow/shared"],
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
            value: contentSecurityPolicy,
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
