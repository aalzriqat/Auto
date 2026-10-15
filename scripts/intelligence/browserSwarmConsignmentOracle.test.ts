import { describe, expect, it } from "vitest";
import {
  buildConsignmentScenario,
  CONSIGNMENT_FIGURES,
  discriminatesApprovedFromPrice,
  evaluateConsignmentEconomics,
  evaluateSupplierPayable,
  expectedConsignedRevenueMinor,
  fundingContributionMinor,
  netShortfallMinor,
  priceBasisRevenueMinor,
  toMinor,
  type ConsignmentExpectation,
  type ConsignmentLine,
  type SupplierPayableRow,
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
const DIRECT: ConsignmentExpectation = { ...THROUGH, route: "DIRECT_TO_SUPPLIER" };

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

const violationsOf = (lines: ConsignmentLine[], expectation = THROUGH): string =>
  evaluateConsignmentEconomics(expectation, lines).violations.join("\n");
const unjudgedOf = (expectation: ConsignmentExpectation, lines: ConsignmentLine[] = correctThrough()): string =>
  evaluateConsignmentEconomics(expectation, lines).unjudged.join("\n");

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
    // A non-canonical code is unknown, so it fails closed instead of being judged against canonical lines.
    expect(toMinor(5, "jod")).toBeNull();
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
    expect(violationsOf(lines)).toMatch(/supplier payable is 14000000/);
  });

  it("is a violation when a supplier receivable appears on a through-dealership sale", () => {
    const lines = [...correctThrough(), line("RECEIVABLE_FROM_SUPPLIERS", 5_000_000, 0)];
    expect(violationsOf(lines)).toMatch(/receivable from the supplier was posted/);
  });

  it("is a violation when a line is in the wrong currency or scale", () => {
    const lines = correctThrough();
    lines[2] = line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000, "USD", 2);
    expect(violationsOf(lines)).toMatch(/denominated USD at scale 2, not JOD at scale 3/);
  });
});

describe("CONS-1 oracle: contribution is contra-revenue", () => {
  const WITH_CONTRIBUTION: ConsignmentExpectation = { ...THROUGH, priceMinor: 18_000_000, approvedMinor: 18_000_000, contributionMinor: 875_000 };

  // The financier transfers the FULL approval (c21031, SCRUM-411): the receivable is A, and the
  // contribution is contra-revenue owed onward to it. The commission is the gross spread A − E.
  const correctWithContribution = (): ConsignmentLine[] => [
    line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 18_000_000, 0),
    line("SALES_CONSIDERATION_REDUCTIONS", 875_000, 0),
    line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, 875_000),
    line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
    line("CONSIGNMENT_COMMISSION_REVENUE", 0, 3_000_000),
  ];

  it("passes when the contribution is contra-revenue owed onward to a financier that transfers the full approval", () => {
    expect(evaluateConsignmentEconomics(WITH_CONTRIBUTION, correctWithContribution())).toEqual({ violations: [], unjudged: [] });
  });

  it("is a violation when the contribution leaves revenue gross", () => {
    const verdict = evaluateConsignmentEconomics(WITH_CONTRIBUTION, [
      line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 18_000_000, 0),
      line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, 3_000_000),
    ]);
    expect(verdict.violations.join("\n")).toMatch(/recognized revenue is 3000000 minor units, expected 2125000/);
    expect(verdict.violations.join("\n")).toMatch(/not posted as contra-revenue/);
    expect(verdict.violations.join("\n")).toMatch(/payable to the financing company is 0 minor units, expected 875000/);
  });

  it("is a violation when the financier's receivable is netted of the contribution instead of the full approval", () => {
    const lines = correctWithContribution();
    lines[0] = line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 17_125_000, 0);
    lines.splice(2, 1);
    const out = violationsOf(lines, WITH_CONTRIBUTION);
    expect(out).toMatch(/receivable from the financing company is 17125000 minor units, expected the full approval 18000000/);
    expect(out).toMatch(/payable to the financing company is 0 minor units, expected 875000/);
  });

  it("is a violation when the contribution is not owed onward to the financier", () => {
    const lines = correctWithContribution();
    lines[2] = line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, 800_000);
    lines[4] = line("CONSIGNMENT_COMMISSION_REVENUE", 0, 3_075_000);
    expect(violationsOf(lines, WITH_CONTRIBUTION)).toMatch(
      /payable to the financing company is 800000 minor units, expected 875000/,
    );
  });
});

