import { defineConfig, devices } from "@playwright/test";

/**
 * The static visual gate: no web server, no Clerk session, no Convex.
 *
 * `playwright/visual/*.visual.spec.ts` render the app's own markup (produced
 * by a vitest bridge) under the app's own compiled stylesheet and look at it
 * in a real engine. Kept out of `playwright.config.ts` on purpose: that config
 * builds and starts the app and depends on the auth setup project, none of
 * which a static page needs.
 *
 *   npx playwright test -c playwright.visual.config.ts
 */
export default defineConfig({
  testDir: "./playwright/visual",
  testMatch: /.*\.visual\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  outputDir: "test-results/deal-cockpit-visual/artifacts",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The deals list's whole-row link rests on a `relative` <tr>, which WebKit
    // historically ignored; prove the hit target there too (SCRUM-694 review M3).
    { name: "webkit", testMatch: /deals-list\.visual\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
  ],
});
