import * as Sentry from "@sentry/nextjs";

// SCRUM-1033: the browser SDK was never initialised in production. Next.js 16
// bundles with Turbopack by default, and @sentry/nextjs only loads the legacy
// `sentry.client.config.ts` through its webpack integration. Next.js runs this
// file in the browser before React hydrates:
//   https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
//   https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
//
// Error reporting ONLY: a conservative default recorded in SCRUM-1033 until
// the owner decides otherwise. This app shows customer names,
// phone numbers, national IDs and money, so deliberately NOT enabled:
//   - Session Replay (no replayIntegration, no replay sample rates),
//   - sendDefaultPii,
//   - tracing (no tracesSampleRate).
// Turning any of these on needs the owner's decision.
//
// Without a DSN baked into the build this is a silent no-op: the SDK sends
// nothing when no DSN is set, and we skip init so nothing is logged either.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    debug: false,
  });
}

// Required by @sentry/nextjs to instrument App Router navigations.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