describe("CONS-1 oracle: the customer's deposit is forwarded to the financier", () => {
  const WITH_DEPOSIT: ConsignmentExpectation = { ...THROUGH, depositForwardMinor: 1_000_000 };
  const correctWithDeposit = (): ConsignmentLine[] => [
    line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 20_000_000, 0),
    line("CUSTOMER_DEPOSITS_LIABILITY", 1_000_000, 0),
    line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, 1_000_000),
    line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
    line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000),
  ];

  it("passes when the released deposit is owed onward and the receivable stays the full approval", () => {
    expect(evaluateConsignmentEconomics(WITH_DEPOSIT, correctWithDeposit())).toEqual({ violations: [], unjudged: [] });
  });

  it("is a violation when the deposit is released but not owed onward", () => {
    const lines = correctWithDeposit();
    lines.splice(2, 1);
    lines[0] = line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 19_000_000, 0);
    const out = violationsOf(lines, WITH_DEPOSIT);
    expect(out).toMatch(/payable to the financing company is 0 minor units, expected 1000000/);
    expect(out).toMatch(/receivable from the financing company is 19000000 minor units, expected the full approval 20000000/);
  });

  it("is a violation when a deposit is released that the scenario never took", () => {
    const lines = [...correctThrough(), line("CUSTOMER_DEPOSITS_LIABILITY", 1_000, 0), line("BANK_ACCOUNT", 0, 1_000)];
    expect(violationsOf(lines)).toMatch(/customer deposit released is 1000 minor units, expected 0/);
  });
});

describe("CONS-1 oracle: unmodelled shapes fail closed", () => {
  it("is unjudged when the financier approved less than the price and the scenario states no customer gap", () => {
    expect(unjudgedOf({ ...THROUGH, approvedMinor: 19_000_000 })).toMatch(/states no customer gap/);
  });

  it("is unjudged when the stated gap exceeds the shortfall", () => {
    expect(unjudgedOf({ ...THROUGH, approvedMinor: 19_000_000, customerGapMinor: 2_000_000 })).toMatch(/exceeds the shortfall/);
  });

  it("is unjudged for a direct-to-supplier sale with a deposit or a customer gap", () => {
    expect(unjudgedOf({ ...DIRECT, depositForwardMinor: 1 })).toMatch(/not modelled/);
    expect(unjudgedOf({ ...DIRECT, approvedMinor: 19_000_000, customerGapMinor: 1_000_000 })).toMatch(/not modelled/);
  });

  it("is unjudged for a settlement route the oracle does not model", () => {
    expect(unjudgedOf({ ...THROUGH, route: "VIA_ESCROW" as unknown as ConsignmentExpectation["route"] })).toMatch(/route .* is not modelled/);
  });

  it("is unjudged when an extra amount is not a whole minor amount", () => {
    expect(unjudgedOf({ ...THROUGH, depositForwardMinor: -1 })).toMatch(/deposit forward .* not a whole non-negative/);
  });
});

