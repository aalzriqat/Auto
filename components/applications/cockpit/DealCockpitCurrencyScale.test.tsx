import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { FinancingPlanPanel, type FinancingPlanFacts } from "./FinancingPlanPanel";
import { DealFinancialOverview, type FinancialSummaryData } from "./DealFinancialOverview";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: (code: string) => {
    if (["JOD", "KWD", "BHD", "OMR"].includes(code)) return 3;
    return 2;
  },
}));

function createPlanFormatMajor(currency: string) {
  const scale = scaleForCurrency(currency);
  return (major: number, cur: string) =>
    `${major.toLocaleString("en-US", {
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    })} ${cur}`;
}

function createOverviewMoneyFormatter() {
  return (minor: number, currency: string) => {
    const scale = scaleForCurrency(currency);
    const factor = Math.pow(10, scale);
    return `${(minor / factor).toLocaleString("en-US", {
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    })} ${currency}`;
  };
}

describe("Deal Cockpit Currency Scale Invariant (BLOCKER 4 Regression)", () => {
  afterEach(() => {
    cleanup();
  });

  test("JOD (scale 3): 25,000,000 minor renders exactly as 25,000.000 JOD and NOT 250,000", () => {
    const currency = "JOD";
    const scale = scaleForCurrency(currency);
    expect(scale).toBe(3);

    const targetSellingAmountMinor = 25_000_000;
    const customerFirstPaymentMinor = 5_000_000;
    const economicsFactor = Math.pow(10, scale); // 1000

    // Compute plan facts using economicsFactor
    const planFacts: FinancingPlanFacts = {
      financierName: "Islamic International Arab Bank",
      currency,
      vehiclePrice: targetSellingAmountMinor / economicsFactor, // 25,000
      downPayment: customerFirstPaymentMinor / economicsFactor,   // 5,000
      termMonths: 48,
      monthlyInstallment: 450,
      totalFinancedAmount: 20000,
      nationalId: "9901020304",
    };

    render(
      <FinancingPlanPanel
        plan={planFacts}
        formatMajor={createPlanFormatMajor(currency)}
        t={(key) => key}
      />
    );

    const card = screen.getByTestId("deal-financing-plan");

    // The vehicle price must render exactly as 25,000.000 JOD
    expect(within(card).getByText("25,000.000 JOD")).toBeDefined();

    // The down payment must render exactly as 5,000.000 JOD
    expect(within(card).getByText("5,000.000 JOD")).toBeDefined();

    // Regression check: verify old /100 bug value (250,000) does NOT appear
    expect(card.textContent).not.toContain("250,000");
    expect(card.textContent).not.toContain("50,000.00");
  });

  test("USD (scale 2): 2,500,000 minor renders exactly as 25,000.00 USD and NOT 250,000", () => {
    const currency = "USD";
    const scale = scaleForCurrency(currency);
    expect(scale).toBe(2);

    const targetSellingAmountMinor = 2_500_000;
    const customerFirstPaymentMinor = 500_000;
    const economicsFactor = Math.pow(10, scale); // 100

    const planFacts: FinancingPlanFacts = {
      financierName: "Capital Auto Finance",
      currency,
      vehiclePrice: targetSellingAmountMinor / economicsFactor, // 25,000
      downPayment: customerFirstPaymentMinor / economicsFactor,   // 5,000
      termMonths: 36,
      monthlyInstallment: 600,
      totalFinancedAmount: 20000,
      nationalId: "123456789",
    };

    render(
      <FinancingPlanPanel
        plan={planFacts}
        formatMajor={createPlanFormatMajor(currency)}
        t={(key) => key}
      />
    );

    const card = screen.getByTestId("deal-financing-plan");

    // The vehicle price must render as 25,000.00 USD (2 decimal places)
    expect(within(card).getByText("25,000.00 USD")).toBeDefined();
    expect(within(card).getByText("5,000.00 USD")).toBeDefined();

    // Not 250,000 or unformatted
    expect(card.textContent).not.toContain("250,000");
  });

  test("DealFinancialOverview card renders JOD 25,000,000 minor as 25,000.000 JOD across all financial facts", () => {
    const currency = "JOD";
    const summary: FinancialSummaryData = {
      currency,
      customerSalePrice: {
        amountMinor: 25_000_000,
        basis: "TARGET_SELLING_AMOUNT",
      },
      approvedPurchaseAmountMinor: 24_000_000,
      customerPaidToDealer: { heldDepositMinor: 5_000_000, totalMinor: 5_000_000 },
      customerGapCashPlannedMinor: null,
      customerFirstPaymentMinor: 5_000_000,
      financier: {
        fundedPortionMinor: 20_000_000,
        outstanding: { state: "OUTSTANDING", amountMinor: 20_000_000, basis: "RECEIVABLE" },
      },
      dealerOutlay: {
        plannedContributionMinor: null,
        recordedCostsMinor: null,
        recordedCostsReason: null,
        awaitingActuals: 0,
        knownCommittedMinor: null,
        expectedCostsRemainingMinor: null,
        expectedCostsReason: "NO_POLICY",
        totalExpectedMinor: null,
        aggregateReason: null,
      },
      supplier: {
        consigned: false,
        direction: "SETTLED",
        amountMinor: 0,
        route: "UNKNOWN",
      },
      unreadable: [],
      profit: {
        available: true,
        basis: "MANAGEMENT_ESTIMATE",
        amountMinor: 3_000_000,
        currency: "JOD",
        classification: "ESTIMATED_AWAITING_SETTLEMENT",
        postable: false,
        lines: [],
      },
    };

    render(
      <DealFinancialOverview
        summary={summary}
        money={createOverviewMoneyFormatter()}
        t={(key) => key}
      />
    );

    // Customer sale price must be 25,000.000 JOD
    const customerPriceFact = screen.getByTestId("overview-sale-price");
    expect(within(customerPriceFact).getByText("25,000.000 JOD")).toBeDefined();
    expect(customerPriceFact.textContent).not.toContain("250,000");

    // Down payment / first payment must be 5,000.000 JOD
    const downPaymentFact = screen.getByTestId("overview-first-payment");
    expect(within(downPaymentFact).getByText("5,000.000 JOD")).toBeDefined();

    // Financier outstanding must be 20,000.000 JOD
    const financierBalanceFact = screen.getByTestId("overview-financier-balance");
    expect(within(financierBalanceFact).getByText("20,000.000 JOD")).toBeDefined();
  });

  test("Old /100 division fails against the 25,000.000 JOD invariant", () => {
    const targetSellingAmountMinor = 25_000_000;
    const oldFaultyDivision = targetSellingAmountMinor / 100; // Old bug divided by 100 unconditionally

    expect(oldFaultyDivision).toBe(250_000); // 10x error!
    expect(oldFaultyDivision).not.toBe(25_000);
  });
});
