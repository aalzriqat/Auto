import type { ViteUserConfig } from "vitest/config";
import baseConfig from "./vitest.config";

/**
 * Coverage for SonarCloud, defined by rule instead of by list (SCRUM-185).
 *
 * `test:coverage:sonar` used to name eight Convex files one by one, and it runs
 * after `test:coverage` and overwrites `coverage/lcov.info` — so the report
 * uploaded to Sonar contained those eight files and nothing else. Any PR that
 * touched a Convex module outside the list had its new lines reported as 0%
 * covered no matter how well tested they were, because the file had no entry in
 * the report at all.
 *
 * That failed the required `SonarCloud Code Analysis` gate on three of three
 * refreshed Accounting PRs — `claims.ts` (measured 100% line coverage),
 * `postingRules.ts` and `saleCompletion.ts` (~89%), and `financialAudit.ts`
 * (eight contract controls) — and the workaround, each PR appending its own
 * filenames, turned one line of `package.json` into a conflict hotspot that
 * three branches were editing at once.
 *
 * So the include is a rule now: every production module under `convex/`. A
 * changed file appears because it is production code, not because somebody
 * remembered to add it.
 *
 * Two deliberate choices:
 *
 *  - **A separate report directory.** This writes to `coverage-sonar/` rather
 *    than `coverage/`, so it no longer destroys the ordinary repository
 *    coverage artifact that `test:coverage` produced moments earlier. Sonar is
 *    pointed at both reports, so it sees the repo-wide set AND the full Convex
 *    set instead of only whichever ran last.
 *
 *  - **Thresholds stay at zero here, and only here.** This run exists to
 *    produce a report, not to police a number; the Quality Gate is what judges
 *    coverage, and it is untouched. `test:coverage` keeps the real thresholds
 *    from `vitest.config.ts`.
 *
 * Untested production code still reports as uncovered — that is the point. This
 * changes what Sonar can SEE, never what it demands.
 */
const base = baseConfig as ViteUserConfig;

const sonarConfig: ViteUserConfig = {
  ...base,
  test: {
    ...base.test,
    coverage: {
      provider: "v8",
      // The rule. Everything else in this file exists to keep it honest.
      include: ["convex/**/*.ts"],
      exclude: [
        // Generated bindings are not authored code and nobody can test them.
        "convex/_generated/**",
        // Tests are the instrument, not the subject.
        "**/*.test.ts",
        "**/*.test.tsx",
      ],
      reportsDirectory: "coverage-sonar",
      reporter: ["text-summary", "lcov"],
      // See the note above: reporting run, not a gate.
      thresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    },
  },
};

export default sonarConfig;
