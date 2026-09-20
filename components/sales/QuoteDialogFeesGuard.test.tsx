import { beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Doc, Id } from "../../convex/_generated/dataModel";

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
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

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    usePaginatedQuery: () => ({
      results: [
        {
          _id: "cust1",
          firstName: "Test",
          lastName: "Customer",
          phone: "0790000000",
        },
      ],
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

beforeEach(() => {
  cleanup();
  stubs.queryResults.clear();

  stubs.queryResults.set("vehicles:listAll", [
    {
      _id: VEHICLE,
      orgId: ORG,
      year: 2024,
      make: "Toyota",
      model: "Camry",
      sellingPrice: 10_000,
      status: "AVAILABLE",
    },
  ] as unknown as Doc<"vehicles">[]);

  stubs.queryResults.set("finance:listCompanies", [
    {
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
      // Deliberately absent: undefined means execution fees are not configured.
      adminFees: undefined,
      acceptedStatuses: [],
    },
  ] as unknown as Doc<"financeCompanies">[]);

  stubs.queryResults.set("documents:listRules", []);
  stubs.queryResults.set("finance:listValuations", []);
  stubs.queryResults.set("orgCustomerStatuses:list", [
    {
      _id: STATUS,
      orgId: ORG,
      label: "Salary Slip",
      isActive: true,
      order: 1,
    },
  ] as unknown as Doc<"orgCustomerStatuses">[]);
});

describe("QuoteDialog execution-fee fail-closed rendering", () => {
  test("renders the fees-not-configured state without dereferencing absent finance values", async () => {
    render(
      <QuoteDialog
        open
        onOpenChange={() => {}}
        defaultVehicleId={VEHICLE}
        defaultCustomerId="cust1"
      />
    );

    fireEvent.change(screen.getByLabelText("VehiclePriceJOD"), {
      target: { value: "10000" },
    });

    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() => {
      expect(screen.getByText("No Fee Finance")).not.toBeNull();
      expect(screen.getAllByText("FeesNotConfigured").length).toBeGreaterThan(0);
    });
  });
});
