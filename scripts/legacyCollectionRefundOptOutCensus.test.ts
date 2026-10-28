/**
 * SCRUM-760 ruling 11: census of suites that run with the legacy collection REFUND block OFF
 * (convex/utils/legacyCollectionRefundContainment.ts).
 *
 * A suite opts out only because it uses an approved collection refund (or an internal refund door:
 * a COLLECTION_REFUND posting, a customer OUT payment, an allocation reversal) as a FIXTURE, or tests
 * the refund behaviour that returns when the door is activated. The list is exact: a new suite cannot
 * quietly run with the block off, and the containment suites (listed below, which own the only live
 * handles on the switch), the certification and the rehearsal files can never be on it. Shrinking the
 * list (re-cutting a suite to stop using the refund) is always allowed; delete the entry in the same
 * change.
 *
 * What it catches (all of it fails the census, none of it is silently skipped):
 *   - a literal-specifier `vi.mock` / `vi.doMock` of the module (also the `import("...")` form),
 *   - the switch's name used as an object key with a value other than `true` (test files only,
 *     because the name is also a legitimate key in the refusal maps),
 *   - a `vi.spyOn(..., "<guard name>")` replacement of the switch or either guard function,
 *   - a `vi.mock` / `vi.doMock` whose specifier is computed (not a plain string literal): such a
 *     call could target this module, so a file carrying one must be named in COMPUTED_SPECIFIER_FILES
 *     with its reason,
 *   - the same mock/spy patterns in NON-test source files (a vitest setup file, a shared helper),
 *     and any file other than the opt-outs that imports the switch helper.
 *
 * Scan coverage: every `.ts/.tsx/.mts/.cts/.js/.mjs/.cjs` file from the repository root, `apps` and
 * `packages` included. Excluded: `node_modules`, `.next`, `out`, `build` and every dot-directory
 * (`.git`, `.claude/worktrees` nested checkouts, caches). Vitest collects tests only from the
 * non-dot tree, and `git ls-files` has no test file under a dot-directory, so nothing the suite runs
 * is outside the scan. Test-collection scope is vitest.config.ts; if that ever includes a dot-directory
 * or a generated directory this exclusion must be revisited.
 *
 * Limits, stated plainly: this is a TEXT detector, not a proof. It does not catch a switch turned off
 * by indirection that never writes the module path or a guard name as a literal (for example a
 * mock built from a string assembled at runtime inside a helper that is itself a computed-specifier
 * file on the allowlist), `vi.stubGlobal`-style tricks, or a mock of a module that re-exports this
 * one. The shipped state is also pinned by executing the real module unmocked in
 * convex/legacyCollectionRefundContainment.test.ts, and CI runs the certification and rehearsal
 * suites with the real switch (MUST_RUN_WITH_REAL_SWITCH), so those two backstops do not depend on
 * this detector.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MARK = "SCRUM-760 ruling 11 legacy-collection-refund opt-out";
const HELPER = "test-utils/legacyCollectionRefundSwitches.ts";
const THIS_FILE = "scripts/legacyCollectionRefundOptOutCensus.test.ts";
// The two suites that own a live handle on the switch (backend cells and the Collections screen).
const CONTAINMENT_SUITES: readonly string[] = [
  "convex/legacyCollectionRefundContainment.test.ts",
  "components/accounting/CollectionsTabLegacyRefund.test.tsx",
];

const ALLOWED_OPT_OUTS: readonly string[] = [
  "convex/accountingGenericReversalAuthority.test.ts",
  "convex/accountingPhase0.test.ts",
  "convex/accountingPhase3.test.ts",
  "convex/accountingPhase5.test.ts",
  "convex/accountingReservedOccurrenceIngress.test.ts",
  "convex/chequeReturnLifecycle.test.ts",
  "convex/collections.test.ts",
  "convex/collectionsIndexReads.test.ts",
  "convex/scrum121Characterization.test.ts",
  "convex/scrum571s1Containment.test.ts",
  "convex/subledger.test.ts",
];

// Files whose `vi.mock` specifier is computed, with the reason each is not an opt-out.
const COMPUTED_SPECIFIER_FILES: Readonly<Record<string, string>> = {
  "convex/scrum802OptOutCensus.test.ts":
    "builds mock source text as template strings to test its own detector; it mocks nothing at run time",
};

const MUST_RUN_WITH_REAL_SWITCH = [
  "convex/scrum486Certification.test.ts",
  "convex/accountingReleaseRehearsal.test.ts",
  "convex/openingAllocatedReceivables.test.ts",
] as const;

const EXCLUDED_DIRS = new Set(["node_modules", ".next", "out", "build"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(name) || name.startsWith(".")) continue;
    const path = dir === "." ? name : join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.[cm]?[jt]sx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path.replace(/\\/g, "/"));
  }
  return out;
}

const isTestFile = (f: string): boolean => /\.test\.tsx?$/.test(f);

const MOCKS_MODULE = /vi\.(?:mock|doMock)\s*\(\s*(?:import\s*\(\s*)?["'`][^"'`]*legacyCollectionRefundContainment/;
const SETS_SWITCH_NOT_TRUE = /LEGACY_COLLECTION_REFUND_PILOT_DISABLED\s*:\s*(?!\s|true\b)/;
// vi.spyOn(<anything>, "<guard or switch name>"): replaces the real function or constant on its module object.
const SPIES_GUARD =
  /vi\.spyOn\s*\([^)]*?["'`](?:assertLegacyCollectionRefundAllowed|isLegacyCollectionRefundDisabled|LEGACY_COLLECTION_REFUND_PILOT_DISABLED)["'`]/;
// vi.mock / vi.doMock whose first argument is not a string literal or import("literal"), or is a template with a substitution.
const COMPUTED_SPECIFIER = /vi\.(?:mock|doMock)\s*\(\s*(?!["'`]|import\s*\(\s*["'`])|vi\.(?:mock|doMock)\s*\(\s*`[^`]*\$\{/;

function replacesGuard(src: string): boolean {
  return MOCKS_MODULE.test(src) || SPIES_GUARD.test(src);
}
function turnsSwitchOff(src: string): boolean {
  return replacesGuard(src) || SETS_SWITCH_NOT_TRUE.test(src);
}

describe("legacy collection refund opt-out census", () => {
  const all = sourceFiles(".");
  const tests = all.filter(isTestFile);
  const others = all.filter((f) => !isTestFile(f));
  const src = (f: string): string => readFileSync(f, "utf8");

  test("the scan really covers the tree it claims to (apps and packages included, a sentinel per root)", () => {
    for (const root of ["convex/", "components/", "scripts/", "test-utils/", "app/", "apps/", "packages/"]) {
      expect(all.some((f) => f.startsWith(root)), root).toBe(true);
    }
    expect(all.some((f) => f.split("/").some((part) => part.startsWith(".") || EXCLUDED_DIRS.has(part)))).toBe(false);
    expect(tests.length).toBeGreaterThan(500);
  });

  test("exactly the listed suites turn the block off (the containment suites aside)", () => {
    const offenders = tests
      .filter((f) => !CONTAINMENT_SUITES.includes(f) && f !== THIS_FILE)
      .filter((f) => turnsSwitchOff(src(f)))
      .sort();
    expect(offenders).toEqual([...ALLOWED_OPT_OUTS].sort());
  });

  test("no non-test source file (a setup file, a shared helper) replaces the guard", () => {
    const offenders = others.filter((f) => f !== HELPER && replacesGuard(src(f)));
    expect(offenders).toEqual([]);
  });

  test("only the opt-outs and the containment suites import the switch helper", () => {
    const users = all
      .filter((f) => f !== HELPER && f !== THIS_FILE)
      .filter((f) => /legacyCollectionRefundSwitches/.test(src(f)))
      .sort();
    expect(users).toEqual([...ALLOWED_OPT_OUTS, ...CONTAINMENT_SUITES].sort());
  });

  test("a vi.mock with a computed specifier exists only in the named files", () => {
    const computed = all.filter((f) => f !== THIS_FILE && COMPUTED_SPECIFIER.test(src(f))).sort();
    expect(computed).toEqual(Object.keys(COMPUTED_SPECIFIER_FILES).sort());
  });

  test("every opt-out uses the greppable helper and states its reason", () => {
    for (const f of ALLOWED_OPT_OUTS) {
      const text = src(f);
      expect(text, f).toContain("openLegacyCollectionRefund");
      expect(text, f).toContain(MARK);
    }
  });

  test("the suites that prove the shipped behaviour never turn the block off", () => {
    for (const f of MUST_RUN_WITH_REAL_SWITCH) {
      expect(turnsSwitchOff(src(f)), f).toBe(false);
    }
  });

  test("the detector sees the spellings it claims to", () => {
    expect(turnsSwitchOff('vi.mock("./utils/legacyCollectionRefundContainment", () => ({}))')).toBe(true);
    expect(turnsSwitchOff("vi.doMock(`../convex/utils/legacyCollectionRefundContainment`)")).toBe(true);
    expect(turnsSwitchOff('vi.mock(import("./utils/legacyCollectionRefundContainment"), () => ({}))')).toBe(true);
    expect(turnsSwitchOff("{ LEGACY_COLLECTION_REFUND_PILOT_DISABLED: false }")).toBe(true);
    expect(turnsSwitchOff("{ LEGACY_COLLECTION_REFUND_PILOT_DISABLED: true }")).toBe(false);
    expect(turnsSwitchOff("assertLegacyCollectionRefundAllowed()")).toBe(false);
    // The two spellings the earlier version missed.
    expect(turnsSwitchOff('vi.spyOn(containment, "assertLegacyCollectionRefundAllowed").mockImplementation(() => {})')).toBe(true);
    expect(turnsSwitchOff('vi.spyOn(\n  containment,\n  "isLegacyCollectionRefundDisabled",\n)')).toBe(true);
    expect(turnsSwitchOff('vi.spyOn(process, "exit")')).toBe(false);
    expect(COMPUTED_SPECIFIER.test("vi.mock(MODULE_PATH, () => ({}))")).toBe(true);
    expect(COMPUTED_SPECIFIER.test("vi.mock(`./utils/${name}`, () => ({}))")).toBe(true);
    expect(COMPUTED_SPECIFIER.test('vi.mock("./utils/legacyCollectionRefundContainment", () => ({}))')).toBe(false);
    expect(COMPUTED_SPECIFIER.test('vi.mock(import("./utils/other"), () => ({}))')).toBe(false);
  });
});
