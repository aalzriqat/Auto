import { describe, expect, it } from "vitest";
import type { ConsignmentLine } from "./browserSwarmConsignmentOracle";
import {
  MONEY_BOUNDARY_FIGURES,
  buildMoneyBoundaryScenario,
  evaluateMoneyBoundary,
  expectedNetRevenueMinor,
  priceBasisNetRevenueMinor,
  undiscriminatedBases,
  type MoneyBoundaryExpectation,
} from "./browserSwarmMoneyBoundaryOracle";

/**
 * SCRUM-350 ACC-1 — the pure judgement of a financed sale of owned stock.
 *
 * Every figure is written out by hand (JOD, scale 1,000): a 20,000 car bought for
 * 15,000, approved at 18,000 by an 85% financier, a 200 deposit, a customer gap of
 * 1,000, a 300 admin fee. Hand-worked: contribution D = 18,000 − 15,300 − 200 = 2,500;
 * consideration K = 18,000 + 1,000 = 19,000; forward = 200 + 2,500 = 2,700. The correct
 * entry therefore debits 18,000 + 1,000 + 200 + 2,500 + 15,000 = 36,700 and credits
 * 2,700 + 19,000 + 15,000 = 36,700. None of these literals comes from the builder.
 */
const EXPECTATION: MoneyBoundaryExpectation = {
  currency: "JOD",
  priceMinor: 20_000_000,
  costMinor: 15_000_000,
  approvedMinor: 18_000_000,
  contributionMinor: 2_500_000,
  depositMinor: 200_000,
  customerGapMinor: 1_000_000,
  adminFeeMinor: 300_000,
};

const line = (key: string, debitMinor: number, creditMinor: number, entryId = "je-1"): ConsignmentLine => ({
  key,
  debitMinor,
  creditMinor,
  currency: "JOD",
  scale: 3,
  entryId,
  accountId: `acct-${key}`,
});

const correct = (): ConsignmentLine[] => [
  line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 18_000_000, 0),
  line("ACCOUNTS_RECEIVABLE_CUSTOMERS", 1_000_000, 0),
  line("CUSTOMER_DEPOSITS_LIABILITY", 200_000, 0),
  line("SALES_CONSIDERATION_REDUCTIONS", 2_500_000, 0),
  line("COST_OF_VEHICLES_SOLD", 15_000_000, 0),
  line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, 2_700_000),
  line("SALES_REVENUE", 0, 19_000_000),
  line("VEHICLE_INVENTORY", 0, 15_000_000),
];

/** The correct entry with the lines of `keys` replaced by `replacements`. */
const without = (keys: string[], replacements: ConsignmentLine[] = []): ConsignmentLine[] => [
  ...correct().filter((entry) => !keys.includes(entry.key)),
  ...replacements,
];

describe("SCRUM-350 ACC-1 money boundary oracle: the hand-worked scenario", () => {
  it("derives the scenario's figures independently of the product", () => {
    const built = buildMoneyBoundaryScenario("JOD");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.scenario.expectation).toEqual(EXPECTATION);
    expect(built.scenario).toMatchObject({
      quotationMinor: 20_000_000,
      ltvPercent: 85,
      firstPaymentMinor: 200_000,
      shortfallMinor: 1_700_000,
      customerShareMinor: 1_000_000,
      dealerShareMinor: 700_000,
      forwardDueMinor: 2_700_000,
    });
  });

  it("tells the correct net revenue (16,500) from the price basis (17,500)", () => {
    expect(expectedNetRevenueMinor(EXPECTATION)).toBe(16_500_000);
    expect(priceBasisNetRevenueMinor(EXPECTATION)).toBe(17_500_000);
    expect(undiscriminatedBases(EXPECTATION)).toEqual([]);
  });

  it("refuses a scenario in a currency with no known scale, or whose gap exceeds the shortfall, before anything is seeded", () => {
    const unknown = buildMoneyBoundaryScenario("XXX");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toMatch(/no known minor-unit scale/);
    // The net shortfall is 1,700; a customer share of 1,800 has nothing to cover.
    const tooBig = buildMoneyBoundaryScenario("JOD", { ...MONEY_BOUNDARY_FIGURES, customerGapMajor: 1_800 });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.reason).toMatch(/net shortfall \(1700000\)/);
  });

  it("names every wrong basis the chosen figures cannot tell from the right one", () => {
    // Approved + gap equals the price: a price-measured revenue is indistinguishable.
    expect(undiscriminatedBases({ ...EXPECTATION, customerGapMinor: 2_000_000 })).toEqual(["APPROVED_VS_PRICE_BASIS"]);
    expect(undiscriminatedBases({ ...EXPECTATION, adminFeeMinor: 0 })).toEqual(["SETTLEMENT_FEE_NETTING"]);
    expect(undiscriminatedBases({ ...EXPECTATION, depositMinor: 0 })).toEqual(["DEPOSIT_RELEASE"]);
    expect(undiscriminatedBases({ ...EXPECTATION, contributionMinor: 0 })).toEqual(["CONTRIBUTION_CONTRA_REVENUE"]);
    expect(undiscriminatedBases({ ...EXPECTATION, costMinor: 0 })).toEqual(["COST_OF_SALE"]);
  });
});

