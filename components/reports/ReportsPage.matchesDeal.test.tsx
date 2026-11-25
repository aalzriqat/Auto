import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ReportsPage from "../../app/(dashboard)/[orgId]/reports/page";
import { OrgProvider } from "../providers/OrgProvider";
import { LanguageProvider } from "../providers/LanguageProvider";

const state = vi.hoisted(() => ({
  sales: undefined as unknown, performance: [] as unknown, locale: "en",
  salesArgs: undefined as unknown, throwSales: undefined as unknown,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/reports",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args?: unknown) => {
    switch (getFunctionName(ref)) {
      case "organizations:listMine": return [{ _id: "org-a" }];
      case "memberships:getMyMembership": return { isSystemOwnerRole: true, permissions: ["view:reports", "view:cost_price"] };
      case "memberships:list": return { page: [] };
      case "orgSettings:get": return { currency: "JOD" };
      case "reports:getSalesAndProfitReport":
        state.salesArgs = args;
        if (args !== "skip" && state.throwSales !== undefined) throw state.throwSales;
        return args === "skip" ? undefined : state.sales;
      case "reports:getSalespersonPerformance": return state.performance;
      default: return null;
    }
  },
}));

beforeEach(() => {
  state.performance = [];
  state.locale = "en";
  state.salesArgs = undefined;
  state.throwSales = undefined;
  vi.stubGlobal("localStorage", { getItem: () => state.locale, setItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

function showReport() {
  return render(<LanguageProvider><OrgProvider><ReportsPage /></OrgProvider></LanguageProvider>);
}

const WORKED_ROW = {
  _id: "sale-w", saleDate: 1794009600000, salePrice: 12100, currency: "JOD", includedInTotals: true,
  recognizedRevenue: 1885, totalCost: 751.3, netProfit: 1133.7, commissionsTotal: 110, netProfitAfterCommissions: 1023.7,
  profitLines: [
    { key: "APPROVED_PURCHASE", sign: 1, amount: 12000 },
    { key: "SUPPLIER_SETTLEMENT", sign: -1, amount: 9900 },
    { key: "DEALER_CONTRIBUTION", sign: -1, amount: 215 },
    { key: "PREPARATION_EXPENSES", sign: -1, amount: 300 },
    { key: "ACTUAL_EXPENSES", sign: -1, amount: 451.3 },
  ],
  profitClassification: "ESTIMATED_AWAITING_SETTLEMENT",
};
const WORKED_PAYLOAD = {
  figureBasis: "DEAL_MANAGEMENT_NET_V2", totalRevenue: 1885, totalCost: 751.3, totalProfit: 1133.7,
  totalCommissions: 110, totalNetProfitAfterCommissions: 1023.7, commissionIncompleteSaleCount: 0, sales: [WORKED_ROW],
};

test.each([undefined, "DEAL_MANAGEMENT_NET_V1"])("a legacy backend payload (%s) is withheld before its profit can be mislabelled", (figureBasis) => {
  state.sales = { figureBasis, totalRevenue: 1885, totalCost: 0, totalProfit: 1885, sales: [
    { _id: "sale-a", saleDate: 1794009600000, salePrice: 11785, totalCost: 0, netProfit: 1885 },
  ] };
  showReport();
  expect(screen.queryByText("11,785 JOD")).toBeNull();
  expect(screen.getByText(/report update is required/i)).toBeTruthy();
});

test.each(["en", "ar"])("current report renders exact deal figures with %s labels and direction", (locale) => {
  state.locale = locale;
  state.sales = {
    figureBasis: "DEAL_MANAGEMENT_NET_V2", totalRevenue: 1885, totalCost: 751.3, totalProfit: 1133.7,
    totalCommissions: 110, commissionIncompleteSaleCount: 0,
    sales: [{ _id: "sale-a", saleDate: 1794009600000, salePrice: 12100, totalCost: 751.3,
      netProfit: 1133.7, netProfitAfterCommissions: 1023.7, commissionsTotal: 110,
      recognizedRevenue: 1885, currency: "JOD", includedInTotals: true }],
  };
  const view = showReport();
  expect(screen.getByText(/12,100/)).toBeTruthy();
  expect(screen.getAllByText(/1,133.7/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText(/1,023.7/).length).toBeGreaterThanOrEqual(1);
  expect(view.container.querySelector("[dir]")?.getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
  expect(screen.getByRole("columnheader", { name: locale === "ar" ? "صافي الربح قبل العمولات" : "Net profit before commissions" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: locale === "ar" ? "الصافي بعد العمولات" : "Net after commissions" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: locale === "ar" ? "الإيراد المعترف به" : "Recognized revenue" })).toBeTruthy();
});

test("an old-shape row without a working still renders its figures and offers no working", () => {
  state.sales = {
    figureBasis: "DEAL_MANAGEMENT_NET_V2", totalRevenue: 1885, totalCost: 751.3, totalProfit: 1133.7,
    sales: [{ _id: "sale-old", saleDate: 1794009600000, salePrice: 12100, totalCost: 751.3, netProfit: 1133.7,
      recognizedRevenue: 1885, currency: "JOD", includedInTotals: true }],
  };
  const view = showReport();
  expect(screen.getByText(/12,100/)).toBeTruthy();
  expect(view.container.querySelector("details")).toBeNull();
});

test.each(["en", "ar"])("%s: a row shows its working, served subtotal, commission and net after, marked estimated", (locale) => {
  state.locale = locale;
  state.sales = WORKED_PAYLOAD;
  const view = showReport();
  const working = view.container.querySelector("details") as HTMLElement;
  expect(working).not.toBeNull();
  const inside = within(working);
  expect(inside.getByText(locale === "ar" ? "تسوية المورد" : "Supplier settlement")).toBeTruthy();
  expect(inside.getByText(locale === "ar" ? "قيمة الشراء المعتمدة من شركة التمويل" : "Approved purchase amount (finance company)")).toBeTruthy();
  expect(inside.getByText(locale === "ar" ? "صافي الربح قبل العمولات" : "Net profit before commissions")).toBeTruthy();
  expect(inside.getByText(locale === "ar" ? "الصافي بعد العمولات" : "Net after commissions")).toBeTruthy();
  expect(inside.getByText(/1,133.7/)).toBeTruthy();
  expect(inside.getByText(/1,023.7/)).toBeTruthy();
  expect(screen.getAllByText(locale === "ar" ? "تقديري" : "Estimate").length).toBeGreaterThanOrEqual(1);
  expect(Array.from(working.querySelectorAll("dd")).every((amount) => amount.getAttribute("dir") === "ltr")).toBe(true);
});

test("a row whose profit is unknown shows a dash and no working, never a zero", () => {
  state.sales = {
    figureBasis: "DEAL_MANAGEMENT_NET_V2", totalRevenue: 0, totalCost: 0, totalProfit: 0, unknownMarginSaleCount: 1,
    sales: [{ _id: "sale-u", saleDate: 1794009600000, salePrice: 12100, currency: "JOD", includedInTotals: false,
      recognizedRevenue: null, totalCost: null, netProfit: null, profitLines: [], profitUnavailableReason: "ExpensesUnreadable" }],
  };
  const view = showReport();
  expect(view.container.querySelector("details")).toBeNull();
  expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
});

function setRange(container: HTMLElement, start: string, end: string) {
  const [from, to] = Array.from(container.querySelectorAll('input[type="date"]'));
  fireEvent.change(from, { target: { value: start } });
  fireEvent.change(to, { target: { value: end } });
}

test("a range of 366 days is queried; 367 days is refused with a message and the query is skipped", () => {
  state.sales = WORKED_PAYLOAD;
  const view = showReport();
  setRange(view.container, "2026-01-01", "2027-01-01");
  expect(state.salesArgs).not.toBe("skip");
  expect(screen.queryByText(/limited to 366 days/i)).toBeNull();
  setRange(view.container, "2026-01-01", "2027-01-02");
  expect(state.salesArgs).toBe("skip");
  expect(screen.getByText(/limited to 366 days/i)).toBeTruthy();
});

test("a start date after the end date is refused with a message and the query is skipped", () => {
  state.sales = WORKED_PAYLOAD;
  const view = showReport();
  setRange(view.container, "2026-03-02", "2026-03-01");
  expect(state.salesArgs).toBe("skip");
  expect(screen.getByText(/start date must not be after the end date/i)).toBeTruthy();
});

test.each(["en", "ar"])("%s: a server refusal renders its message in the page, not the error boundary", (locale) => {
  state.locale = locale;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  state.throwSales = new ConvexError("This range has too many sales for one report. Narrow the range.");
  showReport();
  expect(screen.getByText(/too many sales for one report/i)).toBeTruthy();
  errors.mockRestore();
});

test("an unexpected failure renders a generic message, never the raw error", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  state.throwSales = new Error("secret internal detail");
  showReport();
  expect(screen.queryByText(/secret internal detail/)).toBeNull();
  expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  errors.mockRestore();
});
