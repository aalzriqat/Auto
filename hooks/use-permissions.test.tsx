import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { usePermissions } from "./use-permissions";
import { OrgProvider } from "@/components/providers/OrgProvider";

const state = vi.hoisted(() => ({ membership: undefined as unknown }));
vi.mock("convex/react", () => ({ useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: (_reference: unknown, args: unknown) => args === undefined ? [{ _id: "org-a" }] : state.membership }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/accounting", useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

describe("SCRUM-729 server-resolved permission UI", () => {
  test("an unqualified OWNER-named viewer gets only its actual permissions", () => {
    state.membership = { roleName: "OWNER", isSystemOwnerRole: false, permissions: ["view:finance"] };
    const { result } = renderHook(() => usePermissions(), { wrapper: OrgProvider });
    expect(result.current.isOwner).toBe(false);
    expect(result.current.hasPermission("view:finance")).toBe(true);
    expect(result.current.hasPermission("manage:finance")).toBe(false);
    expect(result.current.hasAnyPermission(["manage:finance", "manage:users"])).toBe(false);
    expect(result.current.hasAllPermissions(["view:finance", "manage:finance"])).toBe(false);
  });
  test("a qualified owner flag is independent of its display name", () => {
    state.membership = { roleName: "Dealer principal", isSystemOwnerRole: true, permissions: ["view:finance", "manage:finance"] };
    const { result } = renderHook(() => usePermissions(), { wrapper: OrgProvider });
    expect(result.current.isOwner).toBe(true);
    expect(result.current.hasAllPermissions(["view:finance", "manage:finance"])).toBe(true);
    // The backend's resolved list remains the authority, even for owner UI.
    expect(result.current.hasPermission("unknown:permission")).toBe(false);
  });
  test("loading or a projection without owner evidence cannot promote a role name", () => {
    state.membership = undefined;
    const { result, rerender } = renderHook(() => usePermissions(), { wrapper: OrgProvider });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.hasPermission("manage:finance")).toBe(false);
    state.membership = { roleName: "OWNER", permissions: ["view:finance"] };
    rerender();
    expect(result.current.isOwner).toBe(false);
    expect(result.current.hasPermission("manage:finance")).toBe(false);
  });
});
