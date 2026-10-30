import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import TeamPage from "@/app/(dashboard)/[orgId]/team/page";
import { BranchesClient } from "@/app/(dashboard)/[orgId]/settings/branches/client";
import { Sidebar } from "./Sidebar";
import { TopNav } from "./TopNav";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { MessengerProvider } from "@/components/messages/MessengerContext";
import { settingsNavigation } from "@/lib/navigation";
const state = vi.hoisted(() => ({ membership: {} as unknown, members: [] as Array<{
  _id: string; userId: string; userName: string; userEmail: string; roleName: string; isSystemOwnerRole: boolean;
}> }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never) => {
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Dealer" }];
      if (name === "memberships:getMyMembership") return state.membership;
      if (name === "notifications:list" || name === "roles:list" || name === "branches:list") return [];
      return null;
    },
    useMutation: () => vi.fn(),
    useAction: () => vi.fn(),
    usePaginatedQuery: () => ({ results: state.members, status: "Exhausted", loadMore: vi.fn() }),
  };
});
vi.mock("@clerk/nextjs", () => ({ UserButton: () => null }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/accounting", useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => { state.members = []; vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} }); });
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

test.each([["OWNER", false], ["Dealer principal", true]] as const)("Team self-change/removal follows qualified member authority: %s", (roleName, qualified) => {
  state.membership = { roleName, userId: "self-user", isSystemOwnerRole: qualified, permissions: ["view:users", "manage:users"] };
  state.members = [{ _id: "self-membership", userId: "self-user", userName: "Self", userEmail: "self@example.test",
    roleName, isSystemOwnerRole: qualified }];
  render(<OrgProvider><LanguageProvider><TeamPage /></LanguageProvider></OrgProvider>);
  expect((screen.getByRole("button", { name: /change role/i }) as HTMLButtonElement).disabled).toBe(qualified);
  expect((screen.getByRole("button", { name: /remove/i }) as HTMLButtonElement).disabled).toBe(qualified);
});

test("branch manager choices include qualified custom owners and exclude unqualified OWNER labels", () => {
  state.membership = { roleName: "Principal", isSystemOwnerRole: true, permissions: ["view:users", "manage:users"] };
  state.members = [
    { _id: "false-owner", userId: "false-owner", userName: "Unqualified principal", userEmail: "false@example.test", roleName: "OWNER", isSystemOwnerRole: false },
    { _id: "qualified", userId: "qualified", userName: "Qualified principal", userEmail: "qualified@example.test", roleName: "Principal", isSystemOwnerRole: true },
    { _id: "manager", userId: "manager", userName: "Template manager", userEmail: "manager@example.test", roleName: "MANAGER", isSystemOwnerRole: false },
  ];
  render(<OrgProvider><LanguageProvider><BranchesClient /></LanguageProvider></OrgProvider>);
  fireEvent.click(screen.getByRole("button", { name: /add branch/i }));
  fireEvent.click(screen.getByRole("combobox", { name: /select manager/i }));
  expect(screen.queryByText("Qualified principal")).not.toBeNull();
  expect(screen.queryByText("Template manager")).not.toBeNull();
  expect(screen.queryByText("Unqualified principal")).toBeNull();
});
