import { beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Doc, Id } from "../../convex/_generated/dataModel";

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  translate: (key: string) => key,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  // QuoteDialog intentionally depends on `t` in the comparison effect. The
  // production provider keeps that callback stable; this mock must preserve the
  // same identity contract or every render retriggers the effect and creates an
  // artificial render loop (which coverage eventually reports as a V8 OOM).
  useLanguage: () => ({
    t: stubs.translate,
    locale: "en",
    isRtl: false,
  }),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: any) => <>{children}</>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    usePaginatedQuery: () => ({
      results: [{ _id: "cust1", firstName: "Test", lastName: "Customer", phone: "0790000000" }],
      status: "Exhausted",
      loadMore: vi.fn(),
    }),
    useMutation: () => vi.fn(),
  };
});

import { QuoteDialog } from "./QuoteDialog";

const ORG = "org1" as Id<"organizations">;
const VEHICLE = "veh1" as Id<"vehicles">;
const STATUS = "status1" as Id<"orgCustomerStatuses">;
const COMPANY = "company1" as Id<"financeCompanies">;

class ResizeObserverMock {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  cleanup();
  stubs.queryResults.clear();

  stubs.queryResults.set("vehicles:listAll", [{
    _id: VEHICLE, orgId: ORG, year: 2024, make: "Toyota", model: "Camry",
    sellingPrice: 10_000, status: "AVAILABLE",
  }] as unknown as Doc<"vehicles">[]);

  stubs.queryResults.set("finance:listCompanies", [{
    _id: COMPANY,
    orgId: ORG,
    name: "No Fee Finance",
    isActive: true,
    profitRate: 5,
    maxTermMonths: 84,
    gracePeriodMonths: 0,
    insuranceRate: 0,
    commission: 0,
    includesCommissionInDebt: false,
    maxFinancingLTV: 0,
    adminFees: undefined,
    acceptedStatuses: [],
  }] as unknown as Doc<"financeCompanies">[]);

  stubs.queryResults.set("documents:listRules", []);
  stubs.queryResults.set("finance:listValuations", []);
  stubs.queryResults.set("orgCustomerStatuses:list", [{
    _id: STATUS, orgId: ORG, label: "Salary Slip", isActive: true, order: 1,
  }] as unknown as Doc<"orgCustomerStatuses">[]);
});

describe("QuoteDialog execution-fee fail-closed rendering", () => {
  test("renders the fees-not-configured state without dereferencing absent finance values", async () => {
    render(<QuoteDialog open onOpenChange={() => {}} defaultVehicleId={VEHICLE} defaultCustomerId="cust1" />);

    fireEvent.change(screen.getByLabelText("VehiclePriceJOD"), { target: { value: "10000" } });
    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() => {
      expect(screen.getByText("No Fee Finance")).not.toBeNull();
      expect(screen.getAllByText("FeesNotConfigured").length).toBeGreaterThan(0);
    });
  });

  test("uses numeric typed form values when deriving the minimum down payment", async () => {
    stubs.queryResults.set("finance:listCompanies", [{
      _id: COMPANY,
      orgId: ORG,
      name: "LTV Finance",
      isActive: true,
      profitRate: 0,
      maxTermMonths: 84,
      gracePeriodMonths: 0,
      insuranceRate: 0,
      commission: 0,
      includesCommissionInDebt: false,
      maxFinancingLTV: 50,
      adminFees: 0,
      acceptedStatuses: [],
    }] as unknown as Doc<"financeCompanies">[]);
    stubs.queryResults.set("finance:listValuations", [{
      _id: "valuation1",
      orgId: ORG,
      companyId: COMPANY,
      vehicleId: VEHICLE,
      valuationAmount: 10_000,
    }] as unknown as Doc<"vehicleValuations">[]);

    render(<QuoteDialog open onOpenChange={() => {}} defaultVehicleId={VEHICLE} defaultCustomerId="cust1" />);

    fireEvent.change(screen.getByLabelText("VehiclePriceJOD"), { target: { value: "10000" } });
    fireEvent.change(screen.getByLabelText("DownPayment"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() => {
      expect(screen.getByText(/MinDownPayment/).textContent).toContain("5,000.00 JOD");
    });
  });
});
