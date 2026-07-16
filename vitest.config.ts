import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // The only two variables convex/utils/env.ts's backendEnvSchema actually
    // requires — every other entry is .optional(). Without them getValidatedEnv
    // throws, and because notify* fans out to sender actions through
    // scheduler.runAfter(0, ...) (a real setTimeout under convex-test), that
    // throw surfaces from a scheduled function AFTER the test that queued it has
    // finished. convex-test logs the failure whenever it lands, and when it
    // lands during teardown the log races the worker's rpc close:
    //   EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending
    // — which fails the whole job while every test still passes. CI sets only
    // NODE_ENV, so it saw this and local (with .env.local) did not.
    //
    // Setting them here fixes it for every suite at once rather than per-file:
    // the senders now run to completion harmlessly (RESEND_API_KEY stays unset,
    // which sendNotificationEmail already treats as a no-op success), so nothing
    // logs and there is no teardown race left to lose. Dummy values on purpose —
    // no test asserts on them, and nothing here reaches a real service.
    env: {
      CLERK_JWT_ISSUER_DOMAIN: "https://test.clerk.accounts.dev",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    },
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules", "**/node_modules/**", ".next", "out", "build"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json-summary"],
      // Track files that have dedicated unit/integration test suites.
      // Convex mutations with minimal tests and all UI components/pages
      // are covered by TestSprite E2E tests instead.
      include: [
        "lib/colorUtils.ts",
        "lib/commission.ts",
        "lib/vinHelpers.ts",
        "lib/financing.ts",
        "convex/orgSettings.ts",
        "convex/orgLeadSources.ts",
        "convex/orgPipelineStages.ts",
        "convex/orgCustomFields.ts",
        "convex/orgValuationCompanies.ts",
        "convex/wizardDrafts.ts",
        "convex/utils/tenancy.ts",
        "convex/notifications.ts",
        "convex/notificationPreferences.ts",
        "convex/utils/notifications.ts",
        "lib/notifications/types.ts",
        "lib/notifications/render.ts",
      ],
      exclude: ["convex/_generated/**"],
      thresholds: {
        lines: 90,
        functions: 85,
        branches: 75,
        statements: 90,
      },
    },
  },
});
