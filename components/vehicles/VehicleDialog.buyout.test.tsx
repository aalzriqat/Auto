/**
 * SCRUM-717: a saved SOURCED car stores its consignment cost mirrored into
 * `purchasePrice`. Choosing Owned on such a car is a buy-out, and the buy-out price
 * must be a number the dealer types, never that inherited mirror.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import type { SupplierSelectProps } from "@/components/suppliers/SupplierSelect";
import type { VehicleFormValues } from "./vehicle.schema";

const mutationSpies = vi.hoisted(() => new Map<string, ReturnType<typeof import("vitest").vi.fn>>());

vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const Ctx = React.createContext<(v: string) => void>(() => undefined);
  return {
    Select: ({ onValueChange, children }: { onValueChange: (v: string) => void; children: React.ReactNode }) => (
      <Ctx.Provider value={onValueChange}>{children}</Ctx.Provider>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value }: { value: string }) => {
      const pick = React.useContext(Ctx);
      return <button type="button" data-testid={`item-${value}`} onClick={() => pick(value)} />;
    },
  };
});
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: () => ({ locked: false }),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      if (!mutationSpies.has(name)) mutationSpies.set(name, vi.fn(async () => undefined));
      return mutationSpies.get(name)!;
    },
  };
});
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => rt11.disabled ? ((rt11.locale === "en" ? commonEn : commonAr) as Record<string, string>)[key] ?? key : key,
    isRtl: rt11.locale === "ar", locale: rt11.locale,
  }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/custom-fields/CustomFieldsSection", () => ({
  CustomFieldsSection: () => null,
  useSaveCustomFieldValues: () => async () => undefined,
}));
vi.mock("@/components/suppliers/SupplierSelect", async () => {
  const { useFormContext } = await import("react-hook-form");
  return {
    SupplierSelect: ({ dataTestId, onChange }: Pick<SupplierSelectProps, "dataTestId" | "onChange">) => {
      const form = useFormContext<VehicleFormValues>();
      const field = dataTestId === "vehicle-sourced-supplier" ? "sourcedSupplierId" : "purchaseSupplierId";
      return <>
        <button type="button" onClick={() => onChange({ id: "sup_picked" as Id<"suppliers">, displayName: "Picked supplier" })}>Pick supplier</button>
        <button type="button" onClick={() => form.setValue(field, "unparsed-supplier")}>Tamper supplier ID</button>
      </>;
    },
  };
});

import { VehicleDialog } from "./VehicleDialog";
import { toast } from "@/components/ui/sonner";
import { commonAr, commonEn } from "@/lib/i18n/domains/common";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const updateSpy = () => mutationSpies.get("vehicles:update")!;

const storedVehicle = (sourceType: "SOURCED" | "STOCK", withSupplierId = true) =>
  ({
    _id: "veh_1",
    orgId: "org_1",
    vin: "1HGCM82633A000001",
    make: "Honda",
    model: "Accord",
    year: 2020,
    mileage: 10000,
    color: "White",
    fuelType: "Gasoline",
    transmission: "Automatic",
    sellingPrice: 20000,
    status: sourceType === "SOURCED" ? "SOURCING" : "AVAILABLE",
    sourceType,
    ...(sourceType === "SOURCED"
      ? {
          sourcedFromName: "Gulf Motors",
          // A vehicle that predates SCRUM-868 has the name only.
          ...(withSupplierId ? { sourcedSupplierId: "sup_gulf" } : {}),
          sourceCost: 9000,
          purchasePrice: 9000,
        }
      : { purchasePrice: 7000 }),
  }) as never;

const renderEdit = (sourceType: "SOURCED" | "STOCK" = "SOURCED", withSupplierId = true) =>
  render(<VehicleDialog open onOpenChange={() => undefined} vehicle={storedVehicle(sourceType, withSupplierId)} canEdit />);

const owned = () => screen.getByRole("button", { name: "VehicleOwnershipOwned" });
const consignment = () => screen.getByRole("button", { name: "VehicleOwnershipConsignment" });
const priceInput = () => screen.getByLabelText(/PurchasePrice/) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole("button", { name: "SaveChanges" }));

beforeEach(() => {
  mutationSpies.clear();
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

describe("buying out a saved consignment car", () => {
  test("an unparsed form supplier ID never reaches the mutation", async () => {
    renderEdit();
    fireEvent.click(screen.getByRole("button", { name: "Tamper supplier ID" }));
    save();
    await waitFor(() => expect(vi.mocked(toast.error).mock.calls.length + updateSpy().mock.calls.length).toBeGreaterThan(0));
    expect(updateSpy()).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("SupplierSelectionStale");
  });

  test("a newly picked supplier replaces the stored ID without sending its name", async () => {
    renderEdit();
    fireEvent.click(screen.getByRole("button", { name: "Pick supplier" }));
    save();
    await waitFor(() => expect(updateSpy()).toHaveBeenCalledTimes(1));
    expect(updateSpy().mock.calls[0][0]).toMatchObject({ sourcedSupplierId: "sup_picked" });
    expect(updateSpy().mock.calls[0][0]).not.toHaveProperty("sourcedFromName");
  });

  test.each([false, true])("ON_ACCOUNT uses the picked creditor and refuses an unparsed ID (tampered: %s)", async (tampered) => {
    renderEdit();
    fireEvent.click(owned());
    fireEvent.click(screen.getByTestId("item-ON_ACCOUNT"));
    fireEvent.change(priceInput(), { target: { value: "8200" } });
    fireEvent.click(screen.getByRole("button", { name: "Pick supplier" }));
    if (tampered) fireEvent.click(screen.getByRole("button", { name: "Tamper supplier ID" }));
    save();
    await waitFor(() => expect(vi.mocked(toast.error).mock.calls.length + updateSpy().mock.calls.length).toBeGreaterThan(0));
    if (tampered) {
      expect(updateSpy()).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith("SupplierSelectionStale");
    } else {
      expect(updateSpy().mock.calls[0][0]).toMatchObject({ purchaseSupplierId: "sup_picked", purchasePrice: 8200 });
      expect(updateSpy().mock.calls[0][0]).not.toHaveProperty("purchaseSupplierName");
    }
  });

  test("Owned + a method, without typing a price, is refused client-side and does not call vehicles.update", async () => {
    renderEdit();
    fireEvent.click(owned());
    fireEvent.click(screen.getByTestId("item-CASH"));
    // The inherited consignment mirror is not offered as the buy-out price.
    expect(priceInput().value).not.toBe("9000");
    save();
    expect(await screen.findByText("VehicleBuyoutTermsRequired")).toBeTruthy();
    expect(updateSpy()).not.toHaveBeenCalled();
  });

  test("a typed 8200 is submitted as the purchase price", async () => {
    renderEdit();
    fireEvent.click(owned());
    fireEvent.click(screen.getByTestId("item-CASH"));
    fireEvent.change(priceInput(), { target: { value: "8200" } });
    save();
    await waitFor(() => expect(updateSpy()).toHaveBeenCalledTimes(1));
    expect(updateSpy().mock.calls[0][0]).toMatchObject({
      sourceType: "STOCK", purchasePrice: 8200, purchasePaymentMethod: "CASH",
    });
  });

  test("deliberately typing 9000 submits 9000", async () => {
    renderEdit();
    fireEvent.click(owned());
    fireEvent.click(screen.getByTestId("item-CASH"));
    fireEvent.change(priceInput(), { target: { value: "9000" } });
    save();
    await waitFor(() => expect(updateSpy()).toHaveBeenCalledTimes(1));
    expect(updateSpy().mock.calls[0][0]).toMatchObject({ sourceType: "STOCK", purchasePrice: 9000 });
  });

  test("switching back to Consignment restores the stored mirror and sends no buy-out terms", async () => {
    renderEdit();
    fireEvent.click(owned());
    fireEvent.click(consignment());
    save();
    await waitFor(() => expect(updateSpy()).toHaveBeenCalledTimes(1));
    const sent = updateSpy().mock.calls[0][0];
    // The supplier travels as its master id only; the typed or stored name is never submitted.
    expect(sent).toMatchObject({ sourceType: "SOURCED", sourcedSupplierId: "sup_gulf", sourceCost: 9000, purchasePrice: 9000 });
    expect(sent).not.toHaveProperty("sourcedFromName");
    expect(sent).not.toHaveProperty("purchasePaymentMethod");
  });

  test("a legacy consignment car (name only, no supplier id) still saves an ordinary edit and sends no supplier at all", async () => {
    renderEdit("SOURCED", false);
    save();
    await waitFor(() => expect(updateSpy()).toHaveBeenCalledTimes(1));
    const sent = updateSpy().mock.calls[0][0];
    expect(sent).toMatchObject({ sourceType: "SOURCED", sourceCost: 9000 });
    expect(sent).not.toHaveProperty("sourcedFromName");
    expect(sent).not.toHaveProperty("sourcedSupplierId");
  });

  test("an owned car's stored purchase price is untouched (not a buy-out)", async () => {
    renderEdit("STOCK");
    expect(priceInput().value).toBe("7000");
    save();
    await waitFor(() => expect(updateSpy()).toHaveBeenCalledTimes(1));
    expect(updateSpy().mock.calls[0][0]).toMatchObject({ sourceType: "STOCK", purchasePrice: 7000 });
  });
});

describe("new-vehicle owned intake", () => {
  test("is unchanged: Owned shows the price field empty of any inherited amount and requires a method once priced", async () => {
    render(<VehicleDialog open onOpenChange={() => undefined} canCreate canEdit />);
    fireEvent.click(owned());
    expect(priceInput().value).toBe("0");
    fireEvent.change(priceInput(), { target: { value: "5000" } });
    expect(priceInput().value).toBe("5000");
  });
});


// Historical UI mechanics keep these doors open; RT11 tests below use the REAL shipped switch.
const rt11 = vi.hoisted(() => ({ disabled: false, locale: "en" as "en" | "ar" }));
vi.mock("@/convex/utils/rt11DoorContainment", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/convex/utils/rt11DoorContainment")>();
  return { ...original, isRt11DoorDisabled: (code: import("@/convex/utils/rt11DoorContainment").Rt11DoorCode) => rt11.disabled && original.isRt11DoorDisabled(code) };
});
afterEach(() => { rt11.disabled = false; rt11.locale = "en"; });

test("RT11 saved vehicle ownership choice stays disabled", () => {
  rt11.disabled = true;
  for (const locale of ["en", "ar"] as const) {
    rt11.locale = locale;
    renderEdit();
    expect((owned() as HTMLButtonElement).disabled).toBe(true);
    expect((consignment() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText((locale === "en" ? commonEn : commonAr).ServerError_VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED)).toBeTruthy();
    fireEvent.click(owned());
    expect(consignment().getAttribute("aria-pressed")).toBe("true");
    expect(updateSpy()).not.toHaveBeenCalled();
    cleanup();
  }
});
