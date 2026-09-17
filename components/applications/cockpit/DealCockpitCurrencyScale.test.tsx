import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { FinancingPlanPanel, type FinancingPlanFacts } from "./FinancingPlanPanel";
import { DealFinancialOverview, type FinancialSummaryData } from "./DealFinancialOverview";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  queryArgs: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  permissions: new Set<string>(),
  orgCurrencyCode: "JOD",
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en-US" }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: stubs.orgCurrencyCode,
    symbol: stubs.orgCurrencyCode === "JOD" ? "JD" : "$",
    displayLabel: stubs.orgCurrencyCode,
    format: (n: number) => `${n} ${stubs.orgCurrencyCode}`,
    scale: stubs.orgCurrencyCode === "JOD" ? 3 : 2,
  }),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: () => true,
    isLoading: false,
    membership: { userId: "user_sales" },
    isOwner: true,
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      return stubs.queryResults.get(name);
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      let fn = stubs.mutations.get(name);
      if (!fn) {
        fn = vi.fn(async () => "ok");
        stubs.mutations.set(name, fn);
      }
      return fn;
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DealCockpit } from "./DealCockpit";

const ORG = "org1" as Id<"organizations">;
const APP = "app_scale_test" as Id<"financeApplications">;
const COCKPIT_QUERY = "dealWorkspace:financedDealCockpit";
const APP_QUERY = "applications:get";
const COSTS_QUERY = "financeDealCosts:listDealCosts";
const CANDIDATES_QUERY = "financeDealCosts:listCustodyCandidates";

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
    stubs.queryResults.clear();
    stubs.queryArgs.clear();
    stubs.mutations.clear();
    stubs.orgCurrencyCode = "JOD";
  });

  describe("Direct FinancingPlanPanel unit tests", () => {
    test("JOD (scale 3): 25,000,000 minor renders exactly as 25,000.000 JOD and NOT 250,000", () => {
      const currency = "JOD";
      const scale = scaleForCurrency(currency);
      expect(scale).toBe(3);

      const targetSellingAmountMinor = 25_000_000;
      const customerFirstPaymentMinor = 5_000_000;
      const economicsFactor = Math.pow(10, scale); // 1000

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
      expect(within(card).getByText("25,000.000 JOD")).toBeDefined();
      expect(within(card).getByText("5,000.000 JOD")).toBeDefined();
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
      expect(within(card).getByText("25,000.00 USD")).toBeDefined();
      expect(within(card).getByText("5,000.00 USD")).toBeDefined();
      expect(card.textContent).not.toContain("250,000");
    });
  });

  describe("DealFinancialOverview financial summary card", () => {
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

      const customerPriceFact = screen.getByTestId("overview-sale-price");
      expect(within(customerPriceFact).getByText("25,000.000 JOD")).toBeDefined();
      expect(customerPriceFact.textContent).not.toContain("250,000");

      const downPaymentFact = screen.getByTestId("overview-first-payment");
      expect(within(downPaymentFact).getByText("5,000.000 JOD")).toBeDefined();

      const financierBalanceFact = screen.getByTestId("overview-financier-balance");
      expect(within(financierBalanceFact).getByText("20,000.000 JOD")).toBeDefined();
    });
  });

  describe("DealCockpit Container Wiring (Production Binding Seal)", () => {
    test("DealCockpit parses targetSellingAmountMinor 25,000,000 and customerFirstPaymentMinor 5,000,000 in JOD (scale 3) to render 25,000.000 JOD and 5,000.000 JOD", () => {
      stubs.orgCurrencyCode = "JOD";
      stubs.queryResults.set(COCKPIT_QUERY, {
        dealKind: "FINANCED",
        dealRef: APP,
        applicationId: APP,
        saleId: null,
        canonicalSaleId: null,
        status: "APPROVED",
        financeCompanyName: "Islamic International Arab Bank",
        stages: [{ key: "HANDOVER", state: "CURRENT" }],
        documents: [],
        timeline: [],
        money: null,
      });

      stubs.queryResults.set(APP_QUERY, {
        _id: APP,
        status: "APPROVED",
        salespersonId: "user_sales",
        economicsCurrency: "JOD",
        targetSellingAmountMinor: 25_000_000,
        customerFirstPaymentMinor: 5_000_000,
        quote: {
          vehiclePrice: 0,
          downPayment: 0,
          termMonths: 48,
          monthlyInstallment: 450,
          totalFinancedAmount: 20000,
        },
        customer: {
          nationalId: "9901020304",
        },
      });

      stubs.queryResults.set(COSTS_QUERY, {
        currency: "JOD",
        fees: [],
        summary: { lineCount: 0 },
        expected: null,
      });

      stubs.queryResults.set(CANDIDATES_QUERY, { candidates: [] });

      render(<DealCockpit orgId={ORG} applicationId={APP} />);

      const planCard = screen.getByTestId("deal-financing-plan");
      expect(planCard).toBeDefined();

      // The production DealCockpit MUST divide 25_000_000 by economicsFactor (1000 for JOD) to get 25,000.000 JOD
      expect(within(planCard).getByText("25,000.000 JOD")).toBeDefined();

      // The production DealCockpit MUST divide 5_000_000 by economicsFactor (1000 for JOD) to get 5,000.000 JOD
      expect(within(planCard).getByText("5,000.000 JOD")).toBeDefined();

      // Ensure the old bug value (dividing by 100 which produced 250,000) does NOT appear
      expect(planCard.textContent).not.toContain("250,000");
    });

    test("DealCockpit parses targetSellingAmountMinor 2,500,000 and customerFirstPaymentMinor 500,000 in USD (scale 2) to render 25,000.00 USD and 5,000.00 USD", () => {
      stubs.orgCurrencyCode = "USD";
      stubs.queryResults.set(COCKPIT_QUERY, {
        dealKind: "FINANCED",
        dealRef: APP,
        applicationId: APP,
        saleId: null,
        canonicalSaleId: null,
        status: "APPROVED",
        financeCompanyName: "Capital Auto Finance",
        stages: [{ key: "HANDOVER", state: "CURRENT" }],
        documents: [],
        timeline: [],
        money: null,
      });

      stubs.queryResults.set(APP_QUERY, {
        _id: APP,
        status: "APPROVED",
        salespersonId: "user_sales",
        economicsCurrency: "USD",
        targetSellingAmountMinor: 2_500_000,
        customerFirstPaymentMinor: 500_000,
        quote: {
          vehiclePrice: 0,
          downPayment: 0,
          termMonths: 36,
          monthlyInstallment: 600,
          totalFinancedAmount: 20000,
        },
        customer: {
          nationalId: "123456789",
        },
      });

      stubs.queryResults.set(COSTS_QUERY, {
        currency: "USD",
        fees: [],
        summary: { lineCount: 0 },
        expected: null,
      });

      stubs.queryResults.set(CANDIDATES_QUERY, { candidates: [] });

      render(<DealCockpit orgId={ORG} applicationId={APP} />);

      const planCard = screen.getByTestId("deal-financing-plan");
      expect(planCard).toBeDefined();

      // 2,500,000 minor in USD / 100 = 25,000.00 USD
      expect(within(planCard).getByText("25,000.00 USD")).toBeDefined();

      // 500,000 minor in USD / 100 = 5,000.00 USD
      expect(within(planCard).getByText("5,000.00 USD")).toBeDefined();

      expect(planCard.textContent).not.toContain("250,000");
    });
  });
});
