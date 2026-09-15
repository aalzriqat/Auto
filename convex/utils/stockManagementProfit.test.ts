import { describe, expect, test } from "vitest";
import { deriveManagementProfit, deriveStockManagementProfit } from "./financingEconomics";

/**
 * The two management-profit derivations, side by side: consignment (SOURCED)
 * subtracts what the supplier settles at; STOCK subtracts the vehicle's
 * capitalized cost. Neither is ever derived through the other's operand.
 */
describe("management profit by ownership", () => {
  const common = {
    approvedDealerPurchaseAmountMinor: 12_500_000,
    dealerContributionMinor: 500_000,
    customerDirectToDealerMinor: 300_000,
    actualExpensesMinor: 90_000,
    currency: "JOD",
    fullySettled: false,
  };

  test("SOURCED: approved + customer direct − supplier settlement − contribution − expenses", () => {
    const p = deriveManagementProfit({ ...common, supplierSettlementMinor: 9_500_000 });
    expect(p.available).toBe(true);
    if (!p.available) return;
    expect(p.amountMinor).toBe(12_500_000 + 300_000 - 9_500_000 - 500_000 - 90_000);
    expect(p.lines.map((l) => l.key)).toContain("SUPPLIER_SETTLEMENT");
    expect(p.lines.map((l) => l.key)).not.toContain("VEHICLE_COST");
  });

  test("STOCK: approved + customer direct − vehicle cost basis − contribution − expenses", () => {
    const p = deriveStockManagementProfit({ ...common, vehicleCostMinor: 9_700_000 });
    expect(p.available).toBe(true);
    if (!p.available) return;
    expect(p.amountMinor).toBe(12_500_000 + 300_000 - 9_700_000 - 500_000 - 90_000);
    expect(p.lines).toEqual([
      { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500_000 },
      { key: "CUSTOMER_DIRECT_TO_DEALER", sign: 1, amountMinor: 300_000 },
      { key: "VEHICLE_COST", sign: -1, amountMinor: 9_700_000 },
      { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 500_000 },
      { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90_000 },
    ]);
    expect(p.basis).toBe("MANAGEMENT_ESTIMATE");
    expect(p.postable).toBe(false);
    expect(p.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });

  test("STOCK never goes through a supplier settlement — no cost basis is NoVehicleCost, not NoSupplierSettlement", () => {
    expect(deriveStockManagementProfit({ ...common, vehicleCostMinor: undefined })).toEqual({
      available: false,
      reason: "NoVehicleCost",
    });
  });

  test("STOCK still needs the approved amount and the contribution, and refuses corrupt input and a cancelled deal", () => {
    expect(
      deriveStockManagementProfit({ ...common, approvedDealerPurchaseAmountMinor: undefined, vehicleCostMinor: 1 })
    ).toEqual({ available: false, reason: "NoApprovedPurchaseAmount" });
    expect(
      deriveStockManagementProfit({ ...common, dealerContributionMinor: undefined, vehicleCostMinor: 1 })
    ).toEqual({ available: false, reason: "NoDealerContribution" });
    expect(deriveStockManagementProfit({ ...common, vehicleCostMinor: -1 })).toEqual({
      available: false,
      reason: "CorruptInput",
    });
    expect(deriveStockManagementProfit({ ...common, vehicleCostMinor: 1, dealCancelled: true })).toEqual({
      available: false,
      reason: "DealCancelled",
    });
  });

  test("STOCK reads ACTUAL_UNPOSTABLE once settled, and is still not postable", () => {
    const p = deriveStockManagementProfit({ ...common, vehicleCostMinor: 9_700_000, fullySettled: true });
    if (!p.available) throw new Error("expected available");
    expect(p.classification).toBe("ACTUAL_UNPOSTABLE");
    expect(p.postable).toBe(false);
  });
});
