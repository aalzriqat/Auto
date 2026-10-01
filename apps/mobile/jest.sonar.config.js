/**
 * SCRUM-293 - the mobile coverage run that feeds SonarCloud.
 *
 * This is NOT the mobile quality gate. `pnpm mobile:test` keeps its own
 * `collectCoverageFrom` allowlist and its 100% threshold, and this config
 * changes neither.
 *
 * What it fixes is a measurement gap. Sonar reads `sonar.javascript.lcov.
 * reportPaths`, which points only at the root vitest report; that report
 * excludes `apps/**` entirely, so every mobile file reads as 0% covered
 * however well it is tested. That is an instrumentation artifact, not a
 * coverage problem, and the fix is to instrument everything and keep no list.
 *
 * So: every non-test source file under `src/` (.ts/.tsx) and `app/` (.tsx, the
 * expo-router screens) is instrumented, thresholds are
 * off (the gate is `mobile:test`'s job, not Sonar's), output goes to its own
 * directory so it can never collide with `mobile:test`, and `projectRoot`
 * makes the emitted `SF:` paths repo-root relative - `apps/mobile/src/...`
 * rather than `src/...` - because the scanner resolves them from the
 * repository root and silently drops the ones it cannot find.
 */
const pkg = require("./package.json");

module.exports = {
  ...pkg.jest,
  rootDir: __dirname,
  collectCoverage: true,
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/**/*.test.{ts,tsx}",
    "app/**/*.tsx",
    "!app/**/*.test.tsx",
  ],
  coverageThreshold: undefined,
  coverageDirectory: "coverage-sonar",
  coverageReporters: [["lcovonly", { projectRoot: "../.." }], "text-summary"],
};
