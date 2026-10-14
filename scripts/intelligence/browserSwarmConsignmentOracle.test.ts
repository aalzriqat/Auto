import { describe, expect, it } from "vitest";
import {
  evaluateConsignmentEconomics,
  expectedConsignedRevenueMinor,
  toMinor,
  type ConsignmentExpectation,
  type ConsignmentLine,
} from "./browserSwarmConsignmentOracle";

// Literal worked figures, JOD (3 decimals): a 20,000 car the supplier is owed
// 15,000 for, approved by the financier at 20,000. The dealership's whole
// earning is the 5,000 spread.
const THROUGH: ConsignmentExpectation = {
  currency: "JOD",
  priceMinor: 20_000_000,
  approvedMinor: 20_000_000,
  entitlementMinor: 15_000_000,
  contributionMinor: 0,
  route: "THROUGH_DEALERSHIP",
};

const line = (key: string, debitMinor: number, creditMinor: number, currency = "JOD", scale = 3): ConsignmentLine => ({
  key,
  debitMinor,
  creditMinor,
  currency,
  scale,
});

const correctThrough = (): ConsignmentLine[] => [
  line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 20_000_000, 0),
  line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
  line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000),
];

describe("CONS-1 oracle: independent expectation", () => {
  it("computes the dealership's earning as approved − entitlement − contribution, in minor units", () => {
    expect(expectedConsignedRevenueMinor(THROUGH)).toBe(5_000_000);
    expect(expectedConsignedRevenueMinor({ ...THROUGH, approvedMinor: 18_000_000, contributionMinor: 875_000 })).toBe(2_125_000);
  });

  it("converts major to minor only at a known scale, and only for whole minor amounts", () => {
    expect(toMinor(20_000, "JOD")).toBe(20_000_000);
    expect(toMinor(20_000, "USD")).toBe(2_000_000);
    expect(toMinor(1.001, "JOD")).toBe(1_001);
    expect(toMinor(1.0005, "JOD")).toBeNull();
    expect(toMinor(1.00049, "JOD")).toBeNull();
    expect(toMinor(5, "XXX")).toBeNull();
  });
});

describe("CONS-1 oracle: through-dealership financed consigned sale", () => {
  it("passes a posting that recognizes only the spread", () => {
    expect(evaluateConsignmentEconomics(THROUGH, correctThrough())).toEqual({ violations: [], unjudged: [] });
  });

  it("is a violation when the car's gross price is recognized as revenue (the owned-stock fall-through)", () => {
    const verdict = evaluateConsignmentEconomics(THROUGH, [
      line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 20_000_000, 0),
      line("SALES_REVENUE", 0, 20_000_000),
      line("COST_OF_VEHICLES_SOLD", 15_000_000, 0),
      line("VEHICLE_INVENTORY", 0, 15_000_000),
    ]);
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations.join("\n")).toMatch(/gross price was recognized/);
    expect(verdict.violations.join("\n")).toMatch(/SALES_REVENUE was touched/);
    expect(verdict.violations.join("\n")).toMatch(/COST_OF_VEHICLES_SOLD was touched/);
    expect(verdict.violations.join("\n")).toMatch(/VEHICLE_INVENTORY was touched/);
  });

  it("is a violation when the commission is off by one minor unit", () => {
    const lines = correctThrough();
    lines[2] = line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_001);
    const verdict = evaluateConsignmentEconomics(THROUGH, lines);
    expect(verdict.violations.join("\n")).toMatch(/recognized revenue is 5000001 minor units, expected 5000000/);
  });

  it("is a violation when the supplier's entitlement is not owed to him", () => {
    const lines = correctThrough();
    lines[1] = line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 14_000_000);
    expect(evaluateConsignmentEconomics(THROUGH, lines).violations.join("\n")).toMatch(/supplier payable is 14000000/);
  });

  it("is a violation when a supplier receivable appears on a through-dealership sale", () => {
    const lines = [...correctThrough(), line("RECEIVABLE_FROM_SUPPLIERS", 5_000_000, 0)];
    expect(evaluateConsignmentEconomics(THROUGH, lines).violations.join("\n")).toMatch(/receivable from the supplier was posted/);
  });

  it("is a violation when a line is in the wrong currency or scale", () => {
    const lines = correctThrough();
    lines[2] = line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000, "USD", 2);
    expect(evaluateConsignmentEconomics(THROUGH, lines).violations.join("\n")).toMatch(/denominated USD at scale 2, not JOD at scale 3/);
  });
});