describe("SCRUM-350 ACC-1 money boundary oracle: judging the posting", () => {
  it("passes the correct entry, which balances at 36,700", () => {
    const lines = correct();
    expect(lines.reduce((sum, entry) => sum + entry.debitMinor, 0)).toBe(36_700_000);
    expect(lines.reduce((sum, entry) => sum + entry.creditMinor, 0)).toBe(36_700_000);
    expect(evaluateMoneyBoundary(EXPECTATION, lines)).toEqual({ violations: [], unjudged: [] });
  });

  it("fails revenue measured on the sale price even though the entry balances", () => {
    // Revenue 20,000 and the customer's receivable raised by the same 1,000: balanced and wrong.
    const lines = without(["SALES_REVENUE", "ACCOUNTS_RECEIVABLE_CUSTOMERS"], [
      line("SALES_REVENUE", 0, 20_000_000),
      line("ACCOUNTS_RECEIVABLE_CUSTOMERS", 2_000_000, 0),
    ]);
    expect(lines.reduce((sum, entry) => sum + entry.debitMinor, 0)).toBe(lines.reduce((sum, entry) => sum + entry.creditMinor, 0));
    const verdict = evaluateMoneyBoundary(EXPECTATION, lines);
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual([
      "ACCOUNTS_RECEIVABLE_CUSTOMERS debits 2000000 minor units, expected 1000000",
      "SALES_REVENUE credits 20000000 minor units, expected 19000000",
      "revenue was measured on the sale price 20000000 instead of the approved amount plus the customer's gap 19000000",
    ]);
  });

  it("fails a financier receivable netted of the dealership's own admin fee", () => {
    const lines = without(["ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES"], [
      line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 17_700_000, 0),
      line("SELLING_EXPENSES", 300_000, 0),
    ]);
    const verdict = evaluateMoneyBoundary(EXPECTATION, lines);
    expect(verdict.violations).toContain("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES debits 17700000 minor units, expected 18000000");
    expect(verdict.violations).toContain(
      "the receivable from the financing company is net of the dealership's own admin fee 300000; the financier transfers the full approval",
    );
    expect(verdict.violations).toContain(
      "SELLING_EXPENSES (debit 300000, credit 0) is not an account a financed sale of dealership stock may post to",
    );
  });

  it("fails agent basis on an owned car: the same bottom line on a commission and a supplier payable", () => {
    // Commission 4,000 = 19,000 − 15,000, the supplier owed 15,000, no revenue, COGS or inventory. Balanced, same profit.
    const lines = without(["SALES_REVENUE", "COST_OF_VEHICLES_SOLD", "VEHICLE_INVENTORY"], [
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, 4_000_000),
      line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
    ]);
    const verdict = evaluateMoneyBoundary(EXPECTATION, lines);
    expect(verdict.violations).toContain(
      "a commission was posted (debit 0, credit 4000000) on a car the dealership owns; it was recognized on agent basis",
    );
    expect(verdict.violations).toContain("ACCOUNTS_PAYABLE_SUPPLIERS (debit 0, credit 15000000) is not an account a financed sale of dealership stock may post to");
    expect(verdict.violations).toContain("SALES_REVENUE credits 0 minor units, expected 19000000");
    expect(verdict.violations).toContain("COST_OF_VEHICLES_SOLD debits 0 minor units, expected 15000000");
    expect(verdict.violations).toContain("VEHICLE_INVENTORY credits 0 minor units, expected 15000000");
  });

  it("fails a deposit booked to cash instead of releasing the deposit liability", () => {
    const lines = without(["CUSTOMER_DEPOSITS_LIABILITY"], [line("CASH_ON_HAND", 200_000, 0)]);
    const verdict = evaluateMoneyBoundary(EXPECTATION, lines);
    expect(verdict.violations).toContain("CUSTOMER_DEPOSITS_LIABILITY debits 0 minor units, expected 200000");
    expect(verdict.violations).toContain("CASH_ON_HAND (debit 200000, credit 0) is not an account a financed sale of dealership stock may post to");
  });

  it("fails a contribution that never reached the contra account, and one posted as an expense", () => {
    const lines = without(["SALES_CONSIDERATION_REDUCTIONS"], [line("SELLING_EXPENSES", 2_500_000, 0)]);
    const verdict = evaluateMoneyBoundary(EXPECTATION, lines);
    expect(verdict.violations).toContain("SALES_CONSIDERATION_REDUCTIONS debits 0 minor units, expected 2500000");
  });

  it("fails the cost of the car not leaving inventory by one minor unit", () => {
    const lines = without(["VEHICLE_INVENTORY"], [line("VEHICLE_INVENTORY", 0, 14_999_999)]);
    const verdict = evaluateMoneyBoundary(EXPECTATION, lines);
    expect(verdict.violations).toContain("VEHICLE_INVENTORY credits 14999999 minor units, expected 15000000");
    expect(verdict.violations.some((text) => /does not balance/.test(text))).toBe(true);
  });

  it("is not fooled by an offsetting pair on one account whose net equals the expected amount", () => {
    // Revenue credited 19,000 net, but through a 100 debit and a 19,100 credit.
    const lines = [...correct(), line("SALES_REVENUE", 100, 0), line("SALES_REVENUE", 0, 100)];
    const verdict = evaluateMoneyBoundary(EXPECTATION, lines);
    expect(verdict.violations).toContain("SALES_REVENUE debits 100 minor units, expected 0");
    expect(verdict.violations).toContain("SALES_REVENUE credits 19000100 minor units, expected 19000000");
  });

  it("fails an entry that does not balance, naming the journal", () => {
    const lines = correct().map((entry) => (entry.key === "SALES_REVENUE" ? { ...entry, creditMinor: 18_999_999 } : entry));
    const verdict = evaluateMoneyBoundary(EXPECTATION, lines);
    expect(verdict.violations).toContain("journal je-1 does not balance: debits 36700000, credits 36699999");
  });

  it("fails a line in another currency or scale, a negative amount and a two-sided line", () => {
    const lines = correct().map((entry) => {
      if (entry.key === "SALES_REVENUE") return { ...entry, currency: "USD", scale: 2 };
      if (entry.key === "VEHICLE_INVENTORY") return { ...entry, debitMinor: 7 };
      if (entry.key === "ACCOUNTS_RECEIVABLE_CUSTOMERS") return { ...entry, debitMinor: -1 };
      return entry;
    });
    const verdict = evaluateMoneyBoundary(EXPECTATION, lines);
    expect(verdict.violations).toContain("a SALES_REVENUE line is denominated USD at scale 2, not JOD at scale 3");
    expect(verdict.violations).toContain("a VEHICLE_INVENTORY line carries both a debit and a credit (7 / 15000000)");
    expect(verdict.violations.some((text) => /ACCOUNTS_RECEIVABLE_CUSTOMERS line has an amount/.test(text))).toBe(true);
  });

  it("judges balance per journal, so two balanced entries cannot hide one that is not", () => {
    const second = [line("SALES_REVENUE", 0, 5, "je-2")];
    const verdict = evaluateMoneyBoundary(EXPECTATION, [...correct(), ...second]);
    expect(verdict.violations).toContain("journal je-2 does not balance: debits 0, credits 5");
  });
});

