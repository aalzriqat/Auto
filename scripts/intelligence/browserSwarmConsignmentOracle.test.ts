import { describe, expect, it } from "vitest";
import {
  discriminatesApprovedFromPrice,
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
    const direct: ConsignmentExpectation = { ...THROUGH, route: "DIRECT_TO_SUPPLIER" };
    expect(unjudgedOf({ ...direct, depositForwardMinor: 1 })).toMatch(/not modelled/);
    expect(unjudgedOf({ ...direct, approvedMinor: 19_000_000, customerGapMinor: 1_000_000 })).toMatch(/not modelled/);
  });

  it("is unjudged for a settlement route the oracle does not model", () => {
    expect(unjudgedOf({ ...THROUGH, route: "VIA_ESCROW" as unknown as ConsignmentExpectation["route"] })).toMatch(/route .* is not modelled/);
  });

  it("is unjudged when an extra amount is not a whole minor amount", () => {
    expect(unjudgedOf({ ...THROUGH, depositForwardMinor: -1 })).toMatch(/deposit forward .* not a whole non-negative/);
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

describe("CONS-1 oracle: B1 — an allowlist of accounts and exact per-route amounts", () => {
  const DIRECT: ConsignmentExpectation = { ...THROUGH, route: "DIRECT_TO_SUPPLIER" };

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
    expect(discriminatesApprovedFromPrice({ ...THROUGH, approvedMinor: 19_000_000 })).toBe(true);
  });

  // The financier approved 19,000 of the 20,000 price; the customer owes the 1,000 gap.
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
