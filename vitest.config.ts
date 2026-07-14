import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules", "**/node_modules/**", ".next", "out", "build", "apps/**", "packages/**"],
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
