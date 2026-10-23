import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SalesPage from "@/app/(dashboard)/[orgId]/sales/sales/page";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";

const state = vi.hoisted(() => ({ roleName: "ACCOUNTANT" }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      const role = DEFAULT_ROLE_TEMPLATES.find(item => item.name === state.roleName);
      if (!role) throw new Error("Missing actual role template");
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Synthetic Dealer" }];
      if (name === "memberships:getMyMembership") return { roleName: role.name, permissions: [...role.permissions] };
      if (name === "orgSettings:get") return null;
      if (name === "orgCustomerStatuses:list") throw new Error("Synthetic customer-status settings authority refusal");
      if (["vehicles:listAll", "finance:listCompanies", "documents:listRules", "orgCustomerStatuses:listForQuotes"].includes(name)) return [];
      throw new Error("Unexpected network query: " + name);
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/sales/sales",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each(["ACCOUNTANT", "SENIOR_ACCOUNTANT"])("%s can read sales without mounting a closed quote's protected subscriptions", roleName => {
  state.roleName = roleName;
  const role = DEFAULT_ROLE_TEMPLATES.find(item => item.name === roleName);
  expect(role?.permissions).toContain("view:sales");
  expect(role?.permissions).not.toContain("view:settings");
  expect(role?.permissions).toContain("view:finance_applications");
  expect(() => render(<OrgProvider><LanguageProvider><SalesPage /></LanguageProvider></OrgProvider>)).not.toThrow();
  expect(screen.getAllByText(/No sales found/i).length).toBeGreaterThan(0);
});