describe("CONS-1 oracle: direct-to-supplier route", () => {
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

describe("CONS-1 oracle: B1 — an allowlist of accounts and exact per-route amounts", () => {
  it("is a violation when a balanced pair hides on accounts the route may not touch", () => {
    const out = violationsOf([...correctThrough(), line("DEFERRED_REVENUE", 3_000_000, 0), line("PREPAID_EXPENSES", 0, 3_000_000)]);
    expect(out).toMatch(/DEFERRED_REVENUE .* not an account a through-dealership consigned sale may post to/);
    expect(out).toMatch(/PREPAID_EXPENSES .* not an account/);
  });

  it("is a violation when the vehicle is receivable from the customer instead of the financing company", () => {
    const lines = correctThrough();
    lines[0] = line("ACCOUNTS_RECEIVABLE_CUSTOMERS", 20_000_000, 0);
    const out = violationsOf(lines);
    expect(out).toMatch(/receivable from the financing company is 0 minor units, expected the full approval 20000000/);
    expect(out).toMatch(/receivable from the customer is 20000000 minor units, expected the gap 0/);
  });

  it("is a violation when the financing company's receivable is not the approved amount", () => {
    const lines = correctThrough();
    lines[0] = line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 19_000_000, 0);
    expect(violationsOf(lines)).toMatch(/receivable from the financing company is 19000000 minor units, expected the full approval 20000000/);
  });

  it("is a violation when the contra account is used although no contribution was made", () => {
    const out = violationsOf([...correctThrough(), line("SALES_CONSIDERATION_REDUCTIONS", 1_000, 0)]);
    expect(out).toMatch(/contra-revenue reduction is 1000 minor units, expected 0/);
  });

  it("is a violation when the posting does not balance, however right each account looks", () => {
    const lines = correctThrough();
    lines[2] = line("CONSIGNMENT_COMMISSION_REVENUE", 0, 4_000_000);
    expect(violationsOf(lines)).toMatch(/journal does not balance: debits 20000000, credits 19000000/);
  });

  it("is a violation when each journal is unbalanced although their sum balances", () => {
    const out = violationsOf([
      { ...line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 20_000_000, 0), entryId: "je-1" },
      { ...line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000), entryId: "je-1" },
      { ...line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000), entryId: "je-2" },
    ]);
    expect(out).toMatch(/journal je-1 does not balance: debits 20000000, credits 15000000/);
    expect(out).toMatch(/journal je-2 does not balance: debits 0, credits 5000000/);
  });

  it("is a violation when a financing-company receivable appears on a direct-to-supplier sale", () => {
    const out = violationsOf(
      [
        line("RECEIVABLE_FROM_SUPPLIERS", 5_000_000, 0),
        line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000),
        line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 1_000, 0),
        line("BANK_ACCOUNT", 0, 1_000),
      ],
      DIRECT,
    );
    expect(out).toMatch(/ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES .* not an account a direct-to-supplier consigned sale may post to/);
  });

  it("is unjudged, never clean, for a direct-to-supplier contribution whose counter-side is not modelled", () => {
    const verdict = evaluateConsignmentEconomics({ ...DIRECT, priceMinor: 18_000_000, approvedMinor: 18_000_000, contributionMinor: 875_000 }, [
      line("RECEIVABLE_FROM_SUPPLIERS", 3_000_000, 0),
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, 3_000_000),
    ]);
    expect(verdict.unjudged.join("\n")).toMatch(/direct-to-supplier .* contribution/);
  });
});

describe("CONS-1 oracle: B2 — line amounts are nonnegative safe integers with at most one nonzero side", () => {
  const withExtra = (extra: ConsignmentLine): string =>
    violationsOf([...correctThrough(), extra]);

  it("is a violation for a negative amount", () => {
    expect(withExtra(line("ACCOUNTS_PAYABLE_SUPPLIERS", -5, 0))).toMatch(/ACCOUNTS_PAYABLE_SUPPLIERS line .* not a nonnegative safe integer/);
  });

  it("is a violation for a fractional amount", () => {
    expect(withExtra(line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 0.5))).toMatch(/not a nonnegative safe integer/);
  });

  it("is a violation for an amount beyond the safe integer range", () => {
    expect(withExtra(line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, Number.MAX_SAFE_INTEGER + 2))).toMatch(/not a nonnegative safe integer/);
  });

  it("is a violation for a line with both sides nonzero", () => {
    expect(withExtra(line("ACCOUNTS_PAYABLE_SUPPLIERS", 7, 7))).toMatch(/ACCOUNTS_PAYABLE_SUPPLIERS line carries both a debit and a credit/);
  });

  it("cannot pass when a negative debit offsets an overstated credit to the right net", () => {
    const lines = correctThrough();
    lines[1] = line("ACCOUNTS_PAYABLE_SUPPLIERS", -1_000, 14_001_000);
    expect(violationsOf(lines)).toMatch(/not a nonnegative safe integer/);
  });
});

