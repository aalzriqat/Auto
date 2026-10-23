import { defineConfig } from "@playwright/test";
import base from "./playwright.scenarios.config";

export default defineConfig({
  ...base,
  testDir: "./playwright/role-audit",
  workers: 1,
  retries: 0,
  // HTML/JSON reporters own separate output paths and duplicate attachments.
  // Keep this audit's only reporter on the privately captured process stream.
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
      testIgnore: [],
      dependencies: ["setup"],
      use: { ...base.projects![1].use, storageState: "playwright/.auth/approver.json", trace: "off", video: "off", screenshot: "off" },
    },
    ...base.projects!.slice(1).map((project) => ({
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
