/**
 * ONE profit authority on the financed cockpit.
 *
 * The overview read model serves the route-aware headline; the cockpit's own
 * `money.profit` is the consignment-only derivation and on a STOCK deal reads
 * "no supplier settlement". Both used to paint at once. These tests pin that
 * the headline, the fact tiles and the breakdown all follow the overview's
 * figure, that the legacy figure never paints while the overview loads, and
 * that a cash deal (no overview) keeps its accounting result.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { salesEn } from "@/lib/i18n/domains/sales";
import type { DealCockpitData } from "./DealStagePresentation";
import type { FinancedDealOverviewData } from "./DealFinancialOverview";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (salesEn as Record<string, string>)[key] ?? key,
    isRtl: false,
    locale: "en",
  }),
}));
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ code: "JOD", symbol: "JD", displayLabel: "JOD", format: (n: number) => `${n} JOD`, formatCompact: String }),
}));
vi.mock("@/components/accounting/AccountingTabShared", () => ({ scaleForCurrency: () => 3 }));

import { DealCockpitView } from "./DealCockpit";

const SCALE = 1_000;
type Financed = Extract<DealCockpitData, { dealKind: "FINANCED" }>;

/** A STOCK deal whose cockpit profit is UNAVAILABLE (no supplier settlement on an owned car). */
function stockDeal(): Financed {
  return {
    dealKind: "FINANCED",
    denomination: { code: "JOD", scale: 3 },
    dealRef: "app_1",
    applicationId: "app_1" as Id<"financeApplications">,
    saleId: null,
    canonicalSaleId: null,
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1" as Id<"customers">, name: "Samer", phone: "0790112233" },
    vehicle: { id: "v1" as Id<"vehicles">, label: "Kia Sportage 2022", vin: "KNAPX81ABN7000001", consigned: false, supplierName: undefined },
    salespersonName: "Laith",
    financeCompanyName: "National Finance",
    activeAppraisalProvider: null,
    stages: [{ key: "HANDOVER", state: "CURRENT", authority: "DEALER" }],
    documents: [],
    timeline: [],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: false,
      routeKnown: true,
      profit: { available: false, reason: "NoSupplierSettlement" },
      managementProfit: { available: false, reason: "NoSupplierSettlement" },
      expenses: { lines: [], actualTotalMinor: 90 * SCALE, awaitingActuals: 0 },
      parties: [
        { party: "CUSTOMER", name: "", position: "NOT_INVOLVED", amountMinor: 0, currency: "JOD", reference: undefined },
        { party: "SUPPLIER", name: "", position: "NOT_INVOLVED", amountMinor: 0, currency: "JOD", reference: undefined },
        { party: "FINANCIER", name: "National Finance", position: "NOT_INVOLVED", amountMinor: 0, currency: "JOD" },
      ],
      supplierReceipt: { actionable: false, reason: "NOT_DIRECT_ROUTE" },
      appraisalGapMinor: undefined,
    },
    handoverEvidence: {
      approvedPurchaseAmountMinor: 12_500 * SCALE,
      financeCompanyFundedPortionMinor: 12_000 * SCALE,
      dealerContributionMinor: 500 * SCALE,
      approvedAmountIsFarFromEvidence: false,
      currency: { code: "JOD", scale: 3 },
    },
    settlementAdviceDiscrepancy: null,
    settlementAdviceRequiresReconciliation: false,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    economicsRecorded: true,
    economicsStamp: "s",
    pendingDepositResolution: false,
  } as unknown as Financed;
}