describe("CONS-1 oracle: B3 — the approved basis is told from the price basis only when they differ", () => {
  it("reports whether the scenario can discriminate the approved amount from the price", () => {
    expect(discriminatesApprovedFromPrice(THROUGH)).toBe(false);
    // Approved < price is NOT enough: a customer gap that fills the difference leaves both bases identical.
    expect(discriminatesApprovedFromPrice({ ...THROUGH, approvedMinor: 19_000_000, customerGapMinor: 1_000_000 })).toBe(false);
    // Approved + gap < price is: the two bases differ by exactly price − (approved + gap).
    expect(discriminatesApprovedFromPrice({ ...THROUGH, approvedMinor: 18_000_000, customerGapMinor: 1_000_000 })).toBe(true);
  });

  // The financier approved 19,000 of the 20,000 price; the customer owes the 1,000 gap.
  // Approved + gap equals the price here, so this is a posting check, not a price-basis discriminator.
  const GAP: ConsignmentExpectation = { ...THROUGH, approvedMinor: 19_000_000, customerGapMinor: 1_000_000 };
  const correctGap = (): ConsignmentLine[] => [
    line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 19_000_000, 0),
    line("ACCOUNTS_RECEIVABLE_CUSTOMERS", 1_000_000, 0),
    line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
    line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000),
  ];

  it("passes an approved < price sale whose gap is the customer's receivable", () => {
    expect(evaluateConsignmentEconomics(GAP, correctGap())).toEqual({ violations: [], unjudged: [] });
  });

  it("is a violation when the whole price is owed by the financier although it approved less", () => {
    const out = evaluateConsignmentEconomics(GAP, [
      line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 20_000_000, 0),
      line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000),
    ]).violations.join("\n");
    expect(out).toMatch(/receivable from the financing company is 20000000 minor units, expected the full approval 19000000/);
    expect(out).toMatch(/receivable from the customer is 0 minor units, expected the gap 1000000/);
  });

  it("is a violation when the gap is not the dealership's to collect", () => {
    const lines = correctGap();
    lines[1] = line("ACCOUNTS_RECEIVABLE_CUSTOMERS", 600_000, 0);
    lines[3] = line("CONSIGNMENT_COMMISSION_REVENUE", 0, 4_600_000);
    const out = violationsOf(lines, GAP);
    expect(out).toMatch(/recognized revenue is 4600000 minor units, expected 5000000/);
    expect(out).toMatch(/receivable from the customer is 600000 minor units, expected the gap 1000000/);
  });
});

// The v3 discriminating scenario, written out by hand (JOD minor units): a 20,000 car the supplier is
// owed 15,000 for, quoted at 20,000 to an 85% financier that approves 18,000, a 200 deposit (the first
// payment), a net shortfall of 1,700 of which the customer pays 1,000 in cash and the dealership absorbs 700.
const V3: ConsignmentExpectation = {
  currency: "JOD",
  priceMinor: 20_000_000,
  approvedMinor: 18_000_000,
  entitlementMinor: 15_000_000,
  contributionMinor: 2_500_000,
  route: "THROUGH_DEALERSHIP",
  depositForwardMinor: 200_000,
  customerGapMinor: 1_000_000,
};

const correctV3 = (): ConsignmentLine[] => [
  line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 18_000_000, 0),
  line("ACCOUNTS_RECEIVABLE_CUSTOMERS", 1_000_000, 0),
  line("CUSTOMER_DEPOSITS_LIABILITY", 200_000, 0),
  line("SALES_CONSIDERATION_REDUCTIONS", 2_500_000, 0),
  line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, 2_700_000),
  line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000_000),
  line("CONSIGNMENT_COMMISSION_REVENUE", 0, 4_000_000),
];

