/**
 * The sale form's refusal of tax on an agency sale.
 *
 * `consignedAgentSaleLines` will not post a taxed consigned sale — deliberately,
 * because every available posting either misstates money or invents tax policy.
 * The rule is right; meeting it as a failed save is not. And it is not always a
 * refusal: completion posts through `postOrEnqueue`, so with no open period the
 * sale is ACCEPTED and its journal dead-letters on the next drain with nobody
 * told. This screen is what stands in front of that.
 *
 * The guard itself is `lib/consignedTaxGuard` and is unit-tested there. These
 * tests exist for the half that has failed twice on this branch already — the
 * wiring. A correct rule the component never consults reads exactly like a
 * working one.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Doc, Id } from "../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Keyed on the function's path, for the same reason ConsignedSettlementSection's
// tests are: `api` hands back a fresh proxy per property access.
const stubs = vi.hoisted(() => ({ queryResults: new Map<string, unknown>(), updateSale: vi.fn() }));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: (reference: never) => getFunctionName(reference) === "sales:update" ? stubs.updateSale : vi.fn(),
  };
});

const { queryResults } = stubs;

import { SaleDialog } from "./SaleDialog";

const ORG = "org1" as Id<"organizations">;
const SOURCED = "carSourced" as Id<"vehicles">;
const OWNED = "carOwned" as Id<"vehicles">;

function vehicle(id: Id<"vehicles">, sourceType: "STOCK" | "SOURCED") {
  return {
    _id: id,
    orgId: ORG,
    make: "Toyota",
    model: "Camry",
    year: 2024,
    vin: `VIN${id}`,
    sellingPrice: 12_500,
    status: "AVAILABLE",
    sourceType,
    ...(sourceType === "SOURCED"
      ? { sourcedFromName: "Amman Importer Co", sourceCost: 9_500 }
      : { purchasePrice: 9_500 }),
  } as unknown as Doc<"vehicles">;
}

/**
 * Opened on an existing deal rather than driven through the vehicle picker:
 * the guard reads the selected vehicle and the tax field, and an edit supplies
 * both directly. It is also the real shape of the risk — a draft consigned sale
 * being completed.
 */
function saleOn(
  vehicleId: Id<"vehicles">,
  taxAmount: number,
  status: "COMPLETED" | "PENDING" | "CANCELLED" = "COMPLETED"
) {
  return {
    _id: "sale1" as Id<"sales">,
    _creationTime: Date.now(),
    orgId: ORG,
    vehicleId,
    customerId: "cust1" as Id<"customers">,
    salespersonId: "user1" as Id<"users">,
    salePrice: 12_500,
    saleDate: Date.now(),
    // COMPLETED by default, because that is the status that posts. A draft is
    // deliberately let through — `consignedTaxGuard`'s own tests pin that half.
    status,
    taxAmount,
  } as unknown as Doc<"sales">;
}

function openWith(sale: Doc<"sales">) {
  return render(<SaleDialog open onOpenChange={() => {}} sale={sale} />);
}

const submitButton = () =>
  screen.getByRole("button", { name: /SaveChanges/ }) as HTMLButtonElement;

beforeEach(() => {
  cleanup();
  queryResults.clear();
  stubs.updateSale.mockReset().mockResolvedValue(undefined);
  queryResults.set("vehicles:listAll", [
    vehicle(SOURCED, "SOURCED"),
    vehicle(OWNED, "STOCK"),
  ]);
});

describe("tax on a consigned sale, in the form", () => {
  test("names the refusal on the tax field and will not let the sale be saved", async () => {
    openWith(saleOn(SOURCED, 500));

    await waitFor(() => {
      expect(screen.queryByText("ConsignedTaxUnsupported")).not.toBeNull();
    });
    expect(submitButton().disabled).toBe(true);
  });

  test("says nothing about the dealership's own stock", async () => {
    // The principal rule posts tax on owned sales and always has. A guard that
    // fired here would break every ordinary taxed deal.
    openWith(saleOn(OWNED, 500));

    await waitFor(() => {
      expect(screen.queryByText("ConsignedTaxUnsupported")).toBeNull();
    });
    expect(submitButton().disabled).toBe(false);
  });

  test("does not block CANCELLING a consigned deal that carries tax", async () => {
    // Cancelling posts nothing at all — sales.ts gates every reversal on
    // COMPLETED — so there is no journal to refuse. The guard originally read
    // "anything that is not PENDING is a completion", which caught CANCELLED
    // too and told the operator to clear the tax "to record the sale" on a
    // deal they were trying not to record. Clearing it would then have written
    // the zero to the row on the way out, destroying the recorded tax.
    openWith(saleOn(SOURCED, 500, "CANCELLED"));

    await waitFor(() => {
      expect(screen.queryByText("ConsignedTaxUnsupported")).toBeNull();
    });
    expect(submitButton().disabled).toBe(false);
  });

  test("clearing the tax releases the form — the remedy is on this screen", async () => {
    // The lockout this branch already shipped once: a refusal that outlives the
    // very correction it asks for. Clearing the field must restore the button.
    openWith(saleOn(SOURCED, 500));
    await waitFor(() =>
      expect(screen.queryByText("ConsignedTaxUnsupported")).not.toBeNull()
    );

    fireEvent.change(screen.getByLabelText("Taxes"), { target: { value: "" } });

    await waitFor(() => {
      expect(screen.queryByText("ConsignedTaxUnsupported")).toBeNull();
    });
  });
});

describe("cash sale cancellation", () => {
  test.each([false, true])("submits only cancellation intent with legacy warranty fields: %s", async (legacyWarranty) => {
    const sale = { ...saleOn(OWNED, 500), financingType: "CASH" as const,
      ...(legacyWarranty ? { warrantySold: 100, warrantyTermMonths: undefined } : {}) };
    openWith(sale);

    const status = Array.from(document.querySelectorAll("select")).find((select) =>
      Array.from(select.options).some((option) => option.value === "CANCELLED"));
    expect(status).toBeDefined();
    fireEvent.change(status!, { target: { value: "CANCELLED" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(stubs.updateSale).toHaveBeenCalledExactlyOnceWith({
      orgId: ORG,
      saleId: sale._id,
      status: "CANCELLED",
    }));
  });
});

describe("editing an already-cancelled sale", () => {
  test.each([false, true])("saves validated edits on an already-cancelled sale, application-linked: %s", async (applicationLinked) => {
    // SCRUM-476 G1: keeping CANCELLED selected is an edit, not a new cancel intent.
    openWith({
      ...saleOn(OWNED, 500, "CANCELLED"),
      saleDate: 1_735_689_600_000,
      financingType: "CASH",
      ...(applicationLinked ? { applicationId: "application1" as Id<"financeApplications"> } : {}),
    });

    fireEvent.change(screen.getByLabelText(/SalePriceJOD/), { target: { value: "13750" } });
    fireEvent.change(screen.getByLabelText("Taxes"), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("DealerFees"), { target: { value: "125" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(stubs.updateSale).toHaveBeenCalledExactlyOnceWith({
      orgId: "org1",
      saleId: "sale1",
      salePrice: 13_750,
      saleDate: 1_735_689_600_000,
      status: "CANCELLED",
      taxRate: 0,
      taxAmount: 600,
      dealerFees: 125,
      downPayment: 0,
      tradeInVehicleId: undefined,
      tradeInValue: 0,
      apr: 0,
      termMonths: 0,
      warrantySold: 0,
      warrantyCost: 0,
      warrantyTermMonths: 0,
      gapSold: 0,
      gapCost: 0,
      gapTermMonths: 0,
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
    }));
  });
});
