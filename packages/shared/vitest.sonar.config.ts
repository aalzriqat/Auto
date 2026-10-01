import { defineConfig } from "vitest/config";

/**
 * SCRUM-552 - the shared-package coverage run that feeds SonarCloud.
 *
 * Not a quality gate: `pnpm shared:test` is unchanged and no threshold is set
 * here (the Sonar gate owns thresholds). Root vitest coverage excludes
 * `packages/**`, so without this run every packages/shared line reads 0%.
 * `projectRoot` makes the emitted `SF:` paths repo-root relative
 * (`packages/shared/src/...`), which is what the scanner resolves.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reportsDirectory: "coverage-sonar",
      reporter: [["lcovonly", { projectRoot: "../.." }]],
    },
  },
});
