import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SourcingPage from "@/app/(dashboard)/[orgId]/sourcing/page";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";

const state = vi.hoisted(() => ({ membership: undefined as { roleName: string; permissions: string[] } | undefined }));

// Convex is the network boundary. A forbidden subscription throws as the real
// query does; internal guards, providers and the entire sourcing client are real.
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Synthetic Dealer" }];
      if (name === "memberships:getMyMembership") return state.membership;
      if (name.startsWith("sourcingPayables:") || name.startsWith("supplierCostRecoveries:")) {
        if (!state.membership?.permissions.includes("view:finance")) throw new Error("Synthetic backend finance refusal");
        return name === "supplierCostRecoveries:list" ? { complete: true, items: [] } : [];
      }
      return null;
    },
    useMutation: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/sourcing", useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<OrgProvider><LanguageProvider><SourcingPage /></LanguageProvider></OrgProvider>);

test.each(["MANAGER", "SALES", "RECEPTION"])("%s sees a calm sourcing refusal before protected subscriptions mount", (roleName) => {
  const template = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === roleName);
  if (!template) throw new Error("Missing actual role template");
  expect(template.permissions).not.toContain("view:finance");
  state.membership = { roleName, permissions: [...template.permissions] };
  expect(mount).not.toThrow();
  expect(screen.getByRole("heading", { name: "Access Not Allowed" })).toBeTruthy();
});

test("finance reader still sees the real sourcing page", () => {
  state.membership = { roleName: "Synthetic finance reader", permissions: ["view:finance"] };
  mount();
  expect(screen.queryByRole("heading", { name: "Access Not Allowed" })).toBeNull();
  expect(screen.getByRole("heading", { name: /Special Orders/ })).toBeTruthy();
});

test("unresolved membership does not mount protected sourcing subscriptions", () => {
  state.membership = undefined;
  expect(mount).not.toThrow();
  expect(screen.queryByRole("heading", { name: "Access Not Allowed" })).toBeNull();
  expect(screen.queryByRole("heading", { name: /Special Orders/ })).toBeNull();
});
