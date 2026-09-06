/**
 * SCRUM-57 — the coverage run that feeds SonarCloud.
 *
 * This is NOT the mobile quality gate. `pnpm mobile:test` keeps its own
 * `collectCoverageFrom` allowlist and its 100% threshold, and this config
 * changes neither.
 *
 * What it fixes is a measurement gap. Sonar reads `sonar.javascript.lcov.
 * reportPaths`, and until now that pointed only at the root vitest report,
 * which excludes `apps/**` entirely. Mobile coverage therefore never reached
 * Sonar at all: files with real, passing tests were still reported as 0%
 * covered, exactly the way SCRUM-208 found `scripts/**` reporting 182 of 182
 * new lines uncovered while its own suite measured 92%. That is an
 * instrumentation artifact, not a coverage problem, and the fix there was the
 * same as the fix here — instrument everything and stop maintaining a list.
 *
 * So: every non-test source file under `src/` is instrumented, thresholds are
 * off (the gate is `mobile:test`'s job, not Sonar's), and `projectRoot` makes
 * the emitted `SF:` paths repo-root relative — `apps/mobile/src/...` rather than
 * `src/...` — because the scanner resolves them from the repository root and
 * silently drops the ones it cannot find.
 */
const pkg = require("./package.json");

module.exports = {
  ...pkg.jest,
  rootDir: __dirname,
  collectCoverage: true,
  collectCoverageFrom: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
  coverageThreshold: undefined,
  coverageDirectory: "coverage",
  coverageReporters: [["lcovonly", { projectRoot: "../.." }], "text-summary"],
};
