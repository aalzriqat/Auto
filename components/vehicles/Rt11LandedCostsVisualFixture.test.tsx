/** SCRUM-760 c23862: real dialog, navigation and input handlers before static paint. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { PERMISSIONS } from "@/convex/utils/permissions";

const fixture = vi.hoisted(() => ({ state: "paid" }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/vehicles", useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const paid = { items: [{ label: "Synthetic paid cost", amount: 100, paymentMethod: "CASH" }], total: 100 };
  const empty: never[] = [];
  const relations = { testDrives: [], workOrders: [], leads: [], sales: [], tasks: [], expenses: [] };
  const settings = { currency: "JOD" };
  return { useConvexAuth: () => ({ isAuthenticated: true }), useMutation: () => vi.fn(), useAction: () => vi.fn(),
    usePaginatedQuery: () => ({ results: empty, status: "Exhausted", loadMore: vi.fn() }),
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      switch (getFunctionName(reference)) {
        case "organizations:listMine": return [{ _id: "org-a" }];
        case "memberships:getMyMembership": return { permissions: [PERMISSIONS.EDIT_VEHICLES, PERMISSIONS.VIEW_COST_PRICE, PERMISSIONS.VIEW_VEHICLE_INFO] };
        case "orgSettings:get": return settings;
        case "vehicles:getRelations": return relations;
        case "vehicles:getLandedCosts": return fixture.state === "loading" ? undefined : fixture.state === "empty" ? null : paid;
        case "vehicles:listAcquisitionBankOptions": return { banks: [], truncated: false };
        case "customers:list": return { page: [] };
        case "vehicles:getPricingHistory": case "vehicles:getReservationHistory":
        case "deposits:listByVehicle": case "finance:listCompanies": case "finance:listValuations": return empty;
        // Inactive marketing group still mounts its reads; no connection or vehicle is returned.
        case "vehicles:get": case "socialIntegrations:getConnectionStatus":
        case "facebookIntegrations:getConnectionStatus": return null;
        case "socialPostingData:listForVehicle": return empty;
        default: throw new Error(`Unexpected RT11 vehicle query: ${getFunctionName(reference)}`);
      }
    } };
});
const { VehicleDetailsDialog } = await import(process.env.RT11_LANDED_COMPONENT || "./VehicleDetailsDialog") as typeof import("./VehicleDetailsDialog");
const vehicle: Doc<"vehicles"> = { _id: "vehicle-a" as Id<"vehicles">, _creationTime: 1,
  orgId: "org-a" as Id<"organizations">, year: 2024, make: "Toyota", model: "Camry",
  status: "AVAILABLE", sourceType: "STOCK", mileage: 1000, sellingPrice: 20000, purchasePrice: 15000,
  vin: "SYNTHETIC", color: "White", fuelType: "PETROL", transmission: "AUTOMATIC" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test.each(["en", "ar"] as const)("RT11 landed cost markup %s", (locale) => {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  const t = dictionaries[locale];
  for (const state of ["paid", "negative", "positive", "loading", "empty"]) {
    fixture.state = state;
    render(<OrgProvider><LanguageProvider><VehicleDetailsDialog vehicle={vehicle} open onOpenChange={() => {}} canViewPurchasePrice /></LanguageProvider></OrgProvider>);
    fireEvent.click(screen.getByRole("button", { name: t.Financials }));
    if (state === "negative" || state === "positive") {
      fireEvent.click(screen.getByRole("button", { name: t.AddCostItem }));
      const amounts = screen.getAllByRole("spinbutton");
      fireEvent.change(amounts[amounts.length - 1], { target: { value: state === "negative" ? "-25" : "25" } });
    }
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
    const directory = process.env.RT11_LANDED_FIXTURE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, `landed-${locale}-${state}.html`), document.body.innerHTML);
    }
    cleanup();
  }
});
