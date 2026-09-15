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
    expect(dealerBorneExpected("NO_TEMPLATES", [], "JOD")).toEqual({ totalMinor: null, remainingMinor: null, reason: "NO_POLICY" });
    expect(dealerBorneExpected("NO_SNAPSHOT", [], "JOD")).toEqual({ totalMinor: null, remainingMinor: null, reason: "NO_POLICY" });
  });

  test("mixed payers: DEALER and EMPLOYEE count, CUSTOMER and FINANCE_COMPANY do not", () => {
    const result = dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
      row({ paidBy: "DEALER", expectedAmountMinor: 250_000 }),
      row({ paidBy: "EMPLOYEE", expectedAmountMinor: 90_000 }),
      row({ paidBy: "CUSTOMER", expectedAmountMinor: 120_000 }),
      row({ paidBy: "FINANCE_COMPANY", expectedAmountMinor: 175_000 }),
    ], "JOD");
    expect(result).toEqual({ totalMinor: 340_000, remainingMinor: 340_000, reason: null });
  });

  test("partial actuals: remaining is expected − recorded per row, floored at zero; a bare row retires nothing", () => {
    const result = dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
      row({ paidBy: "DEALER", expectedAmountMinor: 250_000, actual: actual(100_000) }),
      row({ paidBy: "DEALER", expectedAmountMinor: 90_000, actual: actual(120_000) }),
      row({ paidBy: "EMPLOYEE", expectedAmountMinor: 60_000, actual: actual(undefined) }),
      row({ paidBy: "CUSTOMER", expectedAmountMinor: 500_000, actual: actual(10_000) }),
    ], "JOD");
    expect(result).toEqual({ totalMinor: 400_000, remainingMinor: 150_000 + 0 + 60_000, reason: null });
  });

  test("a fully recorded policy has zero remaining, and the total still says what was configured", () => {
    const result = dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
      row({ paidBy: "DEALER", expectedAmountMinor: 250_000, actual: actual(250_000) }),
    ], "JOD");
    expect(result).toEqual({ totalMinor: 250_000, remainingMinor: 0, reason: null });
  });

  test("a matched actual in another currency withholds the expected side — never netted, never zero", () => {
    const foreign = { ...actual(100_000)!, currency: "USD" };
    const result = dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
      row({ paidBy: "DEALER", expectedAmountMinor: 250_000, actual: foreign }),
      row({ paidBy: "DEALER", expectedAmountMinor: 90_000 }),
    ], "JOD");
    expect(result).toEqual({ totalMinor: null, remainingMinor: null, reason: "MIXED_DENOMINATION" });
    // A foreign actual on a CUSTOMER-borne row is not the dealership's outlay and does not withhold it.
    const customerForeign = dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
      row({ paidBy: "CUSTOMER", expectedAmountMinor: 250_000, actual: foreign }),
      row({ paidBy: "DEALER", expectedAmountMinor: 90_000 }),
    ], "JOD");
    expect(customerForeign).toEqual({ totalMinor: 90_000, remainingMinor: 90_000, reason: null });
  });

  test("an UNPLANNED dealer-borne line in another currency withholds the expected side, though no configured row can see it", () => {
    const rows = [row({ paidBy: "DEALER", expectedAmountMinor: 250_000, actual: actual(250_000) })];
    expect(dealerBorneExpected("COMPANY_RULE_SNAPSHOT", rows, "JOD", false)).toEqual({
      totalMinor: 250_000,
      remainingMinor: 0,
      reason: null,
    });
    expect(dealerBorneExpected("COMPANY_RULE_SNAPSHOT", rows, "JOD", true)).toEqual({
      totalMinor: null,
      remainingMinor: null,
      reason: "MIXED_DENOMINATION",
    });
  });

  test("unsafe or corrupt amounts withhold the expected side", () => {
    expect(
      dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [row({ paidBy: "DEALER", expectedAmountMinor: Number.NaN })], "JOD")
    ).toEqual({ totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" });
    expect(
      dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [row({ paidBy: "DEALER", expectedAmountMinor: -1 })], "JOD")
    ).toEqual({ totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" });
    expect(
      dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
        row({ paidBy: "DEALER", expectedAmountMinor: 100, actual: actual(Number.POSITIVE_INFINITY) }),
      ], "JOD")
    ).toEqual({ totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" });
    // Two safe expectations whose SUM leaves the safe range.
    expect(
      dealerBorneExpected("COMPANY_RULE_SNAPSHOT", [
        row({ paidBy: "DEALER", expectedAmountMinor: Number.MAX_SAFE_INTEGER }),
        row({ paidBy: "EMPLOYEE", expectedAmountMinor: Number.MAX_SAFE_INTEGER }),
      ], "JOD")
    ).toEqual({ totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" });
  });
});
