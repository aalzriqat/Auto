/** Real mounted screens for the anonymous PR paint checks. SDK data is synthetic;
 * this does not attest membership, backend authority or authenticated routing. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import ExpensesPage from "@/app/(dashboard)/[orgId]/expenses/page";
import ApprovalsPage from "@/app/(dashboard)/[orgId]/approvals/page";
import SalesPage from "@/app/(dashboard)/[orgId]/sales/sales/page";
import LeadsPage from "@/app/(dashboard)/[orgId]/leads/page";
import { MarketplaceRequestsClient } from "@/app/(dashboard)/[orgId]/marketplace/requests/client";
import { LeadDialog } from "@/components/leads/LeadDialog";
import { QuoteDialog } from "@/components/sales/QuoteDialog";
import Step1QuoteSetup from "@/components/sales/wizard/steps/Step1QuoteSetup";

const state = vi.hoisted(() => ({ role: "SALES", locale: "en", overridePermissions: undefined as string[] | undefined,
  values: new Map<string, unknown>() }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      const role = DEFAULT_ROLE_TEMPLATES.find(item => item.name === state.role);
      if (!role) throw new Error("Missing shipped role template");
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Synthetic Dealer" }];
      if (name === "memberships:getMyMembership") return { roleName: state.overridePermissions ? "Synthetic custom lead reader" : role.name, permissions: state.overridePermissions ?? [...role.permissions] };
      if (state.values.has(name)) return state.values.get(name);
      throw new Error("Unexpected screen fixture subscription: " + name);
    },
    useQueries: () => ({}),
    usePaginatedQuery: (ref: never, args: unknown) => {
      if (args !== "skip" && !state.values.has(getFunctionName(ref))) throw new Error("Unexpected paginated fixture subscription: " + getFunctionName(ref));
      return { results: [], status: "Exhausted", loadMore: vi.fn() };
    },
    useMutation: () => vi.fn(), useAction: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/expenses", useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

beforeEach(() => {
  state.values.clear();
  state.overridePermissions = undefined;
  vi.stubGlobal("localStorage", { getItem: () => state.locale, setItem: () => {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = (node: React.ReactNode) => render(<OrgProvider><LanguageProvider>{node}</LanguageProvider></OrgProvider>);
function capture(name: string) {
  const dir = process.env.ROLE_ACCESS_VISUAL_FIXTURE_DIR;
  if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, `${name}-${state.locale}.html`), document.body.innerHTML); }
  cleanup();
}

test.each(["en", "ar"])("real role-access screen fixtures %s", locale => {
  state.locale = locale;
  state.role = "SALES";
  mount(<ExpensesPage />);
  expect(screen.getByRole("heading", { name: locale === "en" ? "Access Not Allowed" : "الوصول غير مسموح" })).toBeTruthy();
  capture("denied-expenses");

  state.role = "RECEPTION";
  state.overridePermissions = ["view:leads", "view:org"];
  state.values.set("orgSettings:get", null);
  state.values.set("orgSettings:getLogoUrl", null);
  state.values.set("leads:list", []);
  state.values.set("memberships:list", []);
  mount(<LeadsPage />);
  expect(screen.queryByRole("button", { name: locale === "en" ? "Add Lead" : "إضافة عميل محتمل" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  capture("lead-reader");
  state.overridePermissions = undefined;

  state.role = "ACCOUNTANT";
  state.values.set("orgSettings:get", null);
  state.values.set("depositRequests:listPending", undefined);
  mount(<ApprovalsPage />);
  expect(screen.getByTestId("pending-deposit-loading").getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByTestId("pending-deposit-empty")).toBeNull();
  capture("deposit-loading");
  state.values.set("depositRequests:listPending", []);
  mount(<ApprovalsPage />);
  expect(screen.getByTestId("pending-deposit-empty")).toBeTruthy();
  expect(screen.queryByTestId("pending-deposit-loading")).toBeNull();
  capture("deposit-empty");

  state.role = "RECEPTION";
  state.values.set("orgLeadSources:listForLeads", [{ _id: "source-a", label: "Synthetic configured channel" }]);
  for (const name of ["customers:selectorOptions", "vehicles:listAll", "orgPipelineStages:list", "memberships:list", "orgCustomFields:list"]) state.values.set(name, []);
  mount(<LeadDialog open onOpenChange={vi.fn()} />);
  const dialog = screen.getByRole("dialog");
  expect(dialog).toBeTruthy();
  // Use the real translated label, then open the actual Radix select portal.
  const source = screen.getByRole("combobox", { name: locale === "en" ? "Lead Source" : "مصدر العميل المحتمل" });
  fireEvent.keyDown(source, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Synthetic configured channel" }));
  expect(source.textContent).toContain("Synthetic configured channel");
  expect(screen.queryByRole("listbox")).toBeNull();
  capture("lead-source");

  state.values.set("orgLeadSources:listForLeads", undefined);
  mount(<LeadDialog open onOpenChange={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("combobox", { name: locale === "en" ? "Lead Source" : "مصدر العميل المحتمل" }), { key: "ArrowDown" });
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  capture("lead-source-loading");

  state.role = "ACCOUNTANT";
  for (const name of ["finance:listCompanies", "documents:listRules", "sales:list"]) state.values.set(name, []);
  state.values.set("orgCustomerStatuses:listForQuotes", [{ _id: "status-a", label: "Synthetic eligibility" }]);
  mount(<SalesPage />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getAllByText(locale === "en" ? /No sales found/i : /لم يتم العثور/).length).toBeGreaterThan(0);
  capture("sales-empty");

  state.values.set("approvals:profitApprovalStatus", { status: "NOT_REQUIRED", margin: 1, minimumProfit: 0 });
  mount(<Step1QuoteSetup paymentType="INSTALLMENT" initialData={{ vehicleId: "", vehiclePrice: 0, desiredProfit: 0, downPayment: 0, termMonths: 60 }} onNext={vi.fn()} />);
  expect(screen.getByText("Synthetic eligibility")).toBeTruthy();
  capture("quote-choice");

  state.values.set("orgCustomerStatuses:listForQuotes", undefined);
  state.values.set("customers:list", []);
  mount(<QuoteDialog open onOpenChange={vi.fn()} />);
  expect(screen.getByText(locale === "en" ? "Loading customer statuses…" : "جارٍ تحميل حالات العميل…")).toBeTruthy();
  expect(screen.queryByText(locale === "en" ? "No customer statuses configured yet — set them up in Finance Settings." : "لم يتم تكوين حالات العميل بعد — قم بإعدادها في إعدادات التمويل.")).toBeNull();
  capture("quote-status-loading");

  state.overridePermissions = ["marketplace:respond", "view:org"];
  state.values.set("marketplaceResponses:listForOrg", [{ requestId: "request-a", buyerFirstName: "Synthetic Buyer", buyerCity: "Synthetic City", paymentType: "CASH", buyerIntent: "HOT", make: "Synthetic Make", model: "Synthetic Model", latestResponse: null }]);
  mount(<MarketplaceRequestsClient />);
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Reply" : "رد" }));
  expect(screen.getAllByRole("combobox")[0].textContent).toContain(locale === "en" ? "I have something similar" : "عندي سيارة مشابهة");
  capture("marketplace-default");
  mount(<MarketplaceRequestsClient />);
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Reply" : "رد" }));
  fireEvent.keyDown(screen.getAllByRole("combobox")[0], { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: locale === "en" ? "Not available" : "غير متوفرة" }));
  expect(screen.getByRole("button", { name: locale === "en" ? "Send reply" : "إرسال الرد" })).toBeTruthy();
  capture("marketplace-reply");
});
