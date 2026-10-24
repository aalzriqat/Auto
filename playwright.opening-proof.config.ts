import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/** Terminal only: these cases deliberately change the original QA membership inventory. */
export default defineConfig({
  ...base,
  testDir: "./playwright/opening-proof",
  testMatch: "opening-onboarding.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "test-results/opening-proof",
  reporter: [
    ["html", { outputFolder: "opening-proof-report", open: "never" }],
    ["json", { outputFile: "opening-proof-json/results.json" }],
    ["list"],
  ],
  metadata: { openingProof: {
    baseSha: process.env.BASE_SHA, headSha: process.env.HEAD_SHA,
    testedSha: process.env.TESTED_SHA, controllerSha: process.env.CONTROLLER_SHA,
    runId: process.env.OPENING_PROOF_RUN_ID,
  } },
  use: { ...base.use, screenshot: "off", video: "off", trace: "off" },
  // Auth states already exist: the preceding main suite or trusted job auth produced both.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], storageState: "playwright/.auth/user.json" } }],
  // The preview deploy key is used only by the trusted pre-batch command, never the app.
  webServer: base.webServer && !Array.isArray(base.webServer)
    ? { ...base.webServer, env: { ...base.webServer.env, CONVEX_DEPLOY_KEY: "" } }
    : base.webServer,
});
