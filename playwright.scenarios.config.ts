import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * The deal scenario matrix and the screen audit (SCRUM-595).
 *
 * Kept out of `playwright.config.ts` on purpose: every scenario drives a full
 * financed or cancelled deal through the UI and then checks every general
 * ledger line, so the matrix takes ~45 minutes at one worker. It would blow the
 * 35-minute budget of the trusted-main E2E job, and its specs share one org's
 * GL, so they must never run in parallel with each other.
 *
 *   npx playwright test -c playwright.scenarios.config.ts
 *
 * It reuses the base config's auth setup project, web server and storage
 * states; only the test directory, the per-test budget and the evidence
 * (video + screenshot on every test) differ.
 */
export default defineConfig({
  ...base,
  testDir: "./playwright/scenarios",
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  use: { ...base.use, video: "on", screenshot: "on", trace: "retain-on-failure" },
  // In CI this run holds the preview deploy key, only so the explorer can ask
  // the backend whether it is the seeded preview. The app server never needs
  // it, so it never sees it (Playwright merges this over process.env).
  webServer:
    base.webServer && !Array.isArray(base.webServer)
      ? { ...base.webServer, env: { ...base.webServer.env, CONVEX_DEPLOY_KEY: "" } }
      : base.webServer,
  projects: [
    { ...base.projects![0], testDir: "./playwright/tests" },
    ...base.projects!.slice(1),
    // SCRUM-760 G8 scripted witnesses. Nothing depends on this project, so a red
    // witness never skips the ledger matrix, and it is listed last so that, in
    // the same dependency phase at one worker, the matrix runs first and sees
    // exactly the state it saw before G8. Its failure still fails the run.
    {
      ...base.projects![1],
      name: "pilot-scripted",
      testDir: "./playwright/tests",
      testMatch: ["sales.spec.ts", "financed-deal-economics.spec.ts", "accounting.spec.ts"],
      testIgnore: [],
      dependencies: ["setup"],
    },
  ],
});