describe("CONS-1 oracle: contribution is contra-revenue", () => {
  const WITH_CONTRIBUTION: ConsignmentExpectation = { ...THROUGH, approvedMinor: 18_000_000, contributionMinor: 875_000 };

  it("passes when the contribution reduces recognized revenue through the contra account", () => {
    const verdict = evaluateConsignmentEconomics(WITH_CONTRIBUTION, [
      line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 18_000_000, 0),
      line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, 3_000_000),
      line("SALES_CONSIDERATION_REDUCTIONS", 875_000, 0),
    ]);
    expect(verdict).toEqual({ violations: [], unjudged: [] });
  });

  it("is a violation when the contribution leaves revenue gross", () => {
    const verdict = evaluateConsignmentEconomics(WITH_CONTRIBUTION, [
      line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 18_000_000, 0),
      line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, 3_000_000),
    ]);
    expect(verdict.violations.join("\n")).toMatch(/recognized revenue is 3000000 minor units, expected 2125000/);
    expect(verdict.violations.join("\n")).toMatch(/not posted as contra-revenue/);
  });
});

describe("CONS-1 oracle: direct-to-supplier route", () => {
  const DIRECT: ConsignmentExpectation = { ...THROUGH, route: "DIRECT_TO_SUPPLIER" };

  it("passes a margin held as a claim on the supplier", () => {
    const verdict = evaluateConsignmentEconomics(DIRECT, [
      line("RECEIVABLE_FROM_SUPPLIERS", 5_000_000, 0),
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000),
    ]);
    expect(verdict).toEqual({ violations: [], unjudged: [] });
  });

  it("is a violation when the claim on the supplier is the gross price", () => {
    const verdict = evaluateConsignmentEconomics(DIRECT, [
      line("RECEIVABLE_FROM_SUPPLIERS", 20_000_000, 0),
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000),
    ]);
    expect(verdict.violations.join("\n")).toMatch(/receivable from the supplier is 20000000 minor units, expected 5000000/);
  });
});

describe("CONS-1 oracle: never a vacuous pass", () => {
  it("is unjudged, not clean, when no posting line was read", () => {
    const verdict = evaluateConsignmentEconomics(THROUGH, []);
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged.join("\n")).toMatch(/not read/);
  });

  it("is unjudged when the currency has no known scale", () => {
    const verdict = evaluateConsignmentEconomics({ ...THROUGH, currency: "XXX" }, correctThrough());
    expect(verdict.unjudged.join("\n")).toMatch(/no known minor-unit scale/);
  });

  it("is unjudged when the scenario cannot discriminate gross from margin", () => {
    // Entitlement equal to the approval means a zero margin: gross and margin
    // recognition could not be told apart by revenue alone.
    const verdict = evaluateConsignmentEconomics({ ...THROUGH, entitlementMinor: 20_000_000 }, correctThrough());
    expect(verdict.unjudged.join("\n")).toMatch(/positive margin/);
    expect(verdict.violations).toEqual([]);
  });

  it("is unjudged when an input is not a whole minor amount", () => {
    const verdict = evaluateConsignmentEconomics({ ...THROUGH, approvedMinor: 20_000_000.5 }, correctThrough());
    expect(verdict.unjudged.join("\n")).toMatch(/not a whole non-negative minor amount/);
  });
});
