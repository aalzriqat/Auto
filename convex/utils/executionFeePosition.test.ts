import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import {
  executionFeeBindRefusal,
  executionFeeExpectation,
  executionFeeHeadline,
  executionFeePosition,
  executionFeeRefusal,
  executionFeeUnrecorded,
  executionFeeWithheld,
} from "./executionFeePosition";
import { deriveManagementProfit, deriveStockManagementProfit } from "./financingEconomics";

/**
 * SCRUM-690 F-PNTR-1 (rulings c22113 / c22119). The #pntr deal: the finance
 * company's frozen execution fee is 700 JOD, and the only recorded dealership
 * cost is a 550 ownership transfer. The old headline took
 * `max(expected 700, actual 550)` = 700, so the unrelated 550 silently
 * CONSUMED the fee and the estimate understated the cost by 550. The fee is
 * a separate dealership payment; only a line LINKED to it retires it.
 */

const JOD = "JOD";
const FEE_MINOR = 700_000;
const TRANSFER_MINOR = 550_000;

type App = Parameters<typeof executionFeePosition>[0];
type Line = Parameters<typeof executionFeePosition>[1][number];

function app(overrides: Partial<Doc<"financeApplications">> = {}): App {
  return {
    companyRuleSnapshot: { adminFees: 700 } as Doc<"financeApplications">["companyRuleSnapshot"],
    manualFinanceSnapshot: undefined,
    quoteModeAtSubmission: "CONFIGURED_FINANCE_COMPANY",
    estimatedDealerBorneExpensesMinor: undefined,
    ...overrides,
  } as App;
}

function line(id: string, overrides: Partial<Line> = {}): Line {
  return {
    _id: id as Id<"financeDealFees">,
    voidedAt: undefined,
    feeType: "FINANCE_COMPANY_FEE",
    paidBy: "DEALER",
    paidTo: "FINANCE_COMPANY",
    currency: JOD,
    deductedFromSettlement: false,
    accountingTreatment: "FINANCE_COMPANY_COMMISSION",
    actualAmountMinor: FEE_MINOR,
    executionFeeBinding: undefined,
    ...overrides,
  } as Line;
}

const BINDING = { boundAt: 1, boundBy: "u1" as Id<"users"> };
const transfer = line("transfer", {
  feeType: "OWNERSHIP_TRANSFER",
  accountingTreatment: "SELLING_EXPENSE",
  actualAmountMinor: TRANSFER_MINOR,
} as Partial<Line>);

describe("executionFeeExpectation", () => {
  test("reads the configured snapshot's adminFees at the currency's scale", () => {
    expect(executionFeeExpectation(app(), JOD)).toEqual({ applies: true, source: "CONFIGURED", expectedMinor: FEE_MINOR });
  });
  test("a zero or absent fee is not a position", () => {
    expect(executionFeeExpectation(app({ companyRuleSnapshot: { adminFees: 0 } } as never), JOD)).toEqual({ applies: false });
    expect(executionFeeExpectation(app({ companyRuleSnapshot: undefined }), JOD)).toEqual({ applies: false });
  });
  test("manual snapshot only on a manual deal", () => {
    const manual = { companyRuleSnapshot: undefined, manualFinanceSnapshot: { adminFees: 50 } } as never;
    expect(executionFeeExpectation(app(manual), JOD)).toEqual({ applies: false });
    expect(
      executionFeeExpectation(app({ ...(manual as object), quoteModeAtSubmission: "MANUAL_FINANCE_COMPANY" } as never), JOD)
    ).toEqual({ applies: true, source: "MANUAL", expectedMinor: 50_000 });
  });
  test("an unreadable fee still applies and fails closed (expectedMinor null)", () => {
    const position = executionFeePosition(app({ companyRuleSnapshot: { adminFees: Number.NaN } } as never), [], JOD);
    expect(position).toMatchObject({ applies: true, expectedMinor: null, unrecordedMinor: null });
    expect(executionFeeHeadline(position)).toEqual({ withheld: true });
  });
});

