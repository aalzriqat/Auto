import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import LeadsPage from "@/app/(dashboard)/[orgId]/leads/page";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";

const state = vi.hoisted(() => ({ permissions: ["view:leads", "view:org"], prefill: false }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Synthetic Dealer" }];
      if (name === "memberships:getMyMembership") return { roleName: "Synthetic lead reader", permissions: state.permissions };
      if (["orgSettings:get", "orgSettings:getLogoUrl"].includes(name)) return null;
      const catalogPermissions: Partial<Record<string, string>> = { "customers:selectorOptions": "view:customers", "customers:get": "view:customers", "vehicles:listAll": "view:vehicles", "orgLeadSources:listForLeads": "view:leads" };
      const catalogPermission = catalogPermissions[name];
      if (catalogPermission && !state.permissions.includes(catalogPermission)) throw new Error("Forbidden lead catalog query: " + name);
      // Pipeline stages and custom-field definitions require tenant membership only.
      if (["orgLeadSources:listForLeads", "customers:selectorOptions", "vehicles:listAll", "orgPipelineStages:list", "orgCustomFields:list"].includes(name)) return [];
      throw new Error("Unexpected lead reader fixture query: " + name);
    },
    usePaginatedQuery: (ref: never, args: unknown) => {
      if (args !== "skip" && getFunctionName(ref) === "memberships:list" && !state.permissions.includes("view:users")) {
        throw new Error("Forbidden lead catalog query: memberships:list");
      }
      return { results: [], status: "Exhausted", loadMore: vi.fn() };
    },
    useMutation: () => vi.fn(), useAction: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/leads",
  useSearchParams: () => new URLSearchParams(state.prefill ? "customerId=synthetic-customer" : ""), useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => {
  state.permissions = ["view:leads", "view:org"]; state.prefill = false;
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

test("a permitted lead creator opens the real form and revocation removes it", () => {
  state.permissions.push("create:leads");
  const page = () => <OrgProvider><LanguageProvider><LeadsPage /></LanguageProvider></OrgProvider>;
  const view = render(page());
  fireEvent.click(screen.getByRole("button", { name: "Add Lead" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  state.permissions = ["view:leads", "view:org"];
  view.rerender(page());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add Lead" })).toBeNull();
  expect(screen.queryByText("No leads found. Add a new lead to get started.")).toBeNull();
});

test("a customer prefill cannot open creation for a read-only lead member", () => {
  state.prefill = true;
  render(<OrgProvider><LanguageProvider><LeadsPage /></LanguageProvider></OrgProvider>);
  expect(screen.getByText("Total Leads")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("a lead reader without create authority sees the list without an Add Lead action", () => {
  render(<OrgProvider><LanguageProvider><LeadsPage /></LanguageProvider></OrgProvider>);
  expect(screen.getByText("Total Leads")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add Lead" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});


test.each([
  ["view:customers"],
  ["view:vehicles"],
  ["view:users"],
])("a lead creator missing %s does not subscribe to its protected picker", (permission) => {
  state.permissions = ["view:org", "view:leads", "create:leads", "view:customers", "view:vehicles", "view:users"]
    .filter((candidate) => candidate !== permission);
  render(<OrgProvider><LanguageProvider><LeadsPage /></LanguageProvider></OrgProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Add Lead" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "No Access" }).hasAttribute("disabled")).toBe(true);
});
