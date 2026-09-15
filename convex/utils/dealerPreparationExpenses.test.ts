import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import {
  deriveDealerPreparationExpenses,
  deriveVehicleCostBasis,
  MAX_COST_BASIS_EXPENSES,
} from "./vehicleCostBasis";
import { withPreparationExpenses, type ManagementProfit } from "./financingEconomics";

/**
 * The dealership's preparation spend on a CONSIGNED car: which rows are
 * evidence, which are refused, and that it is subtracted from the consignment
 * profit exactly once without touching the supplier's entitlement.
 */
const CUTOFF = Date.UTC(2026, 5, 15);
const BEFORE = Date.UTC(2026, 5, 1);

let seq = 0;
function expense(overrides: Partial<Doc<"expenses">>): Doc<"expenses"> {
  seq += 1;
  return {
    _id: `prep${seq}` as Doc<"expenses">["_id"],
    _creationTime: BEFORE,
    orgId: "org1" as Doc<"expenses">["orgId"],
    vehicleId: "veh1" as Doc<"expenses">["vehicleId"],
    title: `Prep ${seq}`,
    amount: 116,
    taxAmount: 16,
    date: BEFORE,
    category: "REPAIR",
    status: "PAID",
    accountingTreatment: "PERIOD_EXPENSE",
    ...overrides,
  } as Doc<"expenses">;
}

function prep(rows: Doc<"expenses">[], cutoff: number | null = CUTOFF) {
  return deriveDealerPreparationExpenses({ expenses: rows, cutoffCreationTime: cutoff, dealCurrency: "JOD", orgCurrency: "JOD" });
}