/** The same sale posted with its margin measured on the 20,000 price: balanced, and wrong by price − (approved + gap). */
const priceBasisV3 = (): ConsignmentLine[] => {
  const lines = correctV3();
  lines[1] = line("ACCOUNTS_RECEIVABLE_CUSTOMERS", 2_000_000, 0);
  lines[6] = line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000_000);
  return lines;
};

describe("CONS-1 v3: approved + the customer's gap differs from the price, so the price basis is caught", () => {
  it("derives expected revenue 1,500 and price-basis revenue 2,500 by hand, differing by price − (approved + gap)", () => {
    // 18,000 + 1,000 − 15,000 − 2,500 = 1,500 against 20,000 − 15,000 − 2,500 = 2,500.
    expect(expectedConsignedRevenueMinor(V3)).toBe(1_500_000);
    expect(priceBasisRevenueMinor(V3)).toBe(2_500_000);
    expect(priceBasisRevenueMinor(V3) - expectedConsignedRevenueMinor(V3)).toBe(
      V3.priceMinor - (V3.approvedMinor + (V3.customerGapMinor ?? 0)),
    );
    expect(discriminatesApprovedFromPrice(V3)).toBe(true);
  });

  it("passes the correct posting: debits and credits both 21,700, no invoice needed", () => {
    expect(evaluateConsignmentEconomics(V3, correctV3())).toEqual({ violations: [], unjudged: [] });
    const lines = correctV3();
    expect(lines.reduce((sum, l) => sum + l.debitMinor, 0)).toBe(21_700_000);
    expect(lines.reduce((sum, l) => sum + l.creditMinor, 0)).toBe(21_700_000);
  });

  it("is a violation, naming the price basis, when a balanced posting measures the margin on the sale price", () => {
    const lines = priceBasisV3();
    expect(lines.reduce((sum, l) => sum + l.debitMinor, 0)).toBe(lines.reduce((sum, l) => sum + l.creditMinor, 0));
    const verdict = evaluateConsignmentEconomics(V3, lines);
    expect(verdict.unjudged).toEqual([]);
    const out = verdict.violations.join("\n");
    expect(out).toMatch(/recognized revenue is 2500000 minor units, expected 1500000/);
    expect(out).toMatch(/the margin was measured on the sale price 20000000 instead of the approved amount plus the customer's gap/);
    expect(out).toMatch(/commission revenue is 5000000 minor units, expected the margin 4000000/);
    expect(out).toMatch(/receivable from the customer is 2000000 minor units, expected the gap 1000000/);
  });

  it("would not tell the two bases apart if the customer's gap filled the difference", () => {
    const filled: ConsignmentExpectation = { ...V3, approvedMinor: 19_000_000, contributionMinor: 0, depositForwardMinor: 0 };
    expect(expectedConsignedRevenueMinor(filled)).toBe(priceBasisRevenueMinor(filled));
    expect(discriminatesApprovedFromPrice(filled)).toBe(false);
  });

  it("is a violation when the deposit is released but the forward owed onward omits it", () => {
    const lines = correctV3();
    lines[4] = line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, 2_500_000);
    lines[6] = line("CONSIGNMENT_COMMISSION_REVENUE", 0, 4_200_000);
    expect(violationsOf(lines, V3)).toMatch(/payable to the financing company is 2500000 minor units, expected 2700000/);
  });
});

