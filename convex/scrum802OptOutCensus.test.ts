/**
 * SCRUM-802 (owner ruling, Option A): the pilot cash-sale containment must run for real.
 *
 * `vitest.setup.ts` no longer turns `CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED` off. A suite that only uses a cash
 * completion as a fixture (complete a cash sale, then collect or cancel it, to test something else) opts out with a
 * file-level `vi.mock` marked "SCRUM-802 legacy-cash-lifecycle opt-out". This census is the ratchet: the opt-out list
 * is exactly the one below, so a new suite cannot quietly run with the containment off, and the certification and
 * rehearsal files can never be on it. Shrinking the list (re-cutting a suite to pay by deposit) is always allowed;
 * delete the entry in the same change.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MARK = "SCRUM-802 legacy-cash-lifecycle opt-out";

const ALLOWED_OPT_OUTS: readonly string[] = [
  "components/deposits/QuoteDepositManager.test.tsx",
  "convex/accountingPhase0.test.ts",
  "convex/accountingPhase8.test.ts",
  "convex/accountingPhase9.test.ts",
  "convex/accountingReceiptMovement.test.ts",
  "convex/accountingVehicleInventory.test.ts",
  "convex/applications.test.ts",
  "convex/billOfSaleEconomics.test.ts",
  "convex/cashApplicationFinancierLeg.test.ts",
  "convex/chequeCancelledSaleCredit.test.ts",
  "convex/commissionAccrualTiming.test.ts",
  "convex/commissionMarginBase.test.ts",
  "convex/commitmentFinalization.test.ts",
  "convex/commitmentRestorationSpine.test.ts",
  "convex/consignedDepositResolution.test.ts",
  "convex/consignedReporting.test.ts",
  "convex/consignedSettlementRoute.test.ts",
  "convex/consignmentEconomics.test.ts",
  "convex/depositCancellationPending.test.ts",
  "convex/depositRevenueRecognition.test.ts",
  "convex/deposits.test.ts",
  "convex/financeLifecyclePhase1.test.ts",
  "convex/financeLifecyclePhase3.test.ts",
  "convex/financeLifecyclePhase4.test.ts",
  "convex/financedConsignedSettlement.test.ts",
  "convex/financierLegNotApplicable.test.ts",
  "convex/migrateConsignedSaleBasis.test.ts",
  "convex/multiVehicleDepositAllocation.test.ts",
  "convex/profitApprovalEnforcement.test.ts",
  "convex/retiredDealModes.test.ts",
  "convex/saleCancellationOutcomeMatrix.test.ts",
  "convex/saleCompletionTenancyGuards.test.ts",
  "convex/saleOwnedTeardown.test.ts",
  "convex/sales.test.ts",
  "convex/salesCommissionEntry.test.ts",
  "convex/scrum230MonthlyCronIsolation.test.ts",
  "convex/scrum411P202ForwardedDeposit.test.ts",
  "convex/scrum415FinancedDoor.test.ts",
  "convex/scrum571s1Containment.test.ts",
  "convex/scrum571s2CashSettlement.test.ts",
  "convex/scrum641DeletedVehicleDoors.test.ts",
  "convex/scrum693VehicleNotReadyForSale.test.ts",
  "convex/scrum69FinanceDoor.test.ts",
  "convex/supplierPayableSettlement.test.ts",
  "convex/supplierPayablesReconciliation.scrum651.test.ts",
  "convex/supplierReceivables.test.ts",
];

const MUST_RUN_WITH_REAL_SWITCH = [
  "convex/scrum486Certification.test.ts",
  "convex/accountingReleaseRehearsal.test.ts",
  "convex/scrum802CashSaleContainment.test.ts",
  // Bound to the regression scenario cash-taxed-owned-sale-gl-subledger-invoice-agree.
  "convex/ownedSaleTaxEndToEnd.test.ts",
] as const;

// Mirrors vitest.config.ts: include **/*.test.ts(x) from the repository root, exclude these directories.
const EXCLUDED_DIRS = new Set(["node_modules", ".next", "out", "build", "apps", "packages"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(name) || name.startsWith(".")) continue;
    const path = dir === "." ? name : join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

// Anything that turns the switch off or replaces the gate module, however it is spelled.
const SWITCH_OFF = /CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED\s*:\s*false|vi\.(?:mock|doMock)\(\s*["'][^"']*(?:saleDebtContainment|cashSalePilotGate)["']/;

describe("SCRUM-802 opt-out census", () => {
  const SELF = "convex/scrum802OptOutCensus.test.ts";
  const all = testFiles(".").filter((path) => path !== SELF);
  const optedOut = all.filter((path) => readFileSync(path, "utf8").includes(MARK)).sort();

  test("the scan covers every test directory vitest runs (convex, components, lib, scripts, test-utils and the rest)", () => {
    expect(all).toContain("convex/sales.test.ts");
    expect(all).toContain("components/deposits/QuoteDepositManager.test.tsx");
    expect(all.some((path) => path.startsWith("scripts/"))).toBe(true);
    expect(all.some((path) => path.startsWith("lib/"))).toBe(true);
  });

  test("no test file turns the switch off or mocks the gate modules without carrying the opt-out marker", () => {
    // "importOriginal()" pass-through mocks are harmless no-ops but are still flagged: there is nothing to opt back in to.
    const unmarked = all.filter((path) => {
      const src = readFileSync(path, "utf8");
      return SWITCH_OFF.test(src) && !src.includes(MARK);
    });
    expect(unmarked).toEqual([]);
  });

  test("exactly the listed suites run with the containment off", () => {
    expect(optedOut).toEqual([...ALLOWED_OPT_OUTS].sort());
  });

  test("certification and rehearsal files run with the real switch", () => {
    for (const path of MUST_RUN_WITH_REAL_SWITCH) {
      expect(all).toContain(path); // a renamed or deleted certification file must fail here, not silently drop out
      expect(optedOut).not.toContain(path);
      const src = readFileSync(path, "utf8");
      expect(SWITCH_OFF.test(src)).toBe(false);
      expect(src).not.toContain(MARK);
    }
    expect(readFileSync("vitest.setup.ts", "utf8")).not.toContain("CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED");
  });
});
