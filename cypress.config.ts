import { defineConfig } from "cypress";

export default defineConfig({
  // TODO: set this once a project is created under the Cypress Cloud org —
  // see the "Cypress Cloud setup" note in the E2E README for the one-time
  // manual step (this can't be provisioned non-interactively).
  projectId: process.env.CYPRESS_PROJECT_ID,

  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL ?? "http://localhost:3000",
    supportFile: "cypress/support/e2e.ts",
    specPattern: "cypress/e2e/**/*.cy.ts",
    defaultCommandTimeout: 15_000,
    pageLoadTimeout: 30_000,
    video: true,
    screenshotOnRunFailure: true,
    retries: {
      runMode: 1,
      openMode: 0,
    },
  },
});
