import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { SupplierVehicleTarget } from "./SupplierVehicleTarget";

const world = vi.hoisted(() => ({ id: "outside-list", locale: "en" as "en" | "ar", permitted: true, loading: false, error: false, calls: [] as Array<{ name: string; args: unknown }> }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(world.id ? { supplierVehicleId: world.id } : {}), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ isLoading: false, hasPermission: (permission: string) => world.permitted && permission === "view:vehicles", hasAnyPermission: () => false }) }));
vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries: messages } = await import("@/lib/i18n/dictionaries");
  return { useLanguage: () => ({ locale: world.locale, isRtl: world.locale === "ar", t: (key: string) => messages[world.locale][key as keyof typeof messages.en] ?? key }) };
});
vi.mock("convex/react", async importOriginal => ({
  ...await importOriginal<typeof import("convex/react")>(),
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(ref); world.calls.push({ name, args });
    if (args === "skip") return undefined;
    if (name === "vehicles:get") {
      if (world.error) throw new Error("private lookup detail");
      if (world.loading) return undefined;
      return { _id: world.id, _creationTime: 1, orgId: "org1", make: "Toyota", model: "Camry", year: 2024, mileage: 1, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12000, status: "AVAILABLE", sourceType: "STOCK" };
    }
    if (name.startsWith("orgSettings:")) return { currency: "JOD" };
    return undefined;
  },
  useMutation: () => vi.fn(),
  usePaginatedQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    world.calls.push({ name: getFunctionName(ref), args });
    return { results: [], status: "Exhausted", loadMore: vi.fn() };
  },
}));
beforeEach(() => { world.id = "outside-list"; world.locale = "en"; world.permitted = true; world.loading = false; world.error = false; world.calls = []; });
afterEach(cleanup);

test("a supplier vehicle outside the loaded inventory opens directly by id without a page walk", () => {
  render(<SupplierVehicleTarget orgId={"org1" as never} />);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("heading", { name: /Toyota Camry/ })).toBeTruthy();
  expect(world.calls.filter(call => call.name === "vehicles:get" && call.args !== "skip")[0]?.args).toEqual({ orgId: "org1", vehicleId: "outside-list" });
  expect(world.calls.some(call => call.name === "vehicles:list")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("missing navigation id or vehicle permission does not query the record", () => {
  world.id = "";
  const first = render(<SupplierVehicleTarget orgId={"org1" as never} />);
  expect(world.calls.filter(call => call.args !== "skip")).toEqual([]);
  first.unmount(); world.id = "outside-list"; world.permitted = false; world.calls = [];
  render(<SupplierVehicleTarget orgId={"org1" as never} />);
  expect(world.calls.filter(call => call.args !== "skip")).toEqual([]);
});
test("direct vehicle navigation has localized loading and errors in EN and AR", () => {
  for (const locale of ["en", "ar"] as const) {
    cleanup(); world.error = false;
    world.locale = locale; world.loading = true;
    const view = render(<SupplierVehicleTarget orgId={"org1" as never} />);
    expect(screen.getByRole("status").textContent).toContain(dictionaries[locale].SuppliersRelationshipsLoading);
    view.unmount(); world.loading = false; world.error = true;
    const error = render(<SupplierVehicleTarget orgId={"org1" as never} />);
    expect(screen.getByRole("alert").textContent).toContain(dictionaries[locale].SuppliersRelationshipsError);
    expect(error.container.textContent).not.toContain("private lookup detail");
  }
});
