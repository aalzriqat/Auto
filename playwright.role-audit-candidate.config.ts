import { defineConfig } from "@playwright/test";
import roleAudit from "./playwright.role-audit.config";

// The protected worker authenticates on trusted main before bringing up the
// isolated candidate. Keep the relative order of all non-auth audit projects.
export default defineConfig({
  ...roleAudit,
  webServer: undefined,
  projects: roleAudit.projects?.filter(project => project.name !== "setup").map(project => ({
    ...project,
    dependencies: project.dependencies?.filter(dependency => dependency !== "setup"),
  })),
});
