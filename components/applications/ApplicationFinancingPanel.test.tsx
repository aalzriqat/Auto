/**
 * What the finance application screen says a deal IS, on the screen where the
 * operator now decides which balance sheet it posts.
 *
 * `quotes.saveQuote` refuses a `companyId` on every mode except
 * CONFIGURED_FINANCE_COMPANY, so `applications.get` returns `company: null` for
 * every MANUAL_FINANCE_COMPANY deal by construction. The panel branched on that
 * row and therefore labelled an externally financed deal **"Cash Deal"** —
 * immediately above the fieldset asking whether the financier or the dealership
 * pays the supplier, a question it had just said did not apply. Its disbursement
 * status was hidden for the same reason.
 *
 * That label was inert while a manual deal could not choose the route here. It
 * stopped being inert the moment it could: the operator reads "cash", picks
 * THROUGH_DEALERSHIP, and the deal books a customer receivable at gross plus a
 * supplier payable on money the financier paid the supplier directly. Wrong
 * books, reached through a choice the screen induced.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ code: "JOD", format: (n: number) => `JD ${n}` }),
}));

const stubs = vi.hoisted(() => ({ queryResults: new Map<string, unknown>() }));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    useMutation: () => vi.fn(),
  };
});

const { queryResults } = stubs;

import { ApplicationDetailsDialog } from "./ApplicationDetailsDialog";

const APP_ID = "app1" as Id<"financeApplications">;

/**
 * The shape `applications.get` returns for an APPROVED consigned deal financed
 * by a manual provider — `company` null, the provider's name only in the
 * submission snapshot, and the server's own verdict that it CAN settle direct.
 */
function manualFinancedApplication(overrides: Record<string, unknown> = {}) {
  return {
    _id: APP_ID,
    orgId: "org1",
    createdAt: Date.UTC(2026, 7, 1),
    status: "APPROVED",
    companyId: undefined,
    company: null,
    quoteModeAtSubmission: "MANUAL_FINANCE_COMPANY",
    manualFinanceSnapshot: { providerName: "Cairo Amman Finance" },
    hasExternalFinancier: true,
    canSettleDirectToSupplier: true,
    directRouteRefusal: null,
    supplierSettlementRoute: undefined,
    vehicle: { sourceType: "SOURCED", sourcedFromName: "Amman Importer Co" },
    customer: { firstName: "Buyer", lastName: "One" },
    salesperson: { name: "Seller" },
    quote: { downPayment: 3_000, termMonths: 48, monthlyInstallment: 400, vehiclePrice: 20_000, totalFinancedAmount: 17_000 },
    deposits: [],
    ...overrides,
  };
}

function renderDialog(app: unknown) {
  queryResults.set("applications:get", app);
  queryResults.set("documents:getForApplication", []);
  queryResults.set("applications:getLog", []);
  return render(
    <ApplicationDetailsDialog applicationId={APP_ID} open onOpenChange={() => {}} />
  );
}

afterEach(() => {
  cleanup();
  queryResults.clear();
});

describe("a consigned deal financed by a manual provider", () => {
  test("is not described as a cash deal", () => {
    renderDialog(manualFinancedApplication());

    // The defect: `company` is null, so the panel fell to its cash branch.
    expect(screen.queryByText(/CashDeal/)).toBeNull();
  });

  test("names the financier from the submission snapshot", () => {
    renderDialog(manualFinancedApplication());

    expect(screen.getByText("Cairo Amman Finance")).toBeTruthy();
  });

  test("shows the supplier disbursement status once it settles direct", () => {
    renderDialog(
      manualFinancedApplication({
        status: "CLOSED",
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      })
    );

    // Gated on `expectsFinanceCompanyDisbursement`, which requires a
    // `companyId`, this line was unreachable for the whole population — so the
    // screen showed nothing that could contradict a wrong route choice.
    expect(screen.getByText(/DisbursementStatus/)).toBeTruthy();
  });
});

describe("a deal with no outside financier", () => {
  test("is still described as a cash deal", () => {
    renderDialog(
      manualFinancedApplication({
        quoteModeAtSubmission: "CASH",
        manualFinanceSnapshot: undefined,
        hasExternalFinancier: false,
        canSettleDirectToSupplier: false,
        directRouteRefusal: "NoExternalFinancier",
      })
    );

    expect(screen.getByText(/CashDeal/)).toBeTruthy();
  });
});
