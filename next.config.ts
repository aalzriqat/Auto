import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import "./lib/env";

const nextConfig: NextConfig = {
  // allowedDevOrigins removed — dev-only setting, not for production
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
