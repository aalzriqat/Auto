const baseConfig = require("./package.json").jest;

/**
 * Mobile coverage for SonarCloud, defined by rule instead of by list (SCRUM-185).
 *
 * This is a SECOND, separate run. It does not replace `pnpm test` / `pnpm
 * test:coverage`, and it deliberately does not touch their configuration.
 *
 * Why a second run rather than widening the first:
 *
 * The existing run enforces a 100% global `coverageThreshold` over the curated
 * `collectCoverageFrom` set in package.json. That pairing is the point — a
 * hand-picked set of critical surfaces, held to 100%. Widening that set to cover
 * every production file would fail instantly, and the only way to keep it green
 * would be to lower the 100% bar. That trades a real gate for a reporting
 * convenience, so it is not done here. The strict run keeps its curated set and
 * its 100%; this run measures everything and enforces nothing.
 *
 * What this run is for:
 *
 * Sonar counts `apps/mobile/**` production files as new code — `sonar.coverage.
 * exclusions` excludes `app/**` (the Next.js directory) but not `apps/**` (this
 * React Native app; the two names differ by one character and mean different
 * trees). But no LCOV ever reached Sonar for them: the strict run's report is
 * confined to its curated set and was never listed in
 * `sonar.javascript.lcov.reportPaths` at all. So every mobile production file
 * outside the curated set sat in Sonar's denominator with nothing in the
 * numerator, and any PR touching one inherited 0% coverage on new code however
 * well tested it was. PR #239 is the one that hit it.
 *
 * Enforcement moves to Sonar's required >= 80% coverage-on-new-code condition,
 * which now sees the full mobile production surface. Uncovered production code
 * reports as uncovered — that is the point of measuring it.
 */
const sonarConfig = {
  ...baseConfig,
  collectCoverageFrom: [
    // The rule: every production module in the app, both routing and source.
    "app/**/*.{ts,tsx}",
    "src/**/*.{ts,tsx}",
    // Tests are the instrument, not the subject.
    "!**/*.test.{ts,tsx}",
    // Ambient declarations contain no executable statements.
    "!**/*.d.ts",
  ],
  coverageDirectory: "coverage-sonar",
  coverageReporters: ["lcov", "text-summary"],
  // See the note above: this run reports, the strict run gates.
  coverageThreshold: undefined,
};

module.exports = sonarConfig;
