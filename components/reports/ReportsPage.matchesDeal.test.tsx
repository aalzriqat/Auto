import React from "react";
import { render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ReportsPage from "../../app/(dashboard)/[orgId]/reports/page";
import { OrgProvider } from "../providers/OrgProvider";
import { LanguageProvider } from "../providers/LanguageProvider";

const state = vi.hoisted(() => ({ sales: undefined as unknown, performance: [] as unknown, locale: "en" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/reports",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    switch (getFunctionName(ref)) {
      case "organizations:listMine": return [{ _id: "org-a" }];
      case "memberships:getMyMembership": return { isSystemOwnerRole: true, permissions: ["view:reports", "view:cost_price"] };
      case "memberships:list": return { page: [] };
      case "orgSettings:get": return { currency: "JOD" };
      case "reports:getSalesAndProfitReport": return state.sales;
      case "reports:getSalespersonPerformance": return state.performance;
      default: return null;
    }
  },
}));

beforeEach(() => {
  state.performance = [];
  state.locale = "en";
  vi.stubGlobal("localStorage", { getItem: () => state.locale, setItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

function showReport() {
  return render(<LanguageProvider><OrgProvider><ReportsPage /></OrgProvider></LanguageProvider>);
}

test("a legacy backend payload is withheld before its missing currency can crash the report", () => {
  state.sales = { totalRevenue: 1885, totalCost: 0, totalProfit: 1885, sales: [
    { _id: "sale-a", saleDate: 1794009600000, salePrice: 11785, totalCost: 0, netProfit: 1885 },
  ] };
  showReport();
  expect(screen.queryByText("11,785 JOD")).toBeNull();
  expect(screen.getByText(/report update is required/i)).toBeTruthy();
});

test.each(["en", "ar"])("current report renders exact deal figures with %s labels and direction", (locale) => {
  state.locale = locale;
  state.sales = {
    figureBasis: "DEAL_MANAGEMENT_NET_V1", totalRevenue: 1885, totalCost: 861.3, totalProfit: 1023.7,
    totalCommissions: 110, commissionIncompleteSaleCount: 0,
    sales: [{ _id: "sale-a", saleDate: 1794009600000, salePrice: 12100, totalCost: 861.3,
      netProfit: 1023.7, netProfitAfterCommissions: 1023.7, commissionsTotal: 110,
      recognizedRevenue: 1885, currency: "JOD", includedInTotals: true }],
  };
  const view = showReport();
  expect(screen.getByText(/12,100/)).toBeTruthy();
  expect(screen.getAllByText(/1,023.7/).length).toBeGreaterThanOrEqual(2);
  expect(view.container.querySelector("[dir]")?.getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
  expect(screen.getAllByText(locale === "ar" ? "صافي الربح (بعد العمولات)" : "Net profit (after commissions)").length).toBeGreaterThan(0);
});
