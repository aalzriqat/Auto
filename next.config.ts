import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import "./lib/env";

const nextConfig: NextConfig = {
  // allowedDevOrigins removed — dev-only setting, not for production
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true,
  widenClientFileUpload: true,
  disableLogger: true,
});
