import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { deriveVehicleCostBasis, MAX_COST_BASIS_EXPENSES } from "./vehicleCostBasis";

/**
 * The pre-deal cost basis: which expense rows count, and the cutoff.
 *
 * The rules under test are the ones the module header enumerates —
 * CAPITALIZED_INVENTORY only, not deleted or reversed, REGISTERED (by row
 * creation time, not business date) before the deal was created — and each
 * exclusion is COUNTED, so a screen can say "3 rows were seen and not
 * counted" rather than showing a total that looks whole.
 */

const CUTOFF = Date.UTC(2026, 5, 15);
const BEFORE = Date.UTC(2026, 5, 1);
const AFTER = Date.UTC(2026, 6, 1);

let seq = 0;
function expense(overrides: Partial<Doc<"expenses">>): Doc<"expenses"> {
  seq += 1;
  return {
    _id: `exp${seq}` as Doc<"expenses">["_id"],
    // Registered before the cutoff by default; the business date is separate.
    _creationTime: BEFORE,
    orgId: "org1" as Doc<"expenses">["orgId"],
    vehicleId: "veh1" as Doc<"expenses">["vehicleId"],
    title: `Expense ${seq}`,
    amount: 100,
    date: BEFORE,
    category: "REPAIR",
    status: "PAID",
    accountingTreatment: "CAPITALIZED_INVENTORY",
    capitalizedAmount: 100,
    ...overrides,
  } as Doc<"expenses">;
}

type CostVehicle = Parameters<typeof deriveVehicleCostBasis>[0]["vehicle"];
const stock: CostVehicle = { sourceType: "STOCK", purchasePrice: 9_500, landedCostTotal: 250, sourceCost: undefined };
const sourced: CostVehicle = { sourceType: "SOURCED", sourceCost: 8_000, purchasePrice: undefined, landedCostTotal: undefined };

function basis(vehicle: CostVehicle, expenses: Doc<"expenses">[], extra = {}) {
  return deriveVehicleCostBasis({
    vehicle,
    expenses,
    cutoffCreationTime: CUTOFF,
    dealCurrency: "JOD",
    orgCurrency: "JOD",
    ...extra,
  });
}

