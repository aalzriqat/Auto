/**
 * SCRUM-717 (D-45). A new vehicle carries an explicit ownership decision:
 *   - Add Vehicle pre-selects neither consignment nor owned;
 *   - consignment asks for the supplier and the supplier cost, never a purchase price;
 *   - owned asks for the purchase price and how it was paid;
 *   - an owned car bought ON ACCOUNT asks who is owed, in its own field.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
}));
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

// Radix's Checkbox measures itself; jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

afterEach(cleanup);

const renderCreate = () =>
  render(<VehicleDialog open onOpenChange={() => undefined} canCreate canEdit />);

const owned = () => screen.getByRole("button", { name: "VehicleOwnershipOwned" });
const consignment = () => screen.getByRole("button", { name: "VehicleOwnershipConsignment" });

describe("SCRUM-717 - Add Vehicle ownership has no default", () => {
  test("neither choice is pre-selected and the dealer is told to choose", () => {
    renderCreate();
    expect(owned().getAttribute("aria-pressed")).toBe("false");
    expect(consignment().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("VehicleOwnershipChoiceRequired")).toBeTruthy();
    // Nothing that belongs to a chosen shape is on screen yet.
    expect(screen.queryByText(/PurchasePrice/)).toBeNull();
    expect(screen.queryByText(/SourceDealerName/)).toBeNull();
    expect(screen.queryByText(/PurchaseSupplierName/)).toBeNull();
  });

  test("consignment asks for the supplier and the supplier cost, not a purchase price", () => {
    renderCreate();
    fireEvent.click(consignment());
    expect(consignment().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/SourceDealerName/)).toBeTruthy();
    expect(screen.getByText(/SupplierCost/)).toBeTruthy();
    expect(screen.queryByText(/PurchasePrice/)).toBeNull();
    expect(screen.queryByText("VehicleOwnershipChoiceRequired")).toBeNull();
  });

  test("owned asks for the purchase price and the payment method, not a consignment supplier", () => {
    renderCreate();
    fireEvent.click(owned());
    expect(owned().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/PurchasePrice/)).toBeTruthy();
    expect(screen.getByText("PaymentMethodLabel")).toBeTruthy();
    expect(screen.queryByText(/SourceDealerName/)).toBeNull();
    expect(screen.queryByText(/SupplierCost/)).toBeNull();
  });

  test("an owned purchase ON ACCOUNT asks who is owed, in its own field", () => {
    renderCreate();
    fireEvent.click(owned());
    expect(screen.queryByText(/PurchaseSupplierName/)).toBeNull();
    fireEvent.click(screen.getByTestId("item-ON_ACCOUNT"));
    expect(screen.getByText(/PurchaseSupplierName/)).toBeTruthy();
    // It is the creditor field, not the consignment supplier field.
    expect(screen.queryByText(/SourceDealerName/)).toBeNull();
    // A settled method does not ask who is owed.
    fireEvent.click(screen.getByTestId("item-CASH"));
    expect(screen.queryByText(/PurchaseSupplierName/)).toBeNull();
  });
});
