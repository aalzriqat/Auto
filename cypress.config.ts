import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "cypress";

function loadEnvLocal(): void {
  const envFile = resolve(process.cwd(), ".env.local");
  if (!existsSync(envFile)) return;

  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvLocal();

export default defineConfig({
  projectId: "7p2uis",
  env: {
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
  },

  // Matches Playwright's "Desktop Chrome" (1280x720). Cypress defaults to
  // 1000x660, so the two suites — which cover the same flows by design — were
  // asserting against different layouts, and the shorter one was the only place
  // a flake lived.
  //
  // Concretely: the feedback FAB is `fixed bottom-[5.5rem] end-5`, and at 660px
  // tall the sales wizard's footer lands in that same bottom-right region once
  // Cypress scrolls "Submit Sale" into view. Cypress then refuses to click a
  // covered element and times out on a button that is perfectly usable — five
  // times in one afternoon, on main as well as on branches. Playwright clicks
  // the identical button with no special handling and has never flaked, which is
  // what pointed at viewport geometry rather than the widget.
  viewportWidth: 1280,
  viewportHeight: 720,

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
