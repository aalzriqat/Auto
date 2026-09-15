import { describe, expect, test } from "vitest";
import { dealerBorneExpected } from "./dealOverview";
import type { Id } from "./_generated/dataModel";
import type { ExpectedFeeRow } from "./financeDealCosts";

/**
 * Which configured fees count as the DEALERSHIP's outlay, and how much of
 * each is still expected once actuals are recorded against it.
 */
function row(overrides: Partial<ExpectedFeeRow> & { paidBy: ExpectedFeeRow["paidBy"]; expectedAmountMinor: number }): ExpectedFeeRow {
  return {
    templateIndex: 0,
    feeType: "LICENSING",
    description: undefined,
    paidTo: "GOVERNMENT",
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
    duplicateIdentity: false,
    actual: null,
    ...overrides,
  };
}

const actual = (actualAmountMinor: number | undefined): ExpectedFeeRow["actual"] => ({
  feeId: "fee1" as Id<"financeDealFees">,
  actualAmountMinor,
  currency: "JOD",
  status: actualAmountMinor === undefined ? "UNQUANTIFIED" : "ACTUAL_RECORDED",
});

describe("dealerBorneExpected", () => {
  test("no policy: both unknown, not zero", () => {
    expect(dealerBorneExpected("NO_TEMPLATES", [])).toEqual({ totalMinor: null, remainingMinor: null });
    expect(dealerBorneExpected("NO_SNAPSHOT", [])).toEqual({ totalMinor: null, remainingMinor: null });
  });

  test("mixed payers: DEALER and EMPLOYEE count, CUSTOMER and FINANCE_COMPANY do not", () => {
    const result = dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
      row({ paidBy: "DEALER", expectedAmountMinor: 250_000 }),
      row({ paidBy: "EMPLOYEE", expectedAmountMinor: 90_000 }),
      row({ paidBy: "CUSTOMER", expectedAmountMinor: 120_000 }),
      row({ paidBy: "FINANCE_COMPANY", expectedAmountMinor: 175_000 }),
    ]);
    expect(result).toEqual({ totalMinor: 340_000, remainingMinor: 340_000 });
  });

  test("partial actuals: remaining is expected − recorded per row, floored at zero; a bare row retires nothing", () => {
    const result = dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
      row({ paidBy: "DEALER", expectedAmountMinor: 250_000, actual: actual(100_000) }),
      row({ paidBy: "DEALER", expectedAmountMinor: 90_000, actual: actual(120_000) }),
      row({ paidBy: "EMPLOYEE", expectedAmountMinor: 60_000, actual: actual(undefined) }),
      row({ paidBy: "CUSTOMER", expectedAmountMinor: 500_000, actual: actual(10_000) }),
    ]);
    expect(result).toEqual({ totalMinor: 400_000, remainingMinor: 150_000 + 0 + 60_000 });
  });

  test("a fully recorded policy has zero remaining, and the total still says what was configured", () => {
    const result = dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
      row({ paidBy: "DEALER", expectedAmountMinor: 250_000, actual: actual(250_000) }),
    ]);
    expect(result).toEqual({ totalMinor: 250_000, remainingMinor: 0 });
  });
});
