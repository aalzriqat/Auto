import { defineConfig } from "@playwright/test";
import base from "./playwright.scenarios.config";
import { PILOT_G8_ROLE_PROJECT, PILOT_G8_ROLE_TAG } from "./playwright/fixtures/pilotHunt";

const PILOT_G8_ROLE_TAG_PATTERN = new RegExp(PILOT_G8_ROLE_TAG);
const roleSeatUse = { ...base.projects![1].use, storageState: "playwright/.auth/approver.json", trace: "off", video: "off", screenshot: "off" } as const;

export default defineConfig({
  ...base,
  testDir: "./playwright/role-audit",
  workers: 1,
  retries: 0,
  // Default local output stays on the private process stream. The packaged
  // audit adds Playwright's JSON reporter to a fresh private invocation path
  // so its seven role cases are measured before completeness is published.
  reporter: "line",
  // Public evidence is limited to explicit post-login captures and summaries.
  // Auth setup must never record credentials or tokens into traces or video.
  use: { ...base.use, trace: "off", video: "off", screenshot: "off" },
  projects: [
    { ...base.projects![0], testDir: "./playwright/tests" },
    {
      name: "role-regressions",
      testDir: "./playwright/tests",
      testMatch: "audit-role-access.spec.ts",
      // The G8 journeys in the same file run in their own project below.
      grepInvert: PILOT_G8_ROLE_TAG_PATTERN,
      testIgnore: [],
      dependencies: ["setup"],
      use: roleSeatUse,
    },
    // SCRUM-760 G8 journeys. Nothing depends on this project, so a red journey
    // can never skip the route matrix or the tenant-isolation test. It has the
    // same dependency depth as role-regressions, and Playwright runs a phase to
    // completion before the next one starts, so it still finishes before the
    // matrix isolates the audited seat (scripts/pilotG8Coverage.test.ts pins
    // both facts). Its failure still fails the run, and the evidence census
    // counts its three cases.
    {
      name: PILOT_G8_ROLE_PROJECT,
      testDir: "./playwright/tests",
      testMatch: "audit-role-access.spec.ts",
      grep: PILOT_G8_ROLE_TAG_PATTERN,
      testIgnore: [],
      dependencies: ["setup"],
      use: roleSeatUse,
    },
    ...base.projects!.slice(1).filter(project => project.name !== "pilot-scripted").map((project) => ({
      ...project, dependencies: [...(project.dependencies ?? []), "role-regressions"],
      use: { ...project.use, storageState: "playwright/.auth/approver.json" },
    })),
    {
      name: "audit-controls",
      testDir: "./playwright/tests",
      testMatch: "audit-navigation-dismissal.spec.ts",
      dependencies: [],
      use: { browserName: "chromium", storageState: { cookies: [], origins: [] }, trace: "off", video: "off", screenshot: "off" },
    },
  ],
});