describe("executionFeePosition — the #pntr shape", () => {
  test("an unrelated dealership cost does NOT retire the fee", () => {
    const position = executionFeePosition(app(), [transfer], JOD);
    expect(position).toMatchObject({ applies: true, bound: null, unrecordedMinor: FEE_MINOR, ambiguous: false });
    expect(executionFeeUnrecorded(position)).toBe(true);
    expect(executionFeeRefusal(position, "finalizing")?.code).toBe("CONFIGURED_FEES_MISSING");
    expect(executionFeeHeadline(position)).toEqual({ unrecordedMinor: FEE_MINOR });
  });

  test("an UNBOUND finance-company fee of the exact amount does not retire it either — binding is explicit", () => {
    const position = executionFeePosition(app(), [line("fee")], JOD);
    expect(position).toMatchObject({ bound: null, unrecordedMinor: FEE_MINOR });
  });

  test("a bound actual retires the whole expectation, whatever its amount — an explicit 0 included", () => {
    for (const actual of [FEE_MINOR, 400_000, 0]) {
      const position = executionFeePosition(app(), [transfer, line("fee", { actualAmountMinor: actual, executionFeeBinding: BINDING })], JOD);
      expect(position).toMatchObject({ bound: { feeId: "fee", actualMinor: actual }, unrecordedMinor: 0 });
      expect(executionFeeUnrecorded(position)).toBe(false);
      expect(executionFeeRefusal(position, "finalizing")).toBeNull();
      expect(executionFeeHeadline(position)).toEqual({ unrecordedMinor: 0 });
    }
  });

  test("a voided bound line is unrecorded again", () => {
    const position = executionFeePosition(app(), [line("fee", { executionFeeBinding: BINDING, voidedAt: 5 })], JOD);
    expect(position).toMatchObject({ bound: null, unrecordedMinor: FEE_MINOR, ambiguous: false });
  });

  test("two bound lines, or one incompatible bound line, are ambiguous: unrecorded and withheld", () => {
    const two = executionFeePosition(
      app(),
      [line("a", { executionFeeBinding: BINDING }), line("b", { executionFeeBinding: BINDING })],
      JOD
    );
    expect(two).toMatchObject({ ambiguous: true, bound: null });
    expect(executionFeeHeadline(two)).toEqual({ withheld: true });
    expect(executionFeeWithheld(executionFeeHeadline(two))).toBe(true);

    const deducted = executionFeePosition(app(), [line("a", { executionFeeBinding: BINDING, deductedFromSettlement: true })], JOD);
    expect(deducted).toMatchObject({ ambiguous: true, bound: null });
    expect(executionFeeUnrecorded(deducted)).toBe(true);
  });

  test("a frozen dealer-borne aggregate that differs from the fee withholds the estimate (c22119 Q3)", () => {
    const conflict = executionFeePosition(app({ estimatedDealerBorneExpensesMinor: 1_250_000 }), [transfer], JOD);
    expect(conflict).toMatchObject({ aggregateConflict: true });
    expect(executionFeeHeadline(conflict)).toEqual({ withheld: true });
    const agrees = executionFeePosition(app({ estimatedDealerBorneExpensesMinor: FEE_MINOR }), [transfer], JOD);
    expect(executionFeeHeadline(agrees)).toEqual({ unrecordedMinor: FEE_MINOR });
  });

  test("no position: headline null, nothing unrecorded, no refusal", () => {
    const none = executionFeePosition(app({ companyRuleSnapshot: undefined }), [transfer], JOD);
    expect(none).toEqual({ applies: false });
    expect(executionFeeHeadline(none)).toBeNull();
    expect(executionFeeWithheld(executionFeeHeadline(none))).toBe(false);
    expect(executionFeeRefusal(none, "finalizing")).toBeNull();
  });
});

describe("executionFeePosition — deals finalized before the position existed (Opus seat F-1)", () => {
  // The legacy shape: the fee recorded under another handover type, already
  // paid; the deal finalized before binding existed. No door can bind it now.
  const legacyFee = line("legacy", {
    feeType: "OTHER_CLOSING_EXPENSE",
    accountingTreatment: "SELLING_EXPENSE",
  } as Partial<Line>);
  const sale = "sale1" as Id<"sales">;

  test("a finalized deal with nothing bound keeps its settled reading: no position, no headline operand", () => {
    for (const frozen of [{ status: "CLOSED", finalizedSaleId: sale }, { finalizedSaleId: sale }, { status: "CLOSED" }] as const) {
      const position = executionFeePosition(app(frozen as Partial<Doc<"financeApplications">>), [legacyFee], JOD);
      expect(position).toEqual({ applies: false });
      expect(executionFeeUnrecorded(position)).toBe(false);
      expect(executionFeeHeadline(position)).toBeNull();
    }
  });

  test("control: the same lines on an OPEN deal still read unrecorded", () => {
    const position = executionFeePosition(app({ status: "APPROVED" }), [legacyFee], JOD);
    expect(executionFeeUnrecorded(position)).toBe(true);
  });

  test("control: a deal finalized WITH a bound line keeps its position", () => {
    const position = executionFeePosition(
      app({ status: "CLOSED", finalizedSaleId: sale }),
      [line("fee", { executionFeeBinding: BINDING })],
      JOD
    );
    expect(position).toMatchObject({ applies: true, bound: { actualMinor: FEE_MINOR }, unrecordedMinor: 0 });
  });
});

