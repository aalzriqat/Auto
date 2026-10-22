import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RoleGuard } from "./RoleGuard";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";

const state = vi.hoisted(() => ({ membership: undefined as unknown }));
vi.mock("convex/react", () => ({ useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: (_reference: unknown, args: unknown) => args === undefined ? [{ _id: "org-a" }] : state.membership }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/accounting", useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
// Locale persistence is a browser boundary; the real language provider still
// resolves and renders the real access-denied screen in English.
beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each([
  ["OWNER", false, false], ["Dealer principal", true, true], ["OWNER", undefined, false],
] as const)("owner-only content uses qualified authority: %s/%s", (roleName, isSystemOwnerRole, allowed) => {
  state.membership = { roleName, isSystemOwnerRole, permissions: ["view:finance"] };
  render(<OrgProvider><LanguageProvider><RoleGuard ownerOnly><div>Owner controls</div></RoleGuard></LanguageProvider></OrgProvider>);
  expect(screen.queryByText("Owner controls") !== null).toBe(allowed);
  expect(screen.queryByRole("heading", { name: "Access Not Allowed" }) !== null).toBe(!allowed);
});

test("permission guards still use the resolved list for an OWNER-named viewer", () => {
  state.membership = { roleName: "OWNER", isSystemOwnerRole: false, permissions: ["view:finance"] };
  render(<OrgProvider><LanguageProvider><RoleGuard permissions={["manage:finance"]}><div>Finance controls</div></RoleGuard></LanguageProvider></OrgProvider>);
  expect(screen.queryByText("Finance controls")).toBeNull();
  expect(screen.getByRole("heading", { name: "Access Not Allowed" })).toBeDefined();
});
