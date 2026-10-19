/**
 * SCRUM-411 / CodeRabbit 4276958526 - the supplier-entitlement ceiling of a consigned
 * THROUGH_DEALERSHIP plan-v3 sale is the sale's own persisted consideration K = A + R, not
 * the quote's operational sale price.
 *
 * Completion measures the supplier's position against K (`serverConsiderationMinor`), and K
 * exceeds the operational price whenever the customer absorbs a net shortfall (R > 0). An
 * entitlement E with salePrice < E <= K is therefore a LEGAL completion, yet the reader's
 * ceiling was the sale price, so it dropped E as corrupt and `saleEconomics` published
 * `supplierSettlement: null` for a sale the books settled correctly.
 *
 * Worked figures (JOD): operational price 12,500; A = 12,500; R = 500 -> K = 13,000;
 * supplier entitlement E = 12,800 (between the two); contribution D = 1,375.
 *
 * Legacy rows (no persisted K) and every other route keep the sale-price ceiling.
 *
 * Evidence boundary: pure functions over synthetic rows - repository behaviour only.
 */
import { describe, expect, test } from "vitest";
import { recordedFinancedConsideration, saleEconomics, saleIsAgentSale } from "./utils/vehicleOwnership";

const SALE_PRICE = 12_500;
const K = 13_000;
const E = 12_800;
const D = 1_375;

/** A consigned THROUGH_DEALERSHIP v3 row as the reports read it. */
const throughV3 = (over: Partial<Parameters<typeof saleEconomics>[0]> = {}) =>
  saleEconomics({
    salePrice: SALE_PRICE,
    vehicle: { sourceType: "SOURCED" },
    capitalizedCost: E,
    supplierSettlementRoute: "THROUGH_DEALERSHIP",
    recordedMargin: K - E,
    // The ledger's net: K - E - D.
    recordedNetRevenue: K - E - D,
    recordedSupplierEntitlement: E,
    externallyFinanced: true,
    ...over,
  });

describe("through-dealership v3: the entitlement ceiling is the persisted consideration", () => {
  test("E between the operational price and K is published, not withheld", () => {
    const e = throughV3({ recordedConsideration: K });
    expect(e.isAgentSale).toBe(true);
    expect(e.supplierSettlement).toBe(E);
    expect(e.dealershipMargin).toBe(K - E - D);
  });

  test("an entitlement above K is still corruption: withheld", () => {
    const e = throughV3({ recordedConsideration: K, recordedSupplierEntitlement: K + 1, capitalizedCost: K + 1 });
    expect(e.supplierSettlement).toBeNull();
  });

  test("a legacy row (no persisted K) keeps the sale-price ceiling: the same E is withheld", () => {
    const e = throughV3();
    expect(e.supplierSettlement).toBeNull();
  });

  test("K below the sale price lowers the ceiling: the frozen E fails it and the live cost answers; without K the same E is published", () => {
    // Price 12,500, K 12,000, frozen E 12,200 (between K and the price), live cost 11,900.
    // Completion measures the supplier's position against K, so E > K is not believable. The
    // established SCRUM-40 O-2 rule then falls back to a valid live cost (11,900), never to null.
    const lowK = 12_000;
    const lowE = 12_200;
    const liveCost = 11_900;
    const withK = throughV3({
      recordedConsideration: lowK,
      recordedSupplierEntitlement: lowE,
      capitalizedCost: liveCost,
      recordedMargin: lowK - liveCost,
      recordedNetRevenue: lowK - liveCost - D,
    });
    expect(withK.supplierSettlement).toBe(liveCost);

    // A legacy row has no K: the sale-price ceiling (12,500) admits the frozen E.
    const legacy = throughV3({
      recordedSupplierEntitlement: lowE,
      capitalizedCost: liveCost,
      recordedMargin: SALE_PRICE - lowE,
      recordedNetRevenue: SALE_PRICE - lowE - D,
    });
    expect(legacy.supplierSettlement).toBe(lowE);
  });

  test("an entitlement at or below the sale price is unchanged by K", () => {
    const withK = throughV3({ recordedConsideration: K, recordedSupplierEntitlement: 9_000, capitalizedCost: 9_000 });
    const without = throughV3({ recordedSupplierEntitlement: 9_000, capitalizedCost: 9_000 });
    expect(withK.supplierSettlement).toBe(9_000);
    expect(without.supplierSettlement).toBe(9_000);
  });

  test("K never raises the ceiling on the direct route: a cash-direct row above the sale price stays withheld", () => {
    const e = throughV3({
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      externallyFinanced: false,
      recordedConsideration: K,
    });
    expect(e.supplierSettlement).toBeNull();
  });
});

describe("through-dealership v3 with the vehicle row gone: the classifier honours K too", () => {
  // `loadDealRoute` (the financed cockpit) passes the same facts to `saleIsAgentSale`. With no
  // vehicle and no recorded margin, the frozen entitlement is the ONLY consignment evidence.
  const gone = (over: Partial<Parameters<typeof saleIsAgentSale>[0]> = {}) =>
    saleIsAgentSale({
      vehicle: null,
      salePrice: SALE_PRICE,
      recordedSupplierEntitlement: E,
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
      externallyFinanced: true,
      ...over,
    });

  test("E between the price and K still proves an agent sale when K is passed", () => {
    expect(gone({ recordedConsideration: K })).toBe(true);
  });

  test("the same row without K is read as not consigned (the omission the cockpit must not repeat)", () => {
    expect(gone()).toBe(false);
  });
});

describe("recordedFinancedConsideration - the persisted K is read only when it is trustworthy", () => {
  const sale = (financedNetRevenue: unknown, consignedMarginCurrency: string | undefined = "JOD") =>
    ({ financedNetRevenue, consignedMarginCurrency }) as unknown as Parameters<typeof recordedFinancedConsideration>[0];

  test("a v3 row reads its consideration in major units", () => {
    expect(recordedFinancedConsideration(sale({ minor: 11_625_000, currency: "JOD", considerationMinor: 13_000_000 }))).toBe(13_000);
  });

  test("a row without the field (legacy v3, v1, v2, cash) reads undefined", () => {
    expect(recordedFinancedConsideration(sale({ minor: 11_625_000, currency: "JOD" }))).toBeUndefined();
    expect(recordedFinancedConsideration(sale(undefined))).toBeUndefined();
  });

  test("an unscalable, mismatched, fractional or negative record is withheld, never guessed", () => {
    expect(recordedFinancedConsideration(sale({ minor: 1, currency: "JD", considerationMinor: 13_000_000 }, "JD"))).toBeUndefined();
    expect(recordedFinancedConsideration(sale({ minor: 1, currency: "JOD", considerationMinor: 13_000_000 }, "USD"))).toBeUndefined();
    expect(recordedFinancedConsideration(sale({ minor: 1, currency: "JOD", considerationMinor: 13_000_000.5 }))).toBeUndefined();
    expect(recordedFinancedConsideration(sale({ minor: 1, currency: "JOD", considerationMinor: -1 }))).toBeUndefined();
  });
});
