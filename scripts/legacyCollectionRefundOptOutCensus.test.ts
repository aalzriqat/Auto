/**
 * SCRUM-760 ruling 11: census of suites that run with the legacy collection REFUND block OFF
 * (convex/utils/legacyCollectionRefundContainment.ts).
 *
 * A suite opts out only because it uses an approved collection refund as a FIXTURE, or tests the
 * refund behaviour that returns when the door is activated. The list is exact: a new suite cannot
 * quietly run with the block off, and the containment suites (listed below, which own the only live handles on the switch), the certification and the rehearsal files can never
 * be on it. Shrinking the list (re-cutting a suite to stop using the refund) is always allowed; delete
 * the entry in the same change.
 *
 * Limits, stated plainly: this is a TEXT detector. It flags a literal-specifier `vi.mock` / `vi.doMock`
 * of the module or the switch's name used as an object key with a value other than `true`. Computed
 * specifiers and mocks hidden in helper files are a known gap.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MARK = "SCRUM-760 ruling 11 legacy-collection-refund opt-out";
// The two suites that own a live handle on the switch (backend cells and the Collections screen).
const CONTAINMENT_SUITES: readonly string[] = [
  "convex/legacyCollectionRefundContainment.test.ts",
  "components/accounting/CollectionsTabLegacyRefund.test.tsx",
];

const ALLOWED_OPT_OUTS: readonly string[] = [
  "convex/accountingPhase0.test.ts",
  "convex/chequeReturnLifecycle.test.ts",
  "convex/collections.test.ts",
  "convex/collectionsIndexReads.test.ts",
  "convex/scrum121Characterization.test.ts",
  "convex/scrum571s1Containment.test.ts",
];

const MUST_RUN_WITH_REAL_SWITCH = [
  "convex/scrum486Certification.test.ts",
  "convex/accountingReleaseRehearsal.test.ts",
  "convex/openingAllocatedReceivables.test.ts",
] as const;

const EXCLUDED_DIRS = new Set(["node_modules", ".next", "out", "build", "apps", "packages"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(name) || name.startsWith(".")) continue;
    const path = dir === "." ? name : join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(path.replace(/\\/g, "/"));
  }
  return out;
}

const MOCKS_MODULE = /vi\.(?:mock|doMock)\s*\(\s*(?:import\s*\(\s*)?["'`][^"'`]*legacyCollectionRefundContainment/;
const SETS_SWITCH_NOT_TRUE = /LEGACY_COLLECTION_REFUND_PILOT_DISABLED\s*:\s*(?!\s|true\b)/;

function turnsSwitchOff(src: string): boolean {
  return MOCKS_MODULE.test(src) || SETS_SWITCH_NOT_TRUE.test(src);
}

describe("legacy collection refund opt-out census", () => {
  const all = testFiles(".");

  test("exactly the listed suites turn the block off (the containment suite aside)", () => {
    const offenders = all
      .filter((f) => !CONTAINMENT_SUITES.includes(f) && f !== "scripts/legacyCollectionRefundOptOutCensus.test.ts")
      .filter((f) => turnsSwitchOff(readFileSync(f, "utf8")))
      .sort();
    expect(offenders).toEqual([...ALLOWED_OPT_OUTS].sort());
  });

  test("every opt-out uses the greppable helper and states its reason", () => {
    for (const f of ALLOWED_OPT_OUTS) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("openLegacyCollectionRefund");
      expect(src, f).toContain(MARK);
    }
  });

  test("the suites that prove the shipped behaviour never turn the block off", () => {
    for (const f of MUST_RUN_WITH_REAL_SWITCH) {
      expect(turnsSwitchOff(readFileSync(f, "utf8")), f).toBe(false);
    }
  });

  test("the detector sees the spellings it claims to", () => {
    expect(turnsSwitchOff('vi.mock("./utils/legacyCollectionRefundContainment", () => ({}))')).toBe(true);
    expect(turnsSwitchOff("vi.doMock(`../convex/utils/legacyCollectionRefundContainment`)")).toBe(true);
    expect(turnsSwitchOff("{ LEGACY_COLLECTION_REFUND_PILOT_DISABLED: false }")).toBe(true);
    expect(turnsSwitchOff("{ LEGACY_COLLECTION_REFUND_PILOT_DISABLED: true }")).toBe(false);
    expect(turnsSwitchOff("assertLegacyCollectionRefundAllowed()")).toBe(false);
  });
});
