/**
 * The overview and cost-basis sections, rendered against server-shaped
 * payloads in both languages. Every figure shown must be one the server served
 * — the sections never add, and a `null` renders as its reason, never as zero.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import {
  DealFinancialOverview,
  VehicleCostBasisSection,
  type FinancialSummaryData,
  type VehicleCostBasisData,
} from "./DealFinancialOverview";

const tEn = (key: string) => (salesEn as Record<string, string>)[key] ?? key;
const tAr = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
const money = (minor: number, currency: string) => `${(minor / 1000).toLocaleString("en-US")} ${currency}`;
const formatDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const summary: FinancialSummaryData = {
  currency: "JOD",
  customerSalePrice: { amountMinor: 12_000_000, basis: "TARGET_SELLING_AMOUNT" },
  approvedPurchaseAmountMinor: 11_000_000,
  customerPaidToDealer: { heldDepositMinor: 500_000, totalMinor: 500_000 },
  // Agreed under the gap resolution, not received: served beside "paid", never inside it.
  customerGapCashPlannedMinor: 200_000,
  customerFirstPaymentMinor: 1_000_000,
  financier: { fundedPortionMinor: 9_350_000, outstanding: { state: "OUTSTANDING", amountMinor: 4_000_000, basis: "RECEIVABLE" } },
  dealerOutlay: {
    plannedContributionMinor: 1_650_000,
    recordedCostsMinor: 150_000,
    recordedCostsReason: null,
    awaitingActuals: 1,
    knownCommittedMinor: 1_800_000,
    expectedCostsRemainingMinor: 250_000,
    expectedCostsReason: null,
    totalExpectedMinor: 2_050_000,
    aggregateReason: null,
  },
  supplier: { consigned: true, direction: "DEALERSHIP_OWES", amountMinor: 9_000_000, route: "THROUGH_DEALERSHIP" },
  unreadable: [],
  profit: {
    available: true,
    basis: "MANAGEMENT_ESTIMATE",
    amountMinor: 1_250_000,
    currency: "JOD",
    classification: "ESTIMATED_AWAITING_SETTLEMENT",
    postable: false,
    lines: [],
  },
};

afterEach(cleanup);

describe("DealFinancialOverview", () => {
  test("renders the served facts with their notes, in English — planned, recorded and expected kept apart", () => {
    render(<DealFinancialOverview summary={summary} money={money} t={tEn} />);
    const fact = (id: string) => within(screen.getByTestId(id));
    expect(fact("overview-sale-price").getByText("12,000 JOD")).toBeTruthy();
    expect(fact("overview-sale-price").getByText(salesEn.OverviewBasisTargetSelling)).toBeTruthy();
    expect(fact("overview-customer-paid").getByText("500 JOD")).toBeTruthy();
    expect(fact("overview-financier").getByText("9,350 JOD")).toBeTruthy();
    expect(fact("overview-financier-balance").getByText("4,000 JOD")).toBeTruthy();
    expect(fact("overview-financier-balance").getByText(salesEn.OverviewFinancierOutstanding)).toBeTruthy();
    expect(fact("overview-dealer-contribution").getByText("1,650 JOD")).toBeTruthy();
    expect(fact("overview-dealer-contribution").getByText(salesEn.OverviewDealerContributionNote)).toBeTruthy();
    expect(fact("overview-costs").getByText("150 JOD")).toBeTruthy();
    expect(fact("overview-costs").getByText(/1 lines without an actual/)).toBeTruthy();
    expect(fact("overview-known-committed").getByText("1,800 JOD")).toBeTruthy();
    expect(fact("overview-expected-remaining").getByText("250 JOD")).toBeTruthy();
    expect(fact("overview-dealer-paid").getByText("2,050 JOD")).toBeTruthy();
    expect(fact("overview-supplier").getByText("9,000 JOD")).toBeTruthy();
    expect(fact("overview-supplier").getByText(/due to the supplier · through the dealership/)).toBeTruthy();
    expect(fact("overview-net-profit").getByText("1,250 JOD")).toBeTruthy();
    // Nothing on the screen calls a planned figure paid.
    expect(screen.queryByText(/paid by the dealership/i)).toBeNull();
  });

  test("before a receivable exists the financier balance is labelled an ESTIMATE from the expected remittance", () => {
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          financier: {
            fundedPortionMinor: 9_350_000,
            outstanding: { state: "ESTIMATED_PRE_RECEIVABLE", amountMinor: 9_200_000, basis: "EXPECTED_DEALER_REMITTANCE" },
          },
        }}
        money={money}
        t={tEn}
      />
    );
    const row = within(screen.getByTestId("overview-financier-balance"));
    expect(row.getByText("9,200 JOD")).toBeTruthy();
    expect(row.getByText(new RegExp(salesEn.OverviewFinancierEstimatedBasis))).toBeTruthy();
  });

  test.each([
    [tEn, "UNSAFE_AMOUNT", () => salesEn.OverviewFinancierEstimateWithheldUnreadable],
    [tEn, "MIXED_DENOMINATION", () => salesEn.OverviewFinancierEstimateWithheldMixed],
    [tAr, "UNSAFE_AMOUNT", () => salesAr.OverviewFinancierEstimateWithheldUnreadable],
    [tAr, "MIXED_DENOMINATION", () => salesAr.OverviewFinancierEstimateWithheldMixed],
  ] as const)("a withheld estimate renders no amount and names its reason — %#", (t, reason, sentence) => {
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          financier: { fundedPortionMinor: 9_350_000, outstanding: { state: "ESTIMATE_WITHHELD", amountMinor: null, basis: null, reason } },
        }}
        money={money}
        t={t}
      />
    );
    const row = within(screen.getByTestId("overview-financier-balance"));
    expect(row.getByText("—")).toBeTruthy();
    expect(row.getByText(sentence())).toBeTruthy();
    expect(row.queryByText(/9,200|NaN/)).toBeNull();
    expect(screen.queryByText(salesEn.OverviewFinancierEstimated)).toBeNull();
    expect(screen.queryByText(salesAr.OverviewFinancierEstimated)).toBeNull();
  });

  test("the financier balance is shown on its own authority even when the funded portion is not recorded", () => {
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          financier: {
            fundedPortionMinor: null,
            outstanding: { state: "OUTSTANDING", amountMinor: 4_000_000, basis: "RECEIVABLE" },
          },
        }}
        money={money}
        t={tEn}
      />
    );
    expect(within(screen.getByTestId("overview-financier")).getByText(salesEn.NotRecorded)).toBeTruthy();
    expect(within(screen.getByTestId("overview-financier-balance")).getByText("4,000 JOD")).toBeTruthy();
    cleanup();
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          financier: { fundedPortionMinor: null, outstanding: { state: "COLLECTED", amountMinor: 0, basis: "RECEIVABLE" } },
        }}
        money={money}
        t={tEn}
      />
    );
    expect(within(screen.getByTestId("overview-financier-balance")).getByText(salesEn.OverviewFinancierCollected)).toBeTruthy();
  });

  test("no fee policy: the expected side and the total read as unknown, never zero", () => {
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          dealerOutlay: { ...summary.dealerOutlay, expectedCostsRemainingMinor: null, expectedCostsReason: "NO_POLICY", totalExpectedMinor: null },
        }}
        money={money}
        t={tEn}
      />
    );
    expect(within(screen.getByTestId("overview-expected-remaining")).getByText(salesEn.OverviewNoPolicy)).toBeTruthy();
    expect(within(screen.getByTestId("overview-dealer-paid")).getByText(salesEn.OverviewNoPolicy)).toBeTruthy();
    expect(within(screen.getByTestId("overview-known-committed")).getByText("1,800 JOD")).toBeTruthy();
  });

  test("renders in Arabic with LTR-isolated figures", () => {
    render(
      <div dir="rtl">
        <DealFinancialOverview summary={summary} money={money} t={tAr} />
      </div>
    );
    expect(screen.getByText(salesAr.OverviewHeading)).toBeTruthy();
    expect(screen.getByText(salesAr.OverviewDealerPaidTotal)).toBeTruthy();
    const figure = within(screen.getByTestId("overview-dealer-paid")).getByText("2,050 JOD");
    expect(figure.tagName).toBe("BDI");
    expect(figure.getAttribute("dir")).toBe("ltr");
  });

  test("a null is its reason, never a zero", () => {
    const empty: FinancialSummaryData = {
      ...summary,
      customerSalePrice: null,
      approvedPurchaseAmountMinor: null,
      customerPaidToDealer: null,
      customerFirstPaymentMinor: null,
      financier: { fundedPortionMinor: null, outstanding: { state: "NOT_YET_RECEIVABLE", amountMinor: null, basis: null } },
      dealerOutlay: {
        plannedContributionMinor: null,
        recordedCostsMinor: 0,
        recordedCostsReason: null,
        awaitingActuals: 0,
        knownCommittedMinor: null,
        expectedCostsRemainingMinor: null,
        expectedCostsReason: "NO_POLICY",
        totalExpectedMinor: null,
        aggregateReason: null,
      },
      supplier: { consigned: null, direction: "UNKNOWN", amountMinor: null, route: "UNKNOWN" },
      unreadable: [],
      profit: { available: false, reason: "NoApprovedPurchaseAmount" },
    };
    render(<DealFinancialOverview summary={empty} money={money} t={tEn} />);
    const fact = (id: string) => within(screen.getByTestId(id));
    expect(fact("overview-sale-price").getByText(salesEn.NotRecorded)).toBeTruthy();
    expect(fact("overview-customer-paid").getByText(salesEn.OverviewCustomerPaidUnknown)).toBeTruthy();
    expect(fact("overview-dealer-paid").getByText(salesEn.OverviewDealerPaidUnknown)).toBeTruthy();
    expect(fact("overview-supplier").getByText(salesEn.OverviewSupplierUnknown)).toBeTruthy();
    expect(fact("overview-net-profit").getByText(salesEn.ProfitNotCalculable)).toBeTruthy();
    // The only zero on the screen is the one the server served (costs to date).
    expect(screen.getAllByText("0 JOD")).toHaveLength(1);
  });

  test("negotiated gap cash is never labelled paid: it is its own row, planned, and the paid figure is the held deposit alone", () => {
    render(<DealFinancialOverview summary={summary} money={money} t={tEn} />);
    const fact = (id: string) => within(screen.getByTestId(id));
    expect(fact("overview-customer-paid").getByText("500 JOD")).toBeTruthy();
    expect(fact("overview-customer-paid").getByText(salesEn.OverviewCustomerPaidNote)).toBeTruthy();
    expect(fact("overview-customer-paid").queryByText("700 JOD")).toBeNull();
    expect(fact("overview-gap-cash-planned").getByText("200 JOD")).toBeTruthy();
    expect(fact("overview-gap-cash-planned").getByText(salesEn.OverviewGapCashPlannedNote)).toBeTruthy();
    expect(screen.queryByText("700 JOD")).toBeNull();
  });

  test("a deal with no gap allocation has no planned-gap-cash row at all, in Arabic", () => {
    render(<DealFinancialOverview summary={{ ...summary, customerGapCashPlannedMinor: null }} money={money} t={tAr} />);
    expect(screen.queryByTestId("overview-gap-cash-planned")).toBeNull();
    expect(within(screen.getByTestId("overview-customer-paid")).getByText(salesAr.OverviewCustomerPaidNote)).toBeTruthy();
  });

  test("a dealer-borne line in another currency withholds costs, committed and total with the reason — never a partial total", () => {
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          dealerOutlay: {
            ...summary.dealerOutlay,
            recordedCostsMinor: null,
            recordedCostsReason: "MIXED_DENOMINATION",
            knownCommittedMinor: null,
            expectedCostsRemainingMinor: null,
            expectedCostsReason: "MIXED_DENOMINATION",
            totalExpectedMinor: null,
          },
          profit: { available: false, reason: "ExpensesMixedDenomination" },
        }}
        money={money}
        t={tEn}
      />
    );
    const fact = (id: string) => within(screen.getByTestId(id));
    for (const id of ["overview-costs", "overview-known-committed", "overview-dealer-paid"]) {
      expect(fact(id).getByText("—")).toBeTruthy();
      expect(fact(id).getByText(salesEn.OverviewCostsMixedDenomination)).toBeTruthy();
    }
    expect(fact("overview-expected-remaining").getByText(salesEn.OverviewExpectedMixedDenomination)).toBeTruthy();
    expect(fact("overview-net-profit").getByText("—")).toBeTruthy();
    expect(screen.queryByText("150 JOD")).toBeNull();
  });

  test("an unreadable recorded amount withholds costs, committed and total with ITS reason — not the mixed-currency sentence, never a corrupt total", () => {
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          dealerOutlay: {
            ...summary.dealerOutlay,
            recordedCostsMinor: null,
            recordedCostsReason: "UNSAFE_AMOUNT",
            knownCommittedMinor: null,
            totalExpectedMinor: null,
          },
          profit: { available: false, reason: "ExpensesUnreadable" },
        }}
        money={money}
        t={tEn}
      />
    );
    const fact = (id: string) => within(screen.getByTestId(id));
    for (const id of ["overview-costs", "overview-known-committed", "overview-dealer-paid"]) {
      expect(fact(id).getByText("—")).toBeTruthy();
      expect(fact(id).getByText(salesEn.OverviewCostsUnreadable)).toBeTruthy();
    }
    expect(screen.queryByText(salesEn.OverviewCostsMixedDenomination)).toBeNull();
    expect(fact("overview-net-profit").getByText("—")).toBeTruthy();
    expect(screen.queryByText("150 JOD")).toBeNull();
  });

  test("a sum outside the safe range: the operands stand, the totals are withheld with the aggregate reason", () => {
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          dealerOutlay: { ...summary.dealerOutlay, knownCommittedMinor: null, totalExpectedMinor: null, aggregateReason: "UNSAFE_AMOUNT" },
        }}
        money={money}
        t={tEn}
      />
    );
    const fact = (id: string) => within(screen.getByTestId(id));
    expect(fact("overview-costs").getByText("150 JOD")).toBeTruthy();
    for (const id of ["overview-known-committed", "overview-dealer-paid"]) {
      expect(fact(id).getByText("—")).toBeTruthy();
      expect(fact(id).getByText(salesEn.OverviewAggregateUnreadable)).toBeTruthy();
    }
    expect(screen.queryByText(salesEn.OverviewDealerPaidUnknown)).toBeNull();
  });

  test.each([tEn, tAr])("a figure the server withheld as UNREADABLE says so — never 'not recorded', never a number — %#", (t) => {
    const dictionary = t === tEn ? salesEn : salesAr;
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          customerSalePrice: null,
          approvedPurchaseAmountMinor: null,
          customerPaidToDealer: null,
          customerGapCashPlannedMinor: null,
          customerFirstPaymentMinor: null,
          financier: { fundedPortionMinor: null, outstanding: { state: "UNKNOWN", amountMinor: null, basis: null } },
          dealerOutlay: { ...summary.dealerOutlay, plannedContributionMinor: null, knownCommittedMinor: null, totalExpectedMinor: null },
          supplier: { ...summary.supplier, amountMinor: null },
          unreadable: [
            { field: "customerSalePrice", reason: "UNSAFE_AMOUNT" },
            { field: "approvedPurchaseAmount", reason: "UNSAFE_AMOUNT" },
            { field: "customerPaidToDealer", reason: "UNSAFE_AMOUNT" },
            { field: "customerGapCashPlanned", reason: "UNSAFE_AMOUNT" },
            { field: "customerFirstPayment", reason: "UNSAFE_AMOUNT" },
            { field: "financierFundedPortion", reason: "UNSAFE_AMOUNT" },
            { field: "financierOutstanding", reason: "UNSAFE_AMOUNT" },
            { field: "supplierAmount", reason: "UNSAFE_AMOUNT" },
            { field: "plannedContribution", reason: "UNSAFE_AMOUNT" },
          ],
        }}
        money={money}
        t={t}
      />
    );
    const fact = (id: string) => within(screen.getByTestId(id));
    for (const id of [
      "overview-sale-price", "overview-approved-purchase", "overview-customer-paid", "overview-gap-cash-planned",
      "overview-first-payment", "overview-financier", "overview-financier-balance", "overview-dealer-contribution", "overview-supplier",
    ]) {
      expect(fact(id).getByText("—")).toBeTruthy();
      expect(fact(id).getByText(dictionary.OverviewAmountUnreadable)).toBeTruthy();
    }
    expect(screen.queryByText(dictionary.NotRecorded)).toBeNull();
    expect(screen.queryByText(dictionary.OverviewCustomerPaidUnknown)).toBeNull();
    expect(screen.queryByText(dictionary.OverviewFinancierUnknown)).toBeNull();
    expect(screen.getByTestId("overview-unreadable-alert").textContent).toBe(dictionary.OverviewUnreadableAlert);
  });

  test("a figure that is merely absent still reads 'not recorded' — absence and corruption are different facts", () => {
    render(
      <DealFinancialOverview
        summary={{ ...summary, approvedPurchaseAmountMinor: null, customerFirstPaymentMinor: null, unreadable: [] }}
        money={money}
        t={tEn}
      />
    );
    expect(within(screen.getByTestId("overview-approved-purchase")).getByText(salesEn.NotRecorded)).toBeTruthy();
    expect(within(screen.getByTestId("overview-first-payment")).getByText(salesEn.NotRecorded)).toBeTruthy();
    expect(screen.queryByText(salesEn.OverviewAmountUnreadable)).toBeNull();
    expect(screen.queryByTestId("overview-unreadable-alert")).toBeNull();
  });

  test("the direct route says the financier pays the supplier, and an owned vehicle has no supplier", () => {
    render(
      <DealFinancialOverview
        summary={{
          ...summary,
          financier: { fundedPortionMinor: 9_350_000, outstanding: { state: "NONE_DIRECT_ROUTE", amountMinor: null, basis: null } },
          supplier: { consigned: false, direction: "NOT_INVOLVED", amountMinor: 0, route: "THROUGH_DEALERSHIP" },
        }}
        money={money}
        t={tEn}
      />
    );
    expect(within(screen.getByTestId("overview-financier-balance")).getByText(salesEn.OverviewFinancierDirectRoute)).toBeTruthy();
    expect(within(screen.getByTestId("overview-supplier")).getByText(salesEn.OverviewSupplierOwned)).toBeTruthy();
  });
});

describe("VehicleCostBasisSection", () => {
  const basis: VehicleCostBasisData = {
    available: true,
    currency: "JOD",
    consigned: false,
    baseMinor: 9_500_000,
    landedCostMinor: 100_000,
    expenses: [
      { id: "e1" as never, title: "Brake job", category: "REPAIR", date: Date.UTC(2026, 4, 1), capitalizedMinor: 100_000 },
    ],
    eligibleExpensesMinor: 100_000,
    totalBeforeDealMinor: 9_700_000,
    excluded: { pendingCount: 1, reversedCount: 0, periodExpenseCount: 2, afterCutoffCount: 0 },
    cutoffCreationTime: Date.UTC(2026, 5, 15),
    lineDetail: "SERVED",
  };

  test("itemizes the basis and says what was seen but not counted", () => {
    render(<VehicleCostBasisSection basis={basis} money={money} formatDate={formatDate} t={tEn} />);
    expect(screen.getByText(salesEn.CostBasisBase)).toBeTruthy();
    expect(screen.getByText("9,500 JOD")).toBeTruthy();
    expect(screen.getByText(salesEn.CostBasisLanded)).toBeTruthy();
    expect(screen.getByText("Brake job")).toBeTruthy();
    expect(within(screen.getByTestId("deal-cost-basis-total")).getByText("9,700 JOD")).toBeTruthy();
    expect(screen.getByTestId("deal-cost-basis-excluded").textContent).toContain("1 pending · 2 period expense");
  });

  test("a consigned vehicle labels the base as the supplier's cost, in Arabic", () => {
    render(
      <VehicleCostBasisSection
        basis={{ ...basis, consigned: true, landedCostMinor: null, expenses: [], eligibleExpensesMinor: 0, totalBeforeDealMinor: 9_500_000 }}
        money={money}
        formatDate={formatDate}
        t={tAr}
      />
    );
    expect(screen.getByText(salesAr.CostBasisBaseConsigned)).toBeTruthy();
    expect(screen.getByText(salesAr.CostBasisNoExpenses)).toBeTruthy();
    expect(screen.queryByText(salesAr.CostBasisLanded)).toBeNull();
  });

  test("a cost-only caller sees the totals and a note in place of the lines — no titles, no dates, no amounts per line", () => {
    const { expenses: _lines, ...totals } = basis;
    void _lines;
    render(
      <VehicleCostBasisSection basis={{ ...totals, lineDetail: "WITHHELD" }} money={money} formatDate={formatDate} t={tEn} />
    );
    expect(within(screen.getByTestId("deal-cost-basis-total")).getByText("9,700 JOD")).toBeTruthy();
    expect(screen.getAllByText("100 JOD").length).toBeGreaterThan(0); // the eligible-expenses AGGREGATE (and the landed cost)
    expect(screen.getByTestId("deal-cost-basis-lines-withheld").textContent).toBe(salesEn.CostBasisLinesWithheld);
    expect(screen.queryByText("Brake job")).toBeNull();
    expect(screen.queryByText("2026-05-01")).toBeNull();
    expect(screen.queryByText(salesEn.CostBasisNoExpenses)).toBeNull();
  });

  test("an unavailable basis states its reason", () => {
    render(
      <VehicleCostBasisSection
        basis={{ available: false, reason: "MIXED_DENOMINATION", currency: "USD", consigned: false }}
        money={money}
        formatDate={formatDate}
        t={tEn}
      />
    );
    expect(screen.getByText(salesEn.CostBasisMixedDenomination)).toBeTruthy();
  });
});
