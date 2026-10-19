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
  "convex/scrum761CashReceiptDoors.test.ts",
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

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("SCRUM-802 opt-out census", () => {
  const optedOut = ["convex", "components", "lib", "scripts", "test-utils"]
    .flatMap((dir) => testFiles(dir))
    .filter((path) => path !== "convex/scrum802OptOutCensus.test.ts" && readFileSync(path, "utf8").includes(MARK))
    .sort();

  test("exactly the listed suites run with the containment off", () => {
    expect(optedOut).toEqual([...ALLOWED_OPT_OUTS].sort());
  });

  test("certification and rehearsal files run with the real switch", () => {
    for (const path of MUST_RUN_WITH_REAL_SWITCH) {
      expect(optedOut).not.toContain(path);
      expect(readFileSync(path, "utf8")).not.toContain("CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: false");
    }
    expect(readFileSync("vitest.setup.ts", "utf8")).not.toContain("CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED");
  });
});