describe("executionFeeBindRefusal", () => {
  test.each([
    ["voided", { voidedAt: 1 }, /removed/],
    ["another fee type", { feeType: "OWNERSHIP_TRANSFER" }, /finance-company fee/],
    ["paid by the customer", { paidBy: "CUSTOMER" }, /paid by the dealership/],
    ["withheld from settlement", { deductedFromSettlement: true }, /separate dealership payment/],
    ["another currency", { currency: "USD" }, /USD/],
    // Codex F1: a cost paid to anyone but the finance company is not its fee.
    ["paid to the government", { paidTo: "GOVERNMENT" }, /paid to the finance company/],
    ["paid to another party", { paidTo: "OTHER" }, /paid to the finance company/],
    // ...and one booked under another treatment would post the fee to the wrong account.
    ["booked as a selling expense", { accountingTreatment: "SELLING_EXPENSE" }, /finance-company commission/],
    ["booked as an ownership transfer", { accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" }, /finance-company commission/],
    ["no actual", { actualAmountMinor: undefined }, /zero if nothing was charged/],
  ])("refuses a line %s", (_label, overrides, message) => {
    expect(executionFeeBindRefusal(line("x", overrides as Partial<Line>), JOD)).toMatch(message);
  });
  test("accepts a compatible line with an explicit 0", () => {
    expect(executionFeeBindRefusal(line("x", { actualAmountMinor: 0 }), JOD)).toBeNull();
    expect(executionFeeBindRefusal(line("x", { paidBy: "EMPLOYEE" } as Partial<Line>), JOD)).toBeNull();
  });
});

describe("profit headline basis (c22119 Q5: recorded actuals + unrecorded fee, never max)", () => {
  const consignment = {
    approvedDealerPurchaseAmountMinor: 10_850_000,
    supplierSettlementMinor: 9_000_000,
    dealerContributionMinor: 0,
    customerDirectToDealerMinor: 0,
    actualExpensesMinor: TRANSFER_MINOR,
    expectedExpensesMinor: FEE_MINOR,
    currency: JOD,
    fullySettled: false,
  };
  const expensesOf = (profit: ReturnType<typeof deriveManagementProfit>) =>
    profit.available ? profit.lines.find((l) => l.key === "FORECAST_EXPENSES" || l.key === "ACTUAL_EXPENSES") : undefined;

  test("#pntr: 550 recorded + 700 unrecorded fee = 1,250 forecast (was max = 700)", () => {
    const profit = deriveManagementProfit({ ...consignment, executionFee: { unrecordedMinor: FEE_MINOR } });
    expect(expensesOf(profit)).toEqual({ key: "FORECAST_EXPENSES", sign: -1, amountMinor: 1_250_000 });
    expect(profit.available && profit.amountMinor).toBe(10_850_000 - 9_000_000 - 1_250_000);
  });

  test("once the fee is bound, the basis is the recorded actuals alone", () => {
    const profit = deriveManagementProfit({
      ...consignment,
      actualExpensesMinor: TRANSFER_MINOR + 0,
      executionFee: { unrecordedMinor: 0 },
    });
    expect(expensesOf(profit)).toEqual({ key: "ACTUAL_EXPENSES", sign: -1, amountMinor: TRANSFER_MINOR });
  });

  test("a withheld position gives ExecutionFeeUnclassified, on both derivers", () => {
    expect(deriveManagementProfit({ ...consignment, executionFee: { withheld: true } })).toEqual({
      available: false,
      reason: "ExecutionFeeUnclassified",
    });
    expect(
      deriveStockManagementProfit({
        approvedDealerPurchaseAmountMinor: 10_850_000,
        vehicleCostMinor: 9_000_000,
        dealerContributionMinor: 0,
        actualExpensesMinor: TRANSFER_MINOR,
        currency: JOD,
        fullySettled: false,
        executionFee: { withheld: true },
      })
    ).toEqual({ available: false, reason: "ExecutionFeeUnclassified" });
  });

  test("stock deal: the same additive basis", () => {
    const profit = deriveStockManagementProfit({
      approvedDealerPurchaseAmountMinor: 10_850_000,
      vehicleCostMinor: 9_000_000,
      dealerContributionMinor: 0,
      actualExpensesMinor: TRANSFER_MINOR,
      expectedExpensesMinor: FEE_MINOR,
      currency: JOD,
      fullySettled: false,
      executionFee: { unrecordedMinor: FEE_MINOR },
    });
    expect(profit.available && profit.lines.find((l) => l.key === "FORECAST_EXPENSES")?.amountMinor).toBe(1_250_000);
  });

  test("a fully settled deal reads actuals only — the position is display-only once closed", () => {
    const profit = deriveManagementProfit({ ...consignment, fullySettled: true, executionFee: { unrecordedMinor: FEE_MINOR } });
    expect(expensesOf(profit)).toEqual({ key: "ACTUAL_EXPENSES", sign: -1, amountMinor: TRANSFER_MINOR });
  });

  test("no position: the legacy rule (max of expected and actual) is unchanged", () => {
    const profit = deriveManagementProfit({ ...consignment });
    expect(expensesOf(profit)).toEqual({ key: "FORECAST_EXPENSES", sign: -1, amountMinor: FEE_MINOR });
  });
});
