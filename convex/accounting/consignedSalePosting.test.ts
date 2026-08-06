import { describe, expect, test } from "vitest";
import { ruleSaleCompleted, SaleCompletedPayload } from "./postingRules";
import { SYSTEM_KEYS } from "../utils/defaultChart";

/**
 * A consigned vehicle is legally the supplier's. The dealership sells it on his
 * behalf and may recognize only the spread over his entitlement.
 *
 * Nothing pinned this before: the existing sourced-vehicle tests cover
 * acquisition (never capitalized) and conversion to owned stock, but no test
 * ever asserted what a sourced SALE posts. That is why every historical one
 * went onto the books at gross.
 */

const jod = (major: number): number => Math.round(major * 1000);

const base: SaleCompletedPayload = {
  saleId: "sale_1",
  saleAmountMinor: jod(12_500),
  currency: "JOD",
  customerId: "cust_1",
  vehicleId: "veh_1",
  salespersonId: "user_1",
};

const consigned = (
  overrides: Partial<SaleCompletedPayload> = {},
  route: "DIRECT_TO_SUPPLIER" | "THROUGH_DEALERSHIP" = "THROUGH_DEALERSHIP"
): SaleCompletedPayload => ({
  ...base,
  isSourced: true,
  consignment: {
    supplierEntitlementMinor: jod(9_500),
    supplierName: "Amman Importer Co",
    settlementRoute: route,
  },
  ...overrides,
});

/** Net movement on an account across the whole entry: debits minus credits. */
function net(result: ReturnType<typeof ruleSaleCompleted>, key: string): number {
  return result.lines
    .filter((l) => l.accountSystemKey === key)
    .reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
}

describe("a consigned vehicle sold as the supplier's agent", () => {
  test("recognizes the margin as commission and no vehicle revenue at all", () => {
    const result = ruleSaleCompleted(consigned());

    expect(net(result, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE)).toBe(-jod(3_000));
    // The three that gross posting inflated by the supplier's entitlement.
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(0);
    expect(net(result, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD)).toBe(0);
    expect(net(result, SYSTEM_KEYS.VEHICLE_INVENTORY)).toBe(0);
  });

  test("keeps the supplier's share as a liability, never as revenue in transit", () => {
    const result = ruleSaleCompleted(consigned());

    // Gross arrives, but 9,500 of it belongs to somebody else from the instant
    // it lands — it is not the dealership's money to report or to spend.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(12_500));
    expect(net(result, SYSTEM_KEYS.SUPPLIER_PROCEEDS_CLEARING)).toBe(-jod(9_500));
  });

  test("books only a claim for the margin when the buyer paid the supplier direct", () => {
    const result = ruleSaleCompleted(consigned({}, "DIRECT_TO_SUPPLIER"));

    // Nothing gross ever reaches these books.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(0);
    expect(net(result, SYSTEM_KEYS.SUPPLIER_PROCEEDS_CLEARING)).toBe(0);
    expect(net(result, SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS)).toBe(jod(3_000));
    expect(net(result, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE)).toBe(-jod(3_000));
  });

  test("balances", () => {
    for (const route of ["THROUGH_DEALERSHIP", "DIRECT_TO_SUPPLIER"] as const) {
      const result = ruleSaleCompleted(consigned({}, route));
      const debits = result.lines.reduce((s, l) => s + l.debitMinor, 0);
      const credits = result.lines.reduce((s, l) => s + l.creditMinor, 0);
      expect(debits).toBe(credits);
    }
  });

  test("still books the dealership's own fee income, which the supplier's car does not affect", () => {
    const result = ruleSaleCompleted(consigned({ dealerFeesMinor: jod(200) }));

    expect(net(result, SYSTEM_KEYS.DEALER_FEE_INCOME)).toBe(-jod(200));
    // The fee is owed by the customer, on top of the proceeds.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(12_700));
  });

  test("refuses a sale below the supplier's entitlement rather than posting a negative commission", () => {
    // Real situation, but not one this rule may guess at: it is a loss the
    // dealership has to fund, and netting it into revenue would hide that.
    expect(() =>
      ruleSaleCompleted(consigned({ saleAmountMinor: jod(9_000) }))
    ).toThrow(/below the supplier's entitlement/i);
  });
});

describe("the fail-closed guard on owned-basis posting", () => {
  test("refuses to post a sourced vehicle as an owned sale", () => {
    // Silence here is what put every historical sourced sale on the books at
    // gross: revenue on a car the dealership never owned, and inventory relief
    // for stock it never held.
    expect(() =>
      ruleSaleCompleted({ ...base, isSourced: true, costMinor: jod(9_500) })
    ).toThrow(/cannot be posted as an owned sale/i);
  });

  test("names conversion to dealer-owned stock as the other legitimate answer", () => {
    expect(() => ruleSaleCompleted({ ...base, isSourced: true })).toThrow(
      /convert the vehicle to dealer-owned stock/i
    );
  });

  test("leaves an ordinary owned sale exactly as it was", () => {
    const result = ruleSaleCompleted({ ...base, costMinor: jod(9_500) });

    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(12_500));
    expect(net(result, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD)).toBe(jod(9_500));
    expect(net(result, SYSTEM_KEYS.VEHICLE_INVENTORY)).toBe(-jod(9_500));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(12_500));
    expect(net(result, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE)).toBe(0);
  });

  test("reaches the same bottom line as the gross posting it replaces", () => {
    // The whole reason the historical correction is a reclassification rather
    // than a restatement: agent basis and principal basis agree on profit.
    const agent = ruleSaleCompleted(consigned());
    const agentProfit =
      -net(agent, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE) -
      net(agent, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD);

    const principal = ruleSaleCompleted({ ...base, costMinor: jod(9_500) });
    const principalProfit =
      -net(principal, SYSTEM_KEYS.SALES_REVENUE) -
      net(principal, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD);

    expect(agentProfit).toBe(jod(3_000));
    expect(principalProfit).toBe(jod(3_000));
  });
});