describe("CONS-1 v3: the scenario builder", () => {
  it("builds the hand-written scenario from the production figures", () => {
    const built = buildConsignmentScenario("JOD");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.scenario).toEqual({
      expectation: V3,
      quotationMinor: 20_000_000,
      ltvPercent: 85,
      firstPaymentMinor: 200_000,
      depositMinor: 200_000,
      shortfallMinor: 1_700_000,
      customerShareMinor: 1_000_000,
      dealerShareMinor: 700_000,
      forwardDueMinor: 2_700_000,
    });
    expect(discriminatesApprovedFromPrice(built.scenario.expectation)).toBe(true);
  });

  it("derives the owner's worked example: 12,500 → 11,500 at 85% with a 500 first payment", () => {
    expect(fundingContributionMinor(12_500_000, 85, 500_000)).toBe(1_375_000);
    expect(fundingContributionMinor(11_500_000, 85, 500_000)).toBe(1_225_000);
    expect(netShortfallMinor(12_500_000, 11_500_000, 85, 500_000)).toBe(850_000);
  });

  it("derives the scenario's net shortfall (1,700), smaller than the gross gap (2,000)", () => {
    expect(netShortfallMinor(20_000_000, 18_000_000, 85, 200_000)).toBe(1_700_000);
    expect(fundingContributionMinor(20_000_000, 85, 200_000)).toBe(2_800_000);
    expect(fundingContributionMinor(18_000_000, 85, 200_000)).toBe(2_500_000);
  });

  it("returns null for an LTV that is not whole or does not give whole minor amounts", () => {
    expect(fundingContributionMinor(1_000, 85.5, 0)).toBeNull();
    expect(fundingContributionMinor(1_000, 101, 0)).toBeNull();
    expect(fundingContributionMinor(1_000, -1, 0)).toBeNull();
    expect(fundingContributionMinor(10, 85, 0)).toBeNull();
  });

  it("refuses a scenario with no shortfall, or a customer share beyond it, and one that cannot be expressed", () => {
    const noShortfall = buildConsignmentScenario("JOD", { ...CONSIGNMENT_FIGURES, approvedMajor: 20_000 });
    expect(noShortfall.ok).toBe(false);
    expect(!noShortfall.ok && noShortfall.reason).toMatch(/net shortfall/);
    const tooMuch = buildConsignmentScenario("JOD", { ...CONSIGNMENT_FIGURES, customerGapMajor: 1_701 });
    expect(tooMuch.ok).toBe(false);
    expect(!tooMuch.ok && tooMuch.reason).toMatch(/must be positive and cover the customer's share/);
    const noScale = buildConsignmentScenario("XXX");
    expect(noScale.ok).toBe(false);
    expect(!noScale.ok && noScale.reason).toMatch(/no known minor-unit scale/);
    const notWhole = buildConsignmentScenario("JOD", { ...CONSIGNMENT_FIGURES, depositMajor: 0.0005 });
    expect(notWhole.ok).toBe(false);
    expect(!notWhole.ok && notWhole.reason).toMatch(/cannot be expressed in whole minor units/);
  });

  it("refuses, before anything is seeded, a scenario the oracle could never judge", () => {
    const noMargin = buildConsignmentScenario("JOD", { ...CONSIGNMENT_FIGURES, entitlementMajor: 18_000 });
    expect(noMargin.ok).toBe(false);
    expect(!noMargin.ok && noMargin.reason).toMatch(/positive margin/);
    const approvedAbovePrice = buildConsignmentScenario("JOD", { ...CONSIGNMENT_FIGURES, priceMajor: 17_000 });
    expect(approvedAbovePrice.ok).toBe(false);
    expect(!approvedAbovePrice.ok && approvedAbovePrice.reason).toMatch(/positive margin/);
  });
});

