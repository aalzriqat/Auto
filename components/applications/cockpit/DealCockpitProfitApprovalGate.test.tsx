/**
 * SCRUM-260 (CodeRabbit, PR #347): the cockpit's minimum-profit verdict is read
 * through `approvals.profitApprovalStatus`, which requires VIEW_VEHICLES and
 * throws for anyone without it. A thrown `useQuery` takes the whole cockpit
 * down, so the read must only be subscribed for a viewer who can finalize AND
 * may read it. `completeSale` still re-proves the rule on the server for
 * everyone else.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "JD",
    displayLabel: "Jordanian Dinar",
    format: (n: number) => `JD ${n}`,
    scale: 3,
  }),
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  permissions: new Set<string>(),
  /** Every argument `profitApprovalStatus` was subscribed with, "skip" included. */
  statusArgs: [] as unknown[],
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: "user_sales" },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    // The cockpit reads closing readiness through the non-throwing useQueries (SCRUM-414 R2).
    useQueries: (queries: Record<string, { query: never }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [key, stubs.queryResults.get(getFunctionName(query))])
      ),
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      if (name === "approvals:profitApprovalStatus") {
        stubs.statusArgs.push(args);
        // The server's own refusal, as the client would receive it.
        if (args !== "skip" && !stubs.permissions.has("view:vehicles")) {
          throw new Error("Forbidden: Missing required permissions: view:vehicles");
        }
        return { status: "NOT_REQUIRED", margin: 500, minimumProfit: 0 };
      }
      return stubs.queryResults.get(name);
    },
    useMutation: () => async () => null,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";

const { queryResults, permissions, statusArgs } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;

function seedFinancedDeal() {
  queryResults.set("dealWorkspace:financedDealCockpit", {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1", name: "سامر الخطيب", phone: "0790112233" },
    vehicle: { id: "v1", label: "Volkswagen e-Golf 2020", vin: "WVWZZZAUZLW901234", consigned: false, supplierName: "" },
    salespersonName: "ليث العمري",
    financeCompanyName: "شركة التمويل الوطني",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    stages: [
      { key: "APPROVED_PURCHASE", state: "COMPLETE" },
      { key: "DELIVERY_ACTIONS", state: "COMPLETE" },
      { key: "HANDOVER", state: "CURRENT" },
      { key: "SETTLEMENT", state: "PENDING" },
    ],
    documents: [],
    timeline: [],
    money: null,
  });
  queryResults.set("applications:get", {
    _id: APP,
    vehicleId: "v1",
    quoteId: "quote_1",
    status: "APPROVED",
    salespersonId: "user_other",
    companyId: "company_1",
    economicsCurrency: "JOD",
    // A financed quote at a real price: the case the verdict read exists for.
    quote: { totalFinancedAmount: 15000, vehiclePrice: 20000, mode: "FINANCED" },
    vehicle: { sourceType: "OWNED" },
    deposits: [],
    hasExternalFinancier: true,
    canSettleDirectToSupplier: false,
    directRouteRefusal: null,
  });
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  permissions.clear();
  statusArgs.length = 0;
});

describe("the cockpit's profit-approval read", () => {
  test("a viewer without VIEW_VEHICLES never subscribes, so the cockpit still renders", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT);
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    seedFinancedDeal();

    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    expect(screen.getByTestId("deal-next-step")).toBeTruthy();
    expect(statusArgs.length).toBeGreaterThan(0);
    expect(statusArgs.every((args) => args === "skip")).toBe(true);
  });

  test("a viewer who cannot finalize never subscribes", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.VIEW_VEHICLES);
    seedFinancedDeal();

    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    expect(statusArgs.every((args) => args === "skip")).toBe(true);
  });

  test("a finalizer who may read vehicles asks about the quote's exact price", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.VIEW_VEHICLES);
    permissions.add(PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT);
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    seedFinancedDeal();

    render(<DealCockpit orgId={ORG} applicationId={APP} />);

    expect(statusArgs).toContainEqual({ orgId: ORG, vehicleId: "v1", salePrice: 20000 });
  });
});