function overview(): FinancedDealOverviewData {
  return {
    financialSummary: {
      currency: "JOD",
      customerSalePrice: { amountMinor: 13_000 * SCALE, basis: "SUBMITTED_QUOTATION" },
      approvedPurchaseAmountMinor: 12_500 * SCALE,
      customerPaidToDealer: { heldDepositMinor: 0, totalMinor: 0 },
      customerGapCashPlannedMinor: null,
      customerFirstPaymentMinor: null,
      financier: { fundedPortionMinor: 12_000 * SCALE, outstanding: { state: "NOT_YET_RECEIVABLE", amountMinor: null, basis: null } },
      dealerOutlay: {
        plannedContributionMinor: 500 * SCALE,
        recordedCostsMinor: 90 * SCALE,
        recordedCostsReason: null,
        awaitingActuals: 0,
        knownCommittedMinor: 590 * SCALE,
        expectedCostsRemainingMinor: null,
        expectedCostsReason: "NO_POLICY",
        totalExpectedMinor: null,
        aggregateReason: null,
      },
      supplier: { consigned: false, direction: "NOT_INVOLVED", amountMinor: 0, route: "THROUGH_DEALERSHIP" },
      profit: {
        available: true,
        basis: "MANAGEMENT_ESTIMATE",
        amountMinor: 2_110 * SCALE,
        currency: "JOD",
        classification: "ESTIMATED_AWAITING_SETTLEMENT",
        postable: false,
        lines: [
          { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE },
          { key: "CUSTOMER_PLANNED_TO_DEALER", sign: 1, amountMinor: 0 },
          { key: "VEHICLE_COST", sign: -1, amountMinor: 9_800 * SCALE },
          { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 500 * SCALE },
          { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90 * SCALE },
        ],
      },
    },
    vehicleCostBasis: null,
    dealerPreparation: null,
  };
}

/** A genuine CASH sale — no application, an accounting result that reconciles. */
function cashDeal(): DealCockpitData {
  return {
    dealKind: "CASH",
    denomination: { code: "JOD", scale: 3 },
    dealRef: "sale_1",
    applicationId: null,
    saleId: "sale_1" as Id<"sales">,
    financingApplicationId: null,
    status: "COMPLETED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1" as Id<"customers">, name: "Samer", phone: "0790112233" },
    vehicle: { id: "v1" as Id<"vehicles">, label: "Kia Sportage 2022", vin: "KNAPX81ABN7000001", consigned: false, supplierName: undefined },
    salespersonName: "Laith",
    financeCompanyName: null,
    stages: [
      { key: "SALE_AGREED", state: "COMPLETE", authority: "DEALER" },
      { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
      { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" },
    ],
    documents: [],
    timeline: [],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: false,
      routeKnown: true,
      profit: {
        available: true,
        basis: "ACCOUNTING_RESULT",
        amountMinor: 3_000 * SCALE,
        currency: "JOD",
        reconcilesToLedger: true,
        lines: [
          { key: "SALE_PRICE", sign: 1, amountMinor: 20_000 * SCALE },
          { key: "VEHICLE_COST", sign: -1, amountMinor: 17_000 * SCALE },
        ],
      },
      expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
      parties: [],
      appraisalGapMinor: undefined,
    },
    settlementAdviceRequiresReconciliation: false,
  } as unknown as DealCockpitData;
}

const money = (minor: number, currency: string) => `${(minor / SCALE).toLocaleString("en-US")} ${currency}`;

afterEach(cleanup);

