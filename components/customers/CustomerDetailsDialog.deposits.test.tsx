/**
 * SCRUM-858 (c23884): the customer details dialog renders `customers.getRelations`' deposits, gated on the
 * same permission as the server read (VIEW_SALES). Real LanguageProvider and the real section; only the
 * Convex hooks, router, org context and the heavy neighbouring panels are replaced.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { CustomerDetailsDialog } from "./CustomerDetailsDialog";

const fixture = vi.hoisted(() => ({
  permissions: [] as string[],
  relations: undefined as undefined | Record<string, unknown>,
  calls: [] as string[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      fixture.calls.push(name);
      if (name === "customers:get") return { _id: "cust_1", firstName: "Layla", lastName: "Security", createdAt: 1_700_000_000_000 };
      if (name === "customers:getRelations") return fixture.relations;
      if (name === "orgSettings:getLogoUrl") return null;
      if (name === "orgSettings:get") return { currency: "JOD" };
      return undefined;
    },
    useMutation: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: (permission: string) => fixture.permissions.includes(permission) }),
}));
vi.mock("@/components/deposits/QuoteDepositManager", () => ({ QuoteDepositManager: () => null }));
vi.mock("@/components/customers/CustomerFinancialsTab", () => ({ CustomerFinancialsTab: () => null }));
vi.mock("@/components/sales/QuotePrintTemplate", () => ({ QuotePrintTemplate: () => null }));
vi.mock("@/lib/htmlToPdf", () => ({ downloadElementAsPdf: vi.fn() }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const RELATIONS = {
  sales: [],
  leads: [],
  tasks: [],
  quotes: [],
  deposits: [
    {
      _id: "dep_1",
      status: "HELD",
      amountMinor: 100_000,
      amount: 100,
      currency: "JOD",
      origin: "OPENING",
      openingDepositKind: "SECURITY",
      createdAt: 1_700_000_000_000,
    },
  ],
  depositsTruncated: false,
};

beforeEach(() => {
  fixture.permissions = ["view:sales"];
  fixture.relations = RELATIONS;
  fixture.calls = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openDealsTab(locale: "en" | "ar") {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  render(
    <LanguageProvider>
      <CustomerDetailsDialog customerId={"cust_1" as Id<"customers">} open onOpenChange={() => undefined} />
    </LanguageProvider>
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: locale === "en" ? /Deals/ : /الصفقات/ }), { button: 0, ctrlKey: false });
}

test.each([
  ["en", "Deposits", "100.000 JOD", "Security deposit (refundable guarantee)"],
  ["ar", "العربونات", "100.000 دينار اردني", "تأمين (ضمان قابل للاسترداد)"],
] as const)("a sales reader sees the customer's deposits on the Deals tab in %s", (locale, title, amount, classification) => {
  openDealsTab(locale);
  expect(screen.getByRole("heading", { name: title })).toBeTruthy();
  const table = screen.getByRole("table");
  expect(table.textContent).toContain(amount);
  expect(table.textContent).toContain(classification);
});

test("a customer reader WITHOUT the sales permission sees no deposit section and no amount, even if the payload carried rows", () => {
  fixture.permissions = ["view:customers"];
  openDealsTab("en");
  expect(screen.queryByText("Deposits")).toBeNull();
  expect(screen.queryByTestId("customer-deposits")).toBeNull();
  expect(document.body.textContent).not.toContain("100.000");
  expect(screen.queryByText("This customer has no deposits.")).toBeNull();
});

test("a customer with no deposits shows the empty state, and a truncated page shows the notice", () => {
  fixture.relations = { ...RELATIONS, deposits: [], depositsTruncated: false };
  openDealsTab("en");
  expect(screen.getByText("This customer has no deposits.")).toBeTruthy();
  cleanup();
  fixture.relations = { ...RELATIONS, depositsTruncated: true };
  openDealsTab("en");
  expect(screen.getByRole("note").textContent).toContain("newest 100 deposits");
});
