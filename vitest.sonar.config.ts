import type { ViteUserConfig } from "vitest/config";
import baseConfig from "./vitest.config";

/**
 * Coverage for SonarCloud, defined by rule instead of by list (SCRUM-185).
 *
 * SCOPE: Convex production modules AND authored release/control scripts. This
 * report is no longer "the Convex report" despite the name it grew up with —
 * `scripts/` is in it deliberately, see the include below. Tests, generated
 * bindings and everything outside those two trees stay out.
 *
 * `test:coverage:sonar` used to name nine Convex files one by one, and it runs
 * after `test:coverage` and overwrites `coverage/lcov.info` — so the report
 * uploaded to Sonar contained those nine files and nothing else. Any PR that
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
      //
      // `scripts/` is here for the same reason `convex/` is, and it was found
      // the same way. `scripts/releaseGuard.ts` reported 0.0% coverage with 195
      // uncovered lines against a full `releaseGuard.test.ts` suite, and
      // `tenantWriteGuard.ts` 0.0% against `tenantWriteGuard.test.ts` — not
      // because they are untested, but because no report Sonar reads ever
      // mentioned them. These are the release-gating and tenancy-guard modules;
      // "well tested and reported as zero" is the worst place for that to be
      // true, because it is indistinguishable from "nobody tests the gate".
      include: ["convex/**/*.ts", "scripts/**/*.{ts,mjs}"],
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
