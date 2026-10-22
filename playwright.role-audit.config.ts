import { defineConfig } from "@playwright/test";
import base from "./playwright.scenarios.config";

export default defineConfig({
  ...base,
  testDir: "./playwright/role-audit",
  workers: 1,
  retries: 0,
  projects: [
    { ...base.projects![0], testDir: "./playwright/tests" },
    ...base.projects!.slice(1).map((project) => ({
      ...project, use: { ...project.use, storageState: "playwright/.auth/approver.json" },
    })),
  ],
});
