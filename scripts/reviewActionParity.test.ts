import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { salesAr, salesEn } from "../lib/i18n/domains/sales";

/**
 * Review → Unified Deal action parity, proven at the file level.
 *
 * SCRUM-215 / SCRUM-313 owner ruling: the Finance Applications → Review dialog
 * is transitional and is removed only once every backend command it calls is
 * also called from the Deal screen — on the SAME mutation, never a second one.
 * These tests are the mechanical half of that proof:
 *
 *  1. every `api.<module>.<fn>` the Review dialog wires through `useMutation`
 *     is wired by the Deal cockpit (container or a cockpit sub-component);
 *  2. no `unifiedDeal`/`dealWorkspace` MUTATION exists — the cockpit consumes
 *     the `dealWorkspace` read model and calls the same public commands;
 *  3. no cockpit copy tells the operator to go to Review for an action the
 *     Deal now performs.
 *
 * They read the real source, so a caller added to Review and not to the Deal
 * fails CI, and so does a `*V2` command that would be a second economic path.
 */
const ROOT = join(__dirname, "..");
const REVIEW_DIALOG = "components/applications/ApplicationDetailsDialog.tsx";
const COCKPIT_DIR = "components/applications/cockpit";

const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

/** Every `api.<module>.<fn>` passed to `useMutation(...)` in one file. */
function wiredMutations(source: string): Set<string> {
  const out = new Set<string>();
  for (const match of source.matchAll(/useMutation\(\s*api\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)) {
    out.add(`${match[1]}.${match[2]}`);
  }
  return out;
}

function cockpitSources(): string {
  return readdirSync(join(ROOT, COCKPIT_DIR))
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .map((file) => read(join(COCKPIT_DIR, file)))
    .join("\n");
}

/**
 * The commands the Review dialog wired at `b5baaa213` — frozen as DATA so the
 * proof outlives the file. Deriving the expected set from the Review source
 * would let deleting Review make this test error (or, worse, pass on an empty
 * set); a literal cannot shrink because its source went away.
 */
const REQUIRED_DEAL_COMMANDS = [
  "applications.updateStatus",
  "applications.cancelApplication",
  "applications.finalizeDeal",
  "applications.confirmDisbursement",
  "applications.confirmSupplierDisbursement",
  "applications.setSupplierSettlementRoute",
  "applications.registerVehicleHandover",
  "applications.registerExpectedPayment",
  "deposits.release",
  "documents.updateDocumentStatus",
  "documents.generateUploadUrl",
  "documents.saveDocumentFile",
] as const;

describe("every command Review used to wire has a Deal caller on the same command", () => {
  test("the frozen list is the full set, not a sample", () => {
    expect(REQUIRED_DEAL_COMMANDS).toHaveLength(12);
    expect(new Set(REQUIRED_DEAL_COMMANDS).size).toBe(12);
  });

  test("the Deal wires every command on the frozen list", () => {
    const deal = wiredMutations(cockpitSources());
    const missing = REQUIRED_DEAL_COMMANDS.filter((name) => !deal.has(name));
    expect(missing).toEqual([]);
  });

  test("NEGATIVE CONTROL — removing a required Deal caller fails the ratchet", () => {
    // The same enumeration over the cockpit sources with ONE required caller
    // struck out: the check above must go red on exactly that command, so a
    // future deletion cannot pass by making the source smaller.
    const struck = cockpitSources().replace(/useMutation\(\s*api\.deposits\.release\)/, "/* removed */");
    const deal = wiredMutations(struck);
    const missing = REQUIRED_DEAL_COMMANDS.filter((name) => !deal.has(name));
    expect(missing).toEqual(["deposits.release"]);
  });

  test("while the Review dialog still exists it wires nothing beyond the frozen list", () => {
    // Deleted at retirement — the list above is then the whole contract.
    if (!existsSync(join(ROOT, REVIEW_DIALOG))) return;
    const extra = [...wiredMutations(read(REVIEW_DIALOG))].filter(
      (name) => !(REQUIRED_DEAL_COMMANDS as ReadonlyArray<string>).includes(name)
    );
    expect(extra).toEqual([]);
  });

  test("the enumerator sees a caller written on one line and across lines", () => {
    expect(
      wiredMutations(`const a = useMutation(api.applications.finalizeDeal);
const b = useMutation(
  api.financingEconomics.approveDealerPurchaseAmount
);`)
    ).toEqual(new Set(["applications.finalizeDeal", "financingEconomics.approveDealerPurchaseAmount"]));
  });
});

describe("one deal, one backend command", () => {
  test("no client calls a duplicated deal mutation namespace", () => {
    // `dealWorkspace` is a READ model; a mutation there, or any `*V2` command,
    // would be the second economic path the architecture rule forbids.
    const everything =
      cockpitSources() + (existsSync(join(ROOT, REVIEW_DIALOG)) ? read(REVIEW_DIALOG) : "");
    expect(everything.match(/useMutation\(\s*api\.(unifiedDeal|dealWorkspace)\./g) ?? []).toEqual([]);
    expect(everything.match(/useMutation\(\s*api\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+V2\b/g) ?? []).toEqual([]);
  });
});

describe("no copy sends the operator to Review for an action the Deal performs", () => {
  /**
   * Keys whose action now lives on the Deal screen. `GapResolutionUnavailable`
   * is deliberately NOT here: nothing in AutoFlow records a gap resolution yet
   * (SCRUM-83), so there is no Deal action to point at instead, and the
   * pointer is retired only when Review is.
   */
  const MIGRATED = ["FinalizeNeedsSettlementRoute", "FinalizeNeedsRouteAndPermission"] as const;
  const REVIEW_POINTER = [/Finance Applications\s*→\s*Review/i, /طلبات التمويل\s*←\s*مراجعة/];

  test.each(MIGRATED)("%s does not point at Review, in either language", (key) => {
    for (const dict of [salesEn, salesAr]) {
      const value = (dict as Record<string, string>)[key];
      expect(typeof value).toBe("string");
      expect(REVIEW_POINTER.some((r) => r.test(value))).toBe(false);
    }
  });

  test("the pointer detector is not vacuous", () => {
    expect(REVIEW_POINTER.some((r) => r.test("It is chosen in Finance Applications → Review."))).toBe(true);
    expect(REVIEW_POINTER.some((r) => r.test("يُختار ذلك من طلبات التمويل ← مراجعة."))).toBe(true);
  });
});
