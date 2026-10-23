import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ExpensesPage from "@/app/(dashboard)/[orgId]/expenses/page";
import PayrollPage from "@/app/(dashboard)/[orgId]/payroll/page";
import ReportsPage from "@/app/(dashboard)/[orgId]/reports/page";
import CommissionsPage from "@/app/(dashboard)/[orgId]/commissions/page";
import SalesHomePage from "@/app/(dashboard)/[orgId]/sales/page";
import SalesPage from "@/app/(dashboard)/[orgId]/sales/sales/page";
import TasksPage from "@/app/(dashboard)/[orgId]/tasks/page";
import MarketplaceRequestsPage from "@/app/(dashboard)/[orgId]/marketplace/requests/page";
import LeadsPage from "@/app/(dashboard)/[orgId]/leads/page";
import SocialInboxPage from "@/app/(dashboard)/[orgId]/social-inbox/page";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";

const state = vi.hoisted(() => ({ membership: undefined as { roleName: string; permissions: string[] } | undefined }));

// Only the external network and navigation boundaries are replaced. Any
// protected subscription mounting before permission resolution must fail.
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Synthetic Dealer" }];
      if (name === "memberships:getMyMembership") return state.membership;
      throw new Error("Protected query mounted before page authority: " + name);
    },
    usePaginatedQuery: (ref: never, args: unknown) => {
      if (args === "skip") return { results: [], status: "Exhausted", loadMore: vi.fn() };
      throw new Error("Protected paginated query mounted before page authority: " + getFunctionName(ref));
    },
    useMutation: () => vi.fn(),
    useAction: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/expenses", useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pages = [
  { name: "expenses", permission: "view:expenses", Page: ExpensesPage, deniedRoles: ["SALES", "RECEPTION"] },
  { name: "payroll", permission: "view:payroll", Page: PayrollPage, deniedRoles: ["SALES", "RECEPTION"] },
  { name: "reports", permission: "view:reports", Page: ReportsPage, deniedRoles: ["SALES", "RECEPTION"] },
  { name: "commissions", permission: "view:commissions", Page: CommissionsPage, deniedRoles: ["RECEPTION"] },
  { name: "sales", permission: "view:sales", Page: SalesHomePage, deniedRoles: ["RECEPTION"] },
  { name: "sales/sales", permission: "view:sales", Page: SalesPage, deniedRoles: ["RECEPTION"] },
  { name: "tasks", permission: "view:tasks", Page: TasksPage, deniedRoles: ["RECEPTION"] },
  { name: "marketplace/requests", permission: "marketplace:respond", Page: MarketplaceRequestsPage, deniedRoles: ["RECEPTION"] },
  { name: "leads", permission: "view:leads", Page: LeadsPage, deniedRoles: ["ACCOUNTANT", "SENIOR_ACCOUNTANT"] },
  { name: "social-inbox", permission: "view:leads", Page: SocialInboxPage, deniedRoles: ["ACCOUNTANT", "SENIOR_ACCOUNTANT"] },
] as const;

for (const { name, permission, Page, deniedRoles } of pages) {
  test.each(deniedRoles)(`${name} refuses %s before protected subscriptions mount`, (roleName) => {
    const role = DEFAULT_ROLE_TEMPLATES.find((candidate) => candidate.name === roleName);
    if (!role) throw new Error("Missing actual role template");
    expect(role.permissions).not.toContain(permission);
    state.membership = { roleName, permissions: [...role.permissions] };
    expect(() => render(<OrgProvider><LanguageProvider><Page /></LanguageProvider></OrgProvider>)).not.toThrow();
    expect(screen.getByRole("heading", { name: "Access Not Allowed" })).toBeTruthy();
  });

  test(`${name} waits for membership before protected subscriptions mount`, () => {
    state.membership = undefined;
    expect(() => render(<OrgProvider><LanguageProvider><Page /></LanguageProvider></OrgProvider>)).not.toThrow();
    expect(screen.queryByRole("heading", { name: "Access Not Allowed" })).toBeNull();
  });
}