describe("deriveDealerPreparationExpenses", () => {
  test("sums paid, posted, non-reversed preparation rows registered before the deal, NET of VAT", () => {
    const p = prep([expense({}), expense({ category: "DETAILING", amount: 50, taxAmount: undefined })]);
    if (!p.available) throw new Error("expected available");
    expect(p.totalMinor).toBe(100_000 + 50_000);
    expect(p.expenses.map((r) => r.netMinor)).toEqual([100_000, 50_000]);
  });

  test("a non-preparation category (marketing, fees) is not preparation, and is counted", () => {
    const p = prep([expense({ category: "MARKETING" }), expense({ category: "FEES" })]);
    if (!p.available) throw new Error("expected available");
    expect(p.totalMinor).toBe(0);
    expect(p.excluded.otherCount).toBe(2);
  });

  test("a PENDING row is not spent — counted, never summed, even carrying a treatment", () => {
    const p = prep([expense({ status: "PENDING", accountingTreatment: "PERIOD_EXPENSE" })]);
    if (!p.available) throw new Error("expected available");
    expect(p.totalMinor).toBe(0);
    expect(p.excluded.pendingCount).toBe(1);
  });

  test("a PAID row with no posting decision is unreadable legacy evidence — withheld, never zero", () => {
    expect(prep([expense({ accountingTreatment: undefined })])).toEqual({
      available: false,
      reason: "UNREADABLE_AMOUNT",
      currency: "JOD",
    });
  });

  test("a CAPITALIZED row on a car that is consigned now is ambiguous ownership history — withheld", () => {
    expect(prep([expense({ accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: 100 })])).toEqual({
      available: false,
      reason: "AMBIGUOUS_OWNERSHIP_HISTORY",
      currency: "JOD",
    });
  });

  test("reversed rows, rows registered after the deal, and a row past the cap", () => {
    const p = prep([expense({ reversedAt: CUTOFF }), expense({ _creationTime: CUTOFF })]);
    if (!p.available) throw new Error("expected available");
    expect(p.totalMinor).toBe(0);
    expect(p.excluded).toEqual({ pendingCount: 0, reversedCount: 1, otherCount: 0, afterCutoffCount: 1 });
    const many = Array.from({ length: MAX_COST_BASIS_EXPENSES + 1 }, () => expense({}));
    expect(prep(many)).toMatchObject({ available: false, reason: "TOO_MANY_ROWS" });
  });

  test("an unreadable amount or a negative net withholds the figure", () => {
    expect(prep([expense({ amount: Number.NaN })])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
    expect(prep([expense({ amount: 10, taxAmount: 20 })])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
  });
});

describe("the consigned cost basis never absorbs a capitalized row into the supplier's entitlement", () => {
  const sourced = { sourceType: "SOURCED" as const, sourceCost: 8_000, purchasePrice: undefined, landedCostTotal: undefined };
  test("a capitalized row on a consigned car withholds the basis as ambiguous, rather than adding to the supplier's cost", () => {
    const b = deriveVehicleCostBasis({
      vehicle: sourced,
      expenses: [expense({ accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: 100 })],
      cutoffCreationTime: CUTOFF,
      dealCurrency: "JOD",
      orgCurrency: "JOD",
    });
    expect(b).toEqual({ available: false, reason: "AMBIGUOUS_OWNERSHIP_HISTORY", currency: "JOD", consigned: true });
  });
  test("period expenses on a consigned car leave the supplier's cost exactly as recorded", () => {
    const b = deriveVehicleCostBasis({
      vehicle: sourced,
      expenses: [expense({}), expense({})],
      cutoffCreationTime: CUTOFF,
      dealCurrency: "JOD",
      orgCurrency: "JOD",
    });
    if (!b.available) throw new Error("expected available");
    expect(b.baseMinor).toBe(8_000_000);
    expect(b.eligibleExpensesMinor).toBe(0);
    expect(b.totalBeforeDealMinor).toBe(8_000_000);
    expect(b.excluded.periodExpenseCount).toBe(2);
  });
  test("on the dealership's own car a PAID row with no posting decision is unreadable, and a PENDING row is only counted", () => {
    const stock = { sourceType: "STOCK" as const, purchasePrice: 9_500, landedCostTotal: 0, sourceCost: undefined };
    const args = { vehicle: stock, cutoffCreationTime: CUTOFF, dealCurrency: "JOD", orgCurrency: "JOD" };
    expect(deriveVehicleCostBasis({ ...args, expenses: [expense({ accountingTreatment: undefined })] })).toMatchObject({
      available: false,
      reason: "UNREADABLE_AMOUNT",
    });
    const pending = deriveVehicleCostBasis({
      ...args,
      expenses: [expense({ status: "PENDING", accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: 100 })],
    });
    if (!pending.available) throw new Error("expected available");
    expect(pending.eligibleExpensesMinor).toBe(0);
    expect(pending.excluded.pendingCount).toBe(1);
  });
});

describe("withPreparationExpenses", () => {
  const profit: ManagementProfit = {
    available: true,
    basis: "MANAGEMENT_ESTIMATE",
    amountMinor: 2_410_000,
    currency: "JOD",
    classification: "ESTIMATED_AWAITING_SETTLEMENT",
    postable: false,
    lines: [
      { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500_000 },
      { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: 9_500_000 },
      { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 500_000 },
      { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90_000 },
    ],
  };
  test("SOURCED: subtracts the preparation spend exactly once as its own line, supplier settlement untouched", () => {
    const p = withPreparationExpenses(profit, { available: true, totalMinor: 150_000 });
    if (!p.available) throw new Error("expected available");
    expect(p.amountMinor).toBe(2_410_000 - 150_000);
    expect(p.lines.filter((l) => l.key === "PREPARATION_EXPENSES")).toEqual([
      { key: "PREPARATION_EXPENSES", sign: -1, amountMinor: 150_000 },
    ]);
    expect(p.lines.find((l) => l.key === "SUPPLIER_SETTLEMENT")?.amountMinor).toBe(9_500_000);
    expect(p.postable).toBe(false);
  });
  test("unstatable preparation evidence withholds the headline — never a zero deduction", () => {
    expect(withPreparationExpenses(profit, { available: false })).toEqual({
      available: false,
      reason: "PreparationExpensesUnreadable",
    });
  });
  test("a corrupt preparation total (negative, NaN, unsafe) refuses the headline", () => {
    for (const totalMinor of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 0.5]) {
      expect(withPreparationExpenses(profit, { available: true, totalMinor })).toEqual({
        available: false,
        reason: "CorruptInput",
      });
    }
  });
  test("an unavailable cockpit figure passes through with its own reason", () => {
    expect(withPreparationExpenses({ available: false, reason: "NoSupplierSettlement" }, { available: true, totalMinor: 1 })).toEqual({
      available: false,
      reason: "NoSupplierSettlement",
    });
  });
});
