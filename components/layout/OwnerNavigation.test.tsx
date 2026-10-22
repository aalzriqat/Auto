import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import TeamPage from "@/app/(dashboard)/[orgId]/team/page";
import { Sidebar } from "./Sidebar";
import { TopNav } from "./TopNav";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { MessengerProvider } from "@/components/messages/MessengerContext";
import { settingsNavigation } from "@/lib/navigation";
const state = vi.hoisted(() => ({ membership: {} as unknown }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never) => {
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Dealer" }];
      if (name === "memberships:getMyMembership") return state.membership;
      if (name === "notifications:list" || name === "roles:list") return [];
      return null;
    },
    useMutation: () => vi.fn(),
    useAction: () => vi.fn(),
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
  };
});
vi.mock("@clerk/nextjs", () => ({ UserButton: () => null }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/accounting", useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test.each(["desktop", "mobile"] as const)("%s settings links follow qualified authority", (surface) => {
  const mount = () => render(<OrgProvider><LanguageProvider><MessengerProvider>{surface === "desktop" ? <Sidebar /> : <TopNav />}</MessengerProvider></LanguageProvider></OrgProvider>);
  state.membership = { roleName: "OWNER", isSystemOwnerRole: false, permissions: ["view:finance"] };
  const tree = mount();
  if (surface === "mobile") fireEvent.click(screen.getByRole("button", { name: "Toggle navigation menu" }));
  for (const item of settingsNavigation.filter((entry) => entry.ownerOnly)) {
    expect(document.querySelector(`a[href="/org-a${item.href}"]`)).toBeNull();
  }
  tree.unmount();
  state.membership = { roleName: "Dealer principal", isSystemOwnerRole: true, permissions: ["view:finance"] };
  mount();
  if (surface === "mobile") fireEvent.click(screen.getByRole("button", { name: "Toggle navigation menu" }));
  for (const item of settingsNavigation.filter((entry) => entry.ownerOnly)) {
    expect(document.querySelector(`a[href="/org-a${item.href}"]`), item.href).not.toBeNull();
  }
});


test.each([
  ["OWNER", false, ["view:users"], false, false],
  ["Dealer principal", true, ["view:users", "manage:users"], true, true],
  ["Delegated manager", false, ["view:users", "manage:users"], true, false],
] as const)("Team controls use resolved permissions and qualified ownership: %s", (roleName, isSystemOwnerRole, permissions, manageUsers, ownerControls) => {
  state.membership = { roleName, isSystemOwnerRole, permissions: [...permissions] };
  render(<OrgProvider><LanguageProvider><TeamPage /></LanguageProvider></OrgProvider>);
  expect(screen.queryByRole("button", { name: "Add Member" }) !== null).toBe(manageUsers);
  expect(screen.queryByRole("button", { name: "Sync Role Permissions" }) !== null).toBe(ownerControls);
  expect(screen.queryByRole("tab", { name: "Roles & Permissions" }) !== null).toBe(ownerControls);
});