describe("deriveVehicleCostBasis", () => {
  test("a PURCHASED vehicle: purchase price + landed cost + capitalized pre-deal expenses, in fils", () => {
    const b = basis(stock, [
      expense({ title: "Brakes", capitalizedAmount: 120.5 }),
      expense({ title: "Detailing", category: "DETAILING", capitalizedAmount: 30 }),
    ]);
    expect(b.available).toBe(true);
    if (!b.available) return;
    expect(b.consigned).toBe(false);
    expect(b.baseMinor).toBe(9_500_000);
    expect(b.landedCostMinor).toBe(250_000);
    expect(b.eligibleExpensesMinor).toBe(150_500);
    expect(b.totalBeforeDealMinor).toBe(9_900_500);
    expect(b.expenses.map((e) => e.title)).toEqual(["Brakes", "Detailing"]);
    expect(b.cutoffCreationTime).toBe(CUTOFF);
  });

  test("sums the capitalized (net-of-VAT) amount, never the gross amount", () => {
    const b = basis(stock, [expense({ amount: 116, taxAmount: 16, capitalizedAmount: 100 })]);
    if (!b.available) throw new Error("expected available");
    expect(b.eligibleExpensesMinor).toBe(100_000);
  });

  test("a SOURCED (consigned) vehicle: the base is the supplier's cost and is flagged consigned", () => {
    const b = basis(sourced, []);
    if (!b.available) throw new Error("expected available");
    expect(b.consigned).toBe(true);
    expect(b.baseMinor).toBe(8_000_000);
    expect(b.landedCostMinor).toBeNull();
    expect(b.totalBeforeDealMinor).toBe(8_000_000);
  });

  describe("what is excluded, and counted", () => {
    test("a PERIOD_EXPENSE row (marketing, fees, post-sale repair) is never inventory", () => {
      const b = basis(stock, [expense({ category: "FEES", accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined })]);
      if (!b.available) throw new Error("expected available");
      expect(b.eligibleExpensesMinor).toBe(0);
      expect(b.excluded.periodExpenseCount).toBe(1);
    });
    test("a PENDING row carries no posting decision and is not a cost yet", () => {
      const b = basis(stock, [expense({ status: "PENDING", accountingTreatment: undefined, capitalizedAmount: undefined })]);
      if (!b.available) throw new Error("expected available");
      expect(b.eligibleExpensesMinor).toBe(0);
      expect(b.excluded.pendingCount).toBe(1);
    });
    test("a reversed or deleted row is excluded, whichever mark it carries", () => {
      const b = basis(stock, [
        expense({ reversedAt: AFTER }),
        expense({ isDeleted: true }),
        expense({ isDeleted: true, reversedAt: AFTER }),
      ]);
      if (!b.available) throw new Error("expected available");
      expect(b.eligibleExpensesMinor).toBe(0);
      expect(b.excluded.reversedCount).toBe(3);
    });
    test("a row REGISTERED at or after the deal's creation is not pre-deal, whatever its business date", () => {
      const b = basis(stock, [
        expense({ _creationTime: CUTOFF }),
        expense({ _creationTime: AFTER }),
        expense({ _creationTime: CUTOFF - 1 }),
      ]);
      if (!b.available) throw new Error("expected available");
      expect(b.eligibleExpensesMinor).toBe(100_000);
      expect(b.excluded.afterCutoffCount).toBe(2);
    });
    test("the cutoff is the row's registration, not its business date: a same-day back-dated row booked after the deal is excluded, an earlier-registered row dated later is counted", () => {
      const bookedAfterDeal = expense({ date: BEFORE, _creationTime: CUTOFF + 1 });
      const registeredBeforeDatedAfter = expense({ date: AFTER, _creationTime: CUTOFF - 1, capitalizedAmount: 40 });
      const b = basis(stock, [bookedAfterDeal, registeredBeforeDatedAfter]);
      if (!b.available) throw new Error("expected available");
      expect(b.eligibleExpensesMinor).toBe(40_000);
      expect(b.excluded.afterCutoffCount).toBe(1);
    });
    test("exclusion order: a reversed capitalized row after the cutoff counts once, as reversed", () => {
      const b = basis(stock, [expense({ _creationTime: AFTER, reversedAt: AFTER })]);
      if (!b.available) throw new Error("expected available");
      expect(b.excluded).toEqual({ pendingCount: 0, reversedCount: 1, periodExpenseCount: 0, afterCutoffCount: 0 });
    });
  });

  describe("withheld, with the reason", () => {
    test("no recorded cost", () => {
      expect(basis({ ...stock, purchasePrice: undefined }, [])).toEqual({
        available: false,
        reason: "NO_COST_RECORDED",
        currency: "JOD",
        consigned: false,
      });
      expect(basis({ ...sourced, sourceCost: undefined }, []).available).toBe(false);
    });
    test("a ZERO or negative base is not a cost — zero is missing (as vehicleHasCostBasis reads it), negative is unreadable", () => {
      expect(basis({ ...stock, purchasePrice: 0 }, [])).toMatchObject({ available: false, reason: "NO_COST_RECORDED" });
      expect(basis({ ...sourced, sourceCost: 0 }, [])).toMatchObject({ available: false, reason: "NO_COST_RECORDED" });
      expect(basis({ ...stock, purchasePrice: -9_500 }, [])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
      expect(basis({ ...sourced, sourceCost: -1 }, [])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
    });
    test("a non-finite or unsafe base, landed cost or capitalized amount withholds the basis", () => {
      expect(basis({ ...stock, purchasePrice: Number.NaN }, [])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
      expect(basis({ ...stock, purchasePrice: Number.POSITIVE_INFINITY }, [])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
      expect(basis({ ...stock, purchasePrice: Number.MAX_SAFE_INTEGER }, [])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
      expect(basis({ ...stock, landedCostTotal: -1 }, [])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
      expect(basis({ ...stock, landedCostTotal: Number.NaN }, [])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
      expect(basis(stock, [expense({ capitalizedAmount: -100 })])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
      expect(basis(stock, [expense({ capitalizedAmount: Number.POSITIVE_INFINITY })])).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
    });
    test("an aggregate that leaves the safe range is withheld, even when every operand is safe", () => {
      const nearMax = Number.MAX_SAFE_INTEGER / 1000 - 1; // major units that convert to a safe minor amount
      const rows = [expense({ capitalizedAmount: nearMax }), expense({ capitalizedAmount: nearMax })];
      expect(basis(stock, rows)).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
    });
    test("the deal is in a different currency from the org's expense records", () => {
      const b = basis(stock, [expense({})], { dealCurrency: "USD" });
      expect(b).toEqual({ available: false, reason: "MIXED_DENOMINATION", currency: "USD", consigned: false });
    });
    test("an unreadable amount (NaN reaches v.number()) withholds the whole basis", () => {
      const b = basis(stock, [expense({ capitalizedAmount: Number.NaN })]);
      expect(b).toEqual({ available: false, reason: "UNREADABLE_AMOUNT", currency: "JOD", consigned: false });
    });
    test("a capitalized row with NO capitalized figure is unreadable, never zero", () => {
      const b = basis(stock, [expense({ capitalizedAmount: undefined })]);
      expect(b).toEqual({ available: false, reason: "UNREADABLE_AMOUNT", currency: "JOD", consigned: false });
    });
    test("more rows than the read carries: withheld as TOO_MANY_ROWS, never a prefix", () => {
      const rows = Array.from({ length: MAX_COST_BASIS_EXPENSES + 1 }, () => expense({}));
      expect(basis(stock, rows)).toEqual({ available: false, reason: "TOO_MANY_ROWS", currency: "JOD", consigned: false });
      const atCap = basis(stock, rows.slice(0, MAX_COST_BASIS_EXPENSES));
      expect(atCap.available).toBe(true);
    });
  });
});