describe("CONS-1: the canonical supplier payable row", () => {
  // The 15,000 entitlement of the same 20,000 car, as `vehicleSupplierPayables` records it (major units).
  const subject = { saleId: "sale-1", vehicleId: "veh-1" };
  const row = (over: Partial<SupplierPayableRow> = {}): SupplierPayableRow => ({
    id: "pay-1",
    saleId: "sale-1",
    vehicleId: "veh-1",
    currency: "JOD",
    amountDueMajor: 15_000,
    amountPaidMajor: 0,
    status: "PENDING",
    ...over,
  });
  const judged = (rows: SupplierPayableRow[], expectation = THROUGH) => evaluateSupplierPayable(expectation, subject, rows);

  it("accepts exactly one unpaid row for the sale and car that owes the independent 15,000", () => {
    expect(judged([row()])).toEqual({ violations: [], unjudged: [] });
    for (const status of ["PENDING", "NOT_YET_DUE", "DUE_ON_SALE"]) expect(judged([row({ status })]).violations).toEqual([]);
  });

  it("ignores another sale's row for another car, whatever it owes", () => {
    const unrelated = row({ id: "pay-2", saleId: "sale-2", vehicleId: "veh-2", amountDueMajor: 1 });
    expect(judged([unrelated, row()]).violations).toEqual([]);
  });

  it("rejects a sale with no payable row, even though the journal credits the supplier", () => {
    expect(judged([]).violations).toEqual([expect.stringMatching(/no supplier payable row exists for sale sale-1.*15000000/)]);
    expect(judged([row({ saleId: "sale-2", vehicleId: "veh-2" })]).violations).toEqual([expect.stringMatching(/no supplier payable row/)]);
  });

  it("rejects an amount that is not the entitlement, by a single minor unit and by a whole thousand", () => {
    expect(judged([row({ amountDueMajor: 14_999.999 })]).violations).toEqual([
      expect.stringMatching(/owes 14999999 minor units, expected the supplier's entitlement 15000000/),
    ]);
    expect(judged([row({ amountDueMajor: 14_000 })]).violations).toEqual([expect.stringMatching(/owes 14000000/)]);
    // Minor units mistaken for major units is a thousand-fold error.
    expect(judged([row({ amountDueMajor: 15_000_000 })]).violations).toEqual([expect.stringMatching(/owes 15000000000/)]);
    // The sale price is not the entitlement.
    expect(judged([row({ amountDueMajor: 20_000 })]).violations).toEqual([expect.stringMatching(/owes 20000000/)]);
  });

  it("rejects an amount that is not whole at the currency's scale", () => {
    expect(judged([row({ amountDueMajor: 15_000.0004 })]).violations).toEqual([expect.stringMatching(/not whole in JOD/)]);
  });

  it("rejects another currency once, without comparing its figure at the wrong scale", () => {
    expect(judged([row({ currency: "USD" })]).violations).toEqual([expect.stringMatching(/is denominated USD, not JOD/)]);
  });

  it("rejects a row attached to another sale, to another vehicle, or stray beside the right one", () => {
    expect(judged([row({ saleId: "sale-2" })]).violations).toEqual([
      expect.stringMatching(/is for this car but names sale sale-2, not sale sale-1/),
      expect.stringMatching(/no supplier payable row exists/),
    ]);
    expect(judged([row({ saleId: null })]).violations).toEqual([
      expect.stringMatching(/is for this car but names no sale/),
      expect.stringMatching(/no supplier payable row exists/),
    ]);
    expect(judged([row({ vehicleId: "veh-2" })]).violations).toEqual([expect.stringMatching(/is for vehicle veh-2, not the sold car veh-1/)]);
    expect(judged([row(), row({ id: "pay-9", saleId: "sale-0" })]).violations).toEqual([
      expect.stringMatching(/pay-9 is for this car but names sale sale-0/),
    ]);
  });

  it("rejects two rows for one sale", () => {
    expect(judged([row(), row({ id: "pay-2" })]).violations).toEqual([
      expect.stringMatching(/2 supplier payable rows exist for sale sale-1, expected exactly one/),
    ]);
  });

  it("rejects a payable that is paid, partly paid, disputed or cancelled, or that records a payment, on a sale just completed", () => {
    for (const status of ["PAID", "PARTIALLY_PAID", "DISPUTED", "CANCELLED", "UNKNOWN"]) {
      expect(judged([row({ status })]).violations).toEqual([expect.stringMatching(new RegExp(`has status ${status}, expected an unpaid one`))]);
    }
    expect(judged([row({ amountPaidMajor: 100 })]).violations).toEqual([expect.stringMatching(/records 100 already paid/)]);
  });

  it("is unjudged, never clean, for an expectation it cannot judge and for the route it does not model", () => {
    expect(judged([row()], { ...THROUGH, currency: "XXX" }).unjudged).toEqual([expect.stringMatching(/no known minor-unit scale/)]);
    expect(judged([row()], DIRECT)).toEqual({ violations: [], unjudged: [expect.stringMatching(/direct-to-supplier.*not modelled/)] });
  });
});