/**
 * SCRUM-613 (comments 25968 and 25987), the approval excess leg, worked by hand in JOD (scale 1,000):
 * A 12,500 approval, F 11,000 financed, P 1,740 first payment held as the deposit H, so the excess
 * E = F + P - A = 240 is dealer income. The company is owed A - F = 1,500 (= H - E) and the sale credits
 * revenue A + E = 12,740. Debits 12,500 + 1,740 + 9,000 = 23,240; credits 1,500 + 12,740 + 9,000 = 23,240.
 */
describe("SCRUM-613 money boundary oracle: the approval excess leg", () => {
  const EXCESS: MoneyBoundaryExpectation = {
    currency: "JOD",
    priceMinor: 12_500_000,
    costMinor: 9_000_000,
    approvedMinor: 12_500_000,
    contributionMinor: 0,
    depositMinor: 1_740_000,
    customerGapMinor: 0,
    adminFeeMinor: 0,
    approvalExcessMinor: 240_000,
  };
  const excessLines = (): ConsignmentLine[] => [
    line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 12_500_000, 0),
    line("CUSTOMER_DEPOSITS_LIABILITY", 1_740_000, 0),
    line("COST_OF_VEHICLES_SOLD", 9_000_000, 0),
    line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, 1_500_000),
    line("SALES_REVENUE", 0, 12_500_000),
    line("SALES_REVENUE", 0, 240_000),
    line("VEHICLE_INVENTORY", 0, 9_000_000),
  ];

  it("passes the excess entry, which balances at 23,240 and nets revenue 12,740", () => {
    const lines = excessLines();
    expect(lines.reduce((sum, entry) => sum + entry.debitMinor, 0)).toBe(23_240_000);
    expect(lines.reduce((sum, entry) => sum + entry.creditMinor, 0)).toBe(23_240_000);
    expect(expectedNetRevenueMinor(EXCESS)).toBe(12_740_000);
    expect(evaluateMoneyBoundary(EXCESS, lines)).toEqual({ violations: [], unjudged: [] });
  });

  it("fails an excess that is not credited to revenue, and a forward not reduced by it", () => {
    const noRevenue = excessLines().filter((entry) => entry.creditMinor !== 240_000);
    expect(evaluateMoneyBoundary(EXCESS, noRevenue).violations).toContain(
      "SALES_REVENUE credits 12500000 minor units, expected 12740000",
    );
    const fullForward = excessLines().map((entry) =>
      entry.key === "ACCOUNTS_PAYABLE_FINANCE_COMPANIES" ? line(entry.key, 0, 1_740_000) : entry,
    );
    expect(evaluateMoneyBoundary(EXCESS, fullForward).violations).toContain(
      "ACCOUNTS_PAYABLE_FINANCE_COMPANIES credits 1740000 minor units, expected 1500000",
    );
  });

  it("holds the no-excess entry to its old figures when the excess is absent or zero", () => {
    expect(evaluateMoneyBoundary({ ...EXPECTATION, approvalExcessMinor: 0 }, correct())).toEqual({
      violations: [],
      unjudged: [],
    });
  });

  it("leaves an excess above the held deposit, or beside a contribution, unjudged", () => {
    for (const bad of [
      { ...EXCESS, approvalExcessMinor: 1_740_001 },
      { ...EXCESS, contributionMinor: 1 },
    ]) {
      const verdict = evaluateMoneyBoundary(bad, excessLines());
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toHaveLength(1);
    }
  });
});

describe("SCRUM-350 ACC-1 money boundary oracle: never a vacuous pass", () => {
  it("leaves a posting that was not read unjudged, not clean", () => {
    expect(evaluateMoneyBoundary(EXPECTATION, [])).toEqual({
      violations: [],
      unjudged: ["the sale's posting was not read: no journal line to judge"],
    });
  });

  it("leaves a currency with no known scale unjudged, even when lines are present", () => {
    const verdict = evaluateMoneyBoundary({ ...EXPECTATION, currency: "XXX" }, correct());
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged).toEqual([expect.stringMatching(/no known minor-unit scale/)]);
  });

  it("leaves an impossible expectation unjudged rather than judging against it", () => {
    for (const bad of [
      { ...EXPECTATION, approvedMinor: 20_000_001 },
      { ...EXPECTATION, depositMinor: 18_000_001 },
      { ...EXPECTATION, costMinor: 1.5 },
      { ...EXPECTATION, adminFeeMinor: -1 },
    ]) {
      const verdict = evaluateMoneyBoundary(bad, correct());
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toHaveLength(1);
    }
  });
});
