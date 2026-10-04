/**
 * SCRUM-609 — the review step is the last look before a quote is saved.
 *
 * F-03: it must show the figures the salesperson is committing to — the sale
 * price and the down payment — not only what the financier derives from them.
 * F-25: a financed quote whose down payment covers the whole sale price has no
 * financing left; the review must say so and refuse to generate, instead of
 * rendering negative figures behind an enabled button.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Doc, Id } from "@/convex/_generated/dataModel";

const ORG = "org_1" as Id<"organizations">;
const VEHICLE = "vehicle_1" as Id<"vehicles">;
const COMPANY = "company_1" as Id<"financeCompanies">;

const stubs = vi.hoisted(() => ({
  saveQuote: vi.fn(async () => "quote_1"),
  orgSettings: null as null | { currency: string },
  rules: [] as unknown[] | undefined,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: ORG }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "vehicles:listAll") {
        return (args as { status?: string }).status === "AVAILABLE"
          ? [{ _id: VEHICLE, orgId: ORG, make: "Kia", model: "K5", year: 2022, sellingPrice: 11_100 }]
          : [];
      }
      if (name === "finance:listCompanies") {
        return [
          {
            _id: COMPANY,
            orgId: ORG,
            name: "Bindar",
            adminFees: 250,
            commission: 0,
            profitRate: 5,
            insuranceRate: 0,
            gracePeriodMonths: 0,
            maxTermMonths: 84,
            includesCommissionInDebt: true,
          },
        ];
      }
      if (name === "documents:listRules") return stubs.rules;
      if (name === "orgSettings:get") return stubs.orgSettings;
      return null;
    },
    useMutation: () => stubs.saveQuote,
  };
});
vi.mock("../components/ReviewVehicleCard", () => ({ default: () => null }));
vi.mock("../components/ReviewVehicleListCard", () => ({ default: () => null }));
vi.mock("../components/ReviewCustomerCard", () => ({ default: () => null }));

import { Step3Review } from "./Step3Review";
import { OTHER_COMPANY_ID } from "../types";

const customer = { _id: "customer_1", firstName: "QA", lastName: "TEST" } as unknown as Doc<"customers">;

function renderReview(downPayment: number, selectedCompanyId: string = COMPANY) {
  return render(
    <Step3Review
      paymentType="INSTALLMENT"
      wizardData={{
        vehicleId: VEHICLE,
        vehiclePrice: 11_100,
        desiredProfit: 500,
        downPayment,
        termMonths: 48,
        selectedCompanyId,
        manualProfitRate: 5,
        manualExecutionFees: 250,
        customerStatuses: [],
      }}
      selectedCustomer={customer}
      onBack={vi.fn()}
      onSuccess={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  stubs.saveQuote.mockClear();
  stubs.orgSettings = null;
  stubs.rules = [];
});

describe("Step3Review — committed deal terms (SCRUM-609 F-03)", () => {
  test("shows the sale price and the down payment of a financed quote", () => {
    renderReview(3_000);

    const terms = screen.getByTestId("review-deal-terms");
    expect(within(terms).getByText("SalePrice")).toBeTruthy();
    expect(within(terms).getByText(/11,600\.00/)).toBeTruthy();
    expect(within(terms).getByText("DownPayment")).toBeTruthy();
    expect(within(terms).getByText(/3,000\.00/)).toBeTruthy();
  });

  test("labels every amount with the organization's currency, not a hard-coded JOD", () => {
    stubs.orgSettings = { currency: "SAR" };
    renderReview(3_000);

    const terms = screen.getByTestId("review-deal-terms");
    expect(within(terms).getAllByText(/SAR/)).toHaveLength(2);
    expect(screen.queryByText(/JOD/)).toBeNull();
  });
});

describe("Step3Review — required documents (SCRUM-628 F-08)", () => {
  test("a finance company with no required documents says so instead of an empty box", () => {
    renderReview(3_000);

    expect(screen.getByText("RequiredDocuments")).toBeTruthy();
    expect(screen.getByText("NoRequiredDocuments")).toBeTruthy();
  });

  test("while the rules load it says so, never that nothing is required", () => {
    stubs.rules = undefined;
    renderReview(3_000);

    expect(screen.getByText("Loading")).toBeTruthy();
    expect(screen.queryByText("NoRequiredDocuments")).toBeNull();
  });

  const RULES = [
    { _id: "rule_org", documentName: "QA National ID", isRequired: true },
    { _id: "rule_co", companyId: COMPANY, documentName: "QA Bindar Form", isRequired: true },
    { _id: "rule_other_co", companyId: "company_2", documentName: "QA Rival Form", isRequired: true },
  ];

  test("a finance company lists its own and org-wide documents, each once", () => {
    stubs.rules = RULES;
    renderReview(3_000);

    expect(screen.getAllByText("QA National ID")).toHaveLength(1);
    expect(screen.getAllByText("QA Bindar Form")).toHaveLength(1);
    expect(screen.queryByText("QA Rival Form")).toBeNull();
    expect(screen.getAllByText("RequiredDocuments")).toHaveLength(1);
  });

  test("the Other provider still lists the org-wide documents every deal needs", () => {
    stubs.rules = RULES;
    renderReview(3_000, OTHER_COMPANY_ID);

    expect(screen.getAllByText("QA National ID")).toHaveLength(1);
    expect(screen.queryByText("QA Bindar Form")).toBeNull();
    expect(screen.queryByText("NoRequiredDocuments")).toBeNull();
  });
});

describe("Step3Review — down payment covering the price (SCRUM-609 F-25)", () => {
  test("refuses to generate and shows no negative financing", () => {
    renderReview(15_000);

    const generate = screen.getByRole("button", { name: /GenerateQuote/ });
    expect((generate as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("DownPaymentMustBeBelowPrice");
    expect(screen.queryByText(/-\d/)).toBeNull();

    fireEvent.click(generate);
    expect(stubs.saveQuote).not.toHaveBeenCalled();
  });

  test("a down payment equal to the price is refused the same way", () => {
    renderReview(11_600);

    expect((screen.getByRole("button", { name: /GenerateQuote/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a down payment below the price still generates", async () => {
    renderReview(3_000);

    const generate = screen.getByRole("button", { name: /GenerateQuote/ });
    expect((generate as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(generate);
    await waitFor(() => expect(stubs.saveQuote).toHaveBeenCalledTimes(1));
  });
});
