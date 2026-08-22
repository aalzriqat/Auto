import { describe, expect, test } from "vitest";
import { ruleSaleCompleted, validateBalance, SaleCompletedPayload } from "./postingRules";
import { SYSTEM_KEYS } from "../utils/defaultChart";

/**
 * Sales tax on the dealership's OWN sales (SCRUM-22).
 *
 * `saleAmountMinor` is tax-EXCLUSIVE. Two independent producers prove it:
 * `applySaleCompletionSideEffects` passes `args.salePrice` straight through
 * while `taxMinor` arrives as a separate `args.taxAmount`, and
 * `completeMultiVehicleSale` computes `taxAmount = item.unitPrice * taxRate/100`
 * — additive, not carved out. The sale form agrees: `SaleDialog` bills the
 * customer `salePrice + taxAmount + dealerFees + warranty + GAP`.
 *
 * `ruleSaleCompleted` read the same number as tax-INCLUSIVE. It recognized
 * `saleAmountMinor - taxMinor` as revenue and debited AR without the tax, so
 * for a 20,000 sale at 16% it posted Dr AR 20,000 / Cr Revenue 16,800 / Cr Tax
 * 3,200 where the customer was actually billed 23,200.
 *
 * Both sides are understated by exactly the tax, so **the journal balances** —
 * which is why the posting engine's balance validation never caught it, and why
 * these tests assert per-account amounts rather than only that it balances.
 *
 * The convention chosen is the one the producers and the invoice already use:
 * the price is tax-exclusive, revenue is the price, and the tax is billed on
 * top. Nothing here decides *whose* tax an agent-basis sale is —
 * `consignedAgentSaleLines` still refuses a taxed consigned sale, and this
 * change does not touch that refusal.
 */

const jod = (major: number): number => Math.round(major * 1000);

const owned: SaleCompletedPayload = {
  saleId: "sale_tax_1",
  saleAmountMinor: jod(20_000),
  currency: "JOD",
  customerId: "cust_1",
  vehicleId: "veh_1",
  salespersonId: "user_1",
  consignmentEvaluated: true,
};

/** Net movement on an account across the whole entry: debits minus credits. */
function net(result: ReturnType<typeof ruleSaleCompleted>, key: string): number {
  return result.lines
    .filter((l) => l.accountSystemKey === key)
    .reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
}

describe("sales tax on an owned sale", () => {
  // Three separate tests rather than three assertions in one, because the two
  // halves of this defect are independent and the first `expect` to fail would
  // otherwise hide the second. Both must be seen to fail on their own.

  test("bills the customer for the tax as well as the price", () => {
    // The customer owes the price AND the tax — that is what the invoice says.
    const result = ruleSaleCompleted({ ...owned, taxMinor: jod(3_200) });
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(23_200));
  });

  test("recognizes the whole price as revenue instead of carving the tax out of it", () => {
    // Revenue is the full tax-exclusive price. Carving the tax out of it makes
    // the dealership fund the customer's tax from its own revenue.
    const result = ruleSaleCompleted({ ...owned, taxMinor: jod(3_200) });
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
  });

  test("records the tax as a liability owed to the authority", () => {
    // This half was already right, and is pinned so the fix cannot move it.
    const result = ruleSaleCompleted({ ...owned, taxMinor: jod(3_200) });
    expect(net(result, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(3_200));
  });

  test("the entry balances — which the broken version also did", () => {
    // Stated explicitly so nobody mistakes a balanced entry for a correct one.
    // The old posting balanced at 20,000 = 16,800 + 3,200; the fixed one
    // balances at 23,200 = 20,000 + 3,200. Balance alone distinguishes nothing.
    const result = ruleSaleCompleted({ ...owned, taxMinor: jod(3_200) });
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("the tax rides on top of dealer fees and F&I products, not inside them", () => {
    const result = ruleSaleCompleted({
      ...owned,
      taxMinor: jod(3_200),
      dealerFeesMinor: jod(150),
      warrantySoldMinor: jod(800),
      warrantyCostMinor: jod(500),
      gapSoldMinor: jod(400),
      gapCostMinor: jod(250),
    });

    // 20,000 + 3,200 tax + 150 fees + 800 warranty + 400 GAP.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(24_550));
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
    expect(net(result, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(3_200));
    expect(net(result, SYSTEM_KEYS.DEALER_FEE_INCOME)).toBe(-jod(150));
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("an untaxed sale is unchanged", () => {
    // The overwhelming majority of real sales. A fix that shifted these would
    // restate every sale on the books, so this pins that it does not.
    const result = ruleSaleCompleted(owned);

    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(20_000));
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
    expect(result.lines.some((l) => l.accountSystemKey === SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(false);
  });

  test("a zero tax is the same as no tax, not a tax line of nothing", () => {
    const result = ruleSaleCompleted({ ...owned, taxMinor: 0 });

    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(20_000));
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
    expect(result.lines.some((l) => l.accountSystemKey === SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(false);
  });

  test("cost of sales is untouched by the tax convention", () => {
    // Inventory relief and COGS are about what the car cost, not what it sold
    // for, so the tax must not reach them. Worth pinning because the fix moves
    // two amounts in the same function.
    const result = ruleSaleCompleted({ ...owned, taxMinor: jod(3_200), costMinor: jod(17_000) });

    expect(net(result, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD)).toBe(jod(17_000));
    expect(net(result, SYSTEM_KEYS.VEHICLE_INVENTORY)).toBe(-jod(17_000));
    expect(() => validateBalance(result.lines)).not.toThrow();
  });
});
