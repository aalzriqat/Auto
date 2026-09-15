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
  customerPaidToDealer: { heldDepositMinor: 500_000, gapCashToDealerMinor: 200_000, totalMinor: 700_000 },
  customerFirstPaymentMinor: 1_000_000,
  financier: { fundedPortionMinor: 9_350_000, outstanding: { state: "OUTSTANDING", amountMinor: 4_000_000, basis: "RECEIVABLE" } },
  dealerOutlay: {
    plannedContributionMinor: 1_650_000,
    recordedCostsMinor: 150_000,
    awaitingActuals: 1,
    knownCommittedMinor: 1_800_000,
    expectedCostsRemainingMinor: 250_000,
    totalExpectedMinor: 2_050_000,
  },
  supplier: { consigned: true, direction: "DEALERSHIP_OWES", amountMinor: 9_000_000, route: "THROUGH_DEALERSHIP" },
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
    expect(fact("overview-customer-paid").getByText("700 JOD")).toBeTruthy();
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
          dealerOutlay: { ...summary.dealerOutlay, expectedCostsRemainingMinor: null, totalExpectedMinor: null },
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
        awaitingActuals: 0,
        knownCommittedMinor: null,
        expectedCostsRemainingMinor: null,
        totalExpectedMinor: null,
      },
      supplier: { consigned: null, direction: "UNKNOWN", amountMinor: null, route: "UNKNOWN" },
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
        basis={{ ...basis, available: true, consigned: true, landedCostMinor: null, expenses: [], eligibleExpensesMinor: 0, totalBeforeDealMinor: 9_500_000 }}
        money={money}
        formatDate={formatDate}
        t={tAr}
      />
    );
    expect(screen.getByText(salesAr.CostBasisBaseConsigned)).toBeTruthy();
    expect(screen.getByText(salesAr.CostBasisNoExpenses)).toBeTruthy();
    expect(screen.queryByText(salesAr.CostBasisLanded)).toBeNull();
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