describe("one canonical profit on the financed cockpit", () => {
  test("the overview's route-aware profit drives the headline, the fact tiles and the breakdown — the legacy figure paints nowhere", () => {
    render(
      <DealCockpitView
        deal={stockDeal()}
        onRecordSupplierReceipt={async () => {}}
        financialOverview={{ data: overview(), loading: false }}
        custodyMoney={money}
      />
    );
    // Headline: the STOCK figure, not "no supplier settlement".
    expect(screen.getAllByText("2,110 JOD").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(salesEn.ProfitNeedsSupplierSettlement)).toBeNull();
    expect(screen.queryByText(salesEn.ProfitNotCalculable)).toBeNull();
    // Facts and breakdown carry the STOCK lines, including the vehicle cost.
    expect(screen.getAllByText(salesEn.LineVehicleCost).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("− 9,800 JOD").length).toBeGreaterThanOrEqual(1);
    // The overview's own net-profit row agrees with the headline.
    expect(within(screen.getByTestId("overview-net-profit")).getByText("2,110 JOD")).toBeTruthy();
  });

  test("while the overview is loading, no profit figure paints — not the legacy one either", () => {
    render(
      <DealCockpitView
        deal={stockDeal()}
        onRecordSupplierReceipt={async () => {}}
        financialOverview={{ data: undefined, loading: true }}
        custodyMoney={money}
      />
    );
    expect(screen.getByTestId("deal-financial-overview-loading")).toBeTruthy();
    expect(screen.queryByText(salesEn.ProfitNeedsSupplierSettlement)).toBeNull();
    expect(screen.queryByText(salesEn.ProfitNotCalculable)).toBeNull();
    expect(screen.queryByText("2,110 JOD")).toBeNull();
  });

  test("an overview that resolved WITHOUT a summary withholds the headline — the legacy figure is never a substitute", () => {
    for (const data of [null, { financialSummary: null, vehicleCostBasis: null, dealerPreparation: null }] as const) {
      render(
        <DealCockpitView
          deal={stockDeal()}
          onRecordSupplierReceipt={async () => {}}
          financialOverview={{ data, loading: false }}
          custodyMoney={money}
        />
      );
      expect(screen.getByTestId("deal-financial-overview-withheld")).toBeTruthy();
      expect(screen.getByText(salesEn.ProfitOverviewWithheld)).toBeTruthy();
      // Neither the consignment reason nor any figure from the cockpit's own profit paints.
      expect(screen.queryByText(salesEn.ProfitNeedsSupplierSettlement)).toBeNull();
      expect(screen.queryByTestId("deal-financial-overview-loading")).toBeNull();
      expect(screen.queryByTestId("deal-financial-overview")).toBeNull();
      cleanup();
    }
  });

  test("a NONZERO planned appraisal-gap contribution renders as planned/allocated — never as paid or received — and stays out of the receipt-backed tile", () => {
    const data = overview();
    const summary = data.financialSummary!;
    const withPlannedGap: FinancedDealOverviewData = {
      ...data,
      financialSummary: {
        ...summary,
        customerGapCashPlannedMinor: 700 * SCALE,
        profit: {
          ...(summary.profit as Extract<typeof summary.profit, { available: true; basis: "MANAGEMENT_ESTIMATE" }>),
          amountMinor: 2_810 * SCALE,
          lines: [
            { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE },
            { key: "CUSTOMER_PLANNED_TO_DEALER", sign: 1, amountMinor: 700 * SCALE },
            { key: "VEHICLE_COST", sign: -1, amountMinor: 9_800 * SCALE },
            { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 500 * SCALE },
            { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90 * SCALE },
          ],
        },
      },
    };
    const { container } = render(
      <DealCockpitView
        deal={stockDeal()}
        onRecordSupplierReceipt={async () => {}}
        financialOverview={{ data: withPlannedGap, loading: false }}
        custodyMoney={money}
      />
    );
    // The line's label says PLANNED and NOT RECEIVED, in the tiles and the breakdown.
    const labels = screen.getAllByText(salesEn.LineCustomerPlannedToDealer);
    expect(labels.length).toBeGreaterThanOrEqual(1);
    expect(salesEn.LineCustomerPlannedToDealer).toMatch(/planned/i);
    expect(salesEn.LineCustomerPlannedToDealer).toMatch(/not yet received/i);
    expect(screen.getAllByText("700 JOD").length).toBeGreaterThanOrEqual(1);
    // The retired wording paints nowhere on the screen.
    expect(container.textContent).not.toContain("Paid by the customer to the dealership");
    // The receipt-backed tile still reads the held deposits (zero here), not the plan.
    const paidTile = within(screen.getByTestId("overview-customer-paid"));
    expect(paidTile.queryByText("700 JOD")).toBeNull();
    expect(paidTile.getByText("0 JOD")).toBeTruthy();
    // ...and the overview's own planned-gap row carries the plan, labelled as allocated.
    const plannedTile = within(screen.getByTestId("overview-gap-cash-planned"));
    expect(plannedTile.getByText("700 JOD")).toBeTruthy();
    expect(plannedTile.getByText(salesEn.OverviewGapCashPlannedNote)).toBeTruthy();
  });

  test("a genuine CASH deal has no overview and keeps the accounting result the sale cockpit serves", () => {
    render(<DealCockpitView deal={cashDeal()} onRecordSupplierReceipt={async () => {}} />);
    expect(screen.getAllByText("3,000 JOD").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(salesEn.LineSalePrice).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("deal-financial-overview")).toBeNull();
    expect(screen.queryByTestId("deal-financial-overview-withheld")).toBeNull();
    expect(screen.queryByTestId("deal-financial-overview-loading")).toBeNull();
  });
});
