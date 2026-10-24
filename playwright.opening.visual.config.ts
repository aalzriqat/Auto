import { defineConfig, devices } from "@playwright/test";

/** Static opening allocation paint uses the installed Chrome channel; no app server. */
export default defineConfig({
  testDir: "./playwright/visual",
  testMatch: /opening-(?:allocation|commission)\.visual\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 180_000,
  outputDir: "test-results/opening-allocation-visual/artifacts",
  projects: [{ name: "installed-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome",
    storageState: { cookies: [], origins: [] }, trace: "off", video: "off" } }],
});
