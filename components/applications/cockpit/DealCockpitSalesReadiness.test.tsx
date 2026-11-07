import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "@/convex/utils/permissions";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import { commonAr, commonEn } from "@/lib/i18n/domains/common";

const state = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  args: new Map<string, unknown>(),
  permissions: new Set<string>(),
  permissionsLoading: false,
  locale: "en" as "en" | "ar",
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = state.locale === "ar" ? { ...commonAr, ...salesAr } : { ...commonEn, ...salesEn };
      return messages[key] ?? key;
    },
    locale: state.locale,
    isRtl: state.locale === "ar",
  }),
}));
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ code: "JOD", symbol: "JD", displayLabel: "JOD", scale: 3, format: (n: number) => `JD ${n}` }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => state.permissions.has(permission),
    isLoading: state.permissionsLoading,
    membership: { userId: "user_sales" },
    isOwner: false,
  }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      state.args.set(name, args);
      // Convex returns undefined for skip even when a previous result exists.
      return args === "skip" ? undefined : state.results.get(name);
    },
    useQueries: (queries: Record<string, { query: never }>) => Object.fromEntries(
      Object.entries(queries).map(([key, { query }]) => [key, state.results.get(getFunctionName(query))])
    ),
    useMutation: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DealCockpit } from "./DealCockpit";

const ORG = "org_readiness" as Id<"organizations">;
const APP = "app_readiness" as Id<"financeApplications">;
const COSTS = "financeDealCosts:listDealCosts";

function seedDeal(sourceType: "STOCK" | "SOURCED" = "STOCK") {
  state.results.set("dealWorkspace:financedDealCockpit", {
    dealKind: "FINANCED", dealRef: APP, applicationId: APP, saleId: null, canonicalSaleId: null,
    status: "PENDING_DOCS", createdAt: Date.UTC(2026, 10, 7), updatedAt: Date.UTC(2026, 10, 7),
    customer: null, vehicle: null, salespersonName: "Sales", financeCompanyName: "QA financier",
    settlementAdviceRequiresReconciliation: false, settlementAdviceDiscrepancy: null,
    stages: [{ key: "DOCUMENTS", state: "CURRENT" }], documents: [], timeline: [], money: null,
    denomination: { code: "JOD", scale: 3 }, economicsRecorded: false, economicsStamp: "v2|0",
  });
  state.results.set("applications:get", {
    _id: APP, status: "PENDING_DOCS", salespersonId: "user_sales", economicsCurrency: "JOD",
    vehicle: { sourceType }, quote: null,
  });
  state.results.set("financingEconomics:getEconomics", null);
  state.results.set("dealOverview:financedDealOverview", null);
  state.results.set("documents:getForApplication", []);
  state.results.set("documents:getHistoryForApplication", []);
  state.results.set("applications:getClosingReadiness", { open: true, state: "BLOCKED", checks: [] });
}

function useRole(name: string) {
  const role = DEFAULT_ROLE_TEMPLATES.find((candidate) => candidate.name === name);
  if (!role) throw new Error(`Missing template ${name}`);
  state.permissions = new Set(role.permissions);
}

afterEach(() => {
  cleanup();
  state.results.clear();
  state.args.clear();
  state.permissions.clear();
  state.permissionsLoading = false;
  state.locale = "en";
});

test("SCRUM-925: SALES financed details resolve skipped custody costs as withheld in EN and AR", () => {
  useRole("SALES");
  expect(state.permissions.has(PERMISSIONS.VIEW_FINANCE_APPLICATIONS)).toBe(true);
  expect(state.permissions.has(PERMISSIONS.VIEW_COST_PRICE)).toBe(false);
  for (const locale of ["en", "ar"] as const) {
    state.locale = locale;
    const messages = locale === "ar" ? { ...commonAr, ...salesAr } : { ...commonEn, ...salesEn };
    for (const source of ["STOCK", "SOURCED"] as const) {
      seedDeal(source);
      const { container, rerender } = render(<DealCockpit orgId={ORG} applicationId={APP} />);
      expect(state.args.get(COSTS)).toBe("skip");
      const custody = screen.getByTestId("deal-custody");
      // A skipped query cannot arrive later: another render must also be resolved.
      rerender(<DealCockpit orgId={ORG} applicationId={APP} />);
      expect(custody.querySelectorAll(".animate-spin, .animate-pulse, [data-slot='skeleton']")).toHaveLength(0);
      expect(within(custody).getByText(messages.MoneyPanelHidden)).toBeTruthy();
      expect(within(custody).queryByText(messages.Loading)).toBeNull();
      expect(within(custody).queryByRole("button")).toBeNull();
      expect(within(custody).queryByText(messages.CustodyNone)).toBeNull();
      expect(custody.querySelector("dd, [data-testid='custody-expected']")).toBeNull();
      expect(container.querySelectorAll(".animate-spin, .animate-pulse, [data-slot='skeleton']")).toHaveLength(0);
      cleanup();
    }
  }
});

test("permitted custody reads stay loading until their actual response arrives", () => {
  useRole("ACCOUNTANT");
  seedDeal();
  const { rerender } = render(<DealCockpit orgId={ORG} applicationId={APP} />);
  expect(state.args.get(COSTS)).toEqual({ orgId: ORG, applicationId: APP });
  const custody = screen.getByTestId("deal-custody");
  expect(within(custody).getByText(commonEn.Loading)).toBeTruthy();
  expect(within(custody).queryByText(salesEn.MoneyPanelHidden)).toBeNull();
  state.results.set(COSTS, {
    currency: "JOD", fees: [], custody: [], custodyTruncated: false,
    expected: { rows: [], expectedTotalMinor: null, adoption: { state: "COMPANY_HAS_NO_TEMPLATES" } },
    summary: { lineCount: 0, estimatedTotalMinor: 0, actualTotalMinor: 0, dealerBorneActualMinor: 0 },
  });
  rerender(<DealCockpit orgId={ORG} applicationId={APP} />);
  expect(within(custody).queryByText(commonEn.Loading)).toBeNull();
  expect(within(custody).queryByText(salesEn.MoneyPanelHidden)).toBeNull();
  expect(within(custody).getByText(salesEn.CustodyNone)).toBeTruthy();
});

test("custody stays loading while the caller's permissions are unresolved", () => {
  useRole("SALES");
  seedDeal();
  state.permissionsLoading = true;
  render(<DealCockpit orgId={ORG} applicationId={APP} />);
  const custody = screen.getByTestId("deal-custody");
  expect(state.args.get(COSTS)).toBe("skip");
  expect(within(custody).getByText(commonEn.Loading)).toBeTruthy();
  expect(within(custody).queryByText(salesEn.MoneyPanelHidden)).toBeNull();
});
