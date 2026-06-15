import * as Sentry from "@sentry/nextjs";

const isProd = process.env.NODE_ENV === "production";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  // Sample 10% of transactions in production, 100% in dev
  tracesSampleRate: isProd ? 0.1 : 1,

  // Always replay the session leading up to an error
  replaysOnErrorSampleRate: 1.0,
  // Randomly sample 5% of other sessions
  replaysSessionSampleRate: isProd ? 0.05 : 0,

  integrations: [Sentry.replayIntegration()],

  debug: false,
});
