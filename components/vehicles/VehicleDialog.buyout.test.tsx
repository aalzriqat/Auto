/**
 * SCRUM-717: a saved SOURCED car stores its consignment cost mirrored into
 * `purchasePrice`. Choosing Owned on such a car is a buy-out, and the buy-out price
 * must be a number the dealer types, never that inherited mirror.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/custom-fields/CustomFieldsSection", () => ({
  CustomFieldsSection: () => null,
  useSaveCustomFieldValues: () => async () => undefined,
}));

import { VehicleDialog } from "./VehicleDialog";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const updateSpy = () => mutationSpies.get("vehicles:update")!;

const storedVehicle = (sourceType: "SOURCED" | "STOCK") =>
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
      ? { sourcedFromName: "Gulf Motors", sourceCost: 9000, purchasePrice: 9000 }
      : { purchasePrice: 7000 }),
  }) as never;

const renderEdit = (sourceType: "SOURCED" | "STOCK" = "SOURCED") =>
  render(<VehicleDialog open onOpenChange={() => undefined} vehicle={storedVehicle(sourceType)} canEdit />);

const owned = () => screen.getByRole("button", { name: "VehicleOwnershipOwned" });
const consignment = () => screen.getByRole("button", { name: "VehicleOwnershipConsignment" });
const priceInput = () => screen.getByLabelText(/PurchasePrice/) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole("button", { name: "SaveChanges" }));

beforeEach(() => {
  mutationSpies.clear();
});
afterEach(cleanup);

describe("buying out a saved consignment car", () => {
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
    expect(sent).toMatchObject({ sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000, purchasePrice: 9000 });
    expect(sent).not.toHaveProperty("purchasePaymentMethod");
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
