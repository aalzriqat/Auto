/**
 * SCRUM-717 (D-45). A CREATE request without a coherent sourceType cannot be
 * approved until the approver decides ownership; the decision is what reaches
 * `vehicleEdits.resolve` as its `ownership` argument.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

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

// The real picker is covered by SupplierSelect.test.tsx. Here it is a stand-in that picks a fixed supplier,
// so this file pins what the chooser does with the id it is handed.
vi.mock("@/components/suppliers/SupplierSelect", () => ({
  SupplierSelect: ({ dataTestId, onChange }: { dataTestId?: string; onChange: (s: { id: string; displayName: string }) => void }) => (
    <button type="button" data-testid={dataTestId} onClick={() => onChange({ id: "sup_atiwi", displayName: "Atiwi" })} />
  ),
}));

import {
  ApprovalOwnershipChooser,
  EMPTY_OWNERSHIP_DRAFT,
  buildOwnershipDecision,
  needsOwnershipDecision,
  type OwnershipDraft,
} from "./ApprovalOwnershipChooser";

afterEach(cleanup);

describe("needsOwnershipDecision", () => {
  test("only a payload that already names a real sourceType is approvable as-is", () => {
    expect(needsOwnershipDecision({})).toBe(true);
    expect(needsOwnershipDecision({ sourceType: undefined })).toBe(true);
    expect(needsOwnershipDecision({ sourceType: "" })).toBe(true);
    expect(needsOwnershipDecision({ sourceType: "banana" })).toBe(true);
    expect(needsOwnershipDecision(null)).toBe(true);
    expect(needsOwnershipDecision({ sourceType: "STOCK" })).toBe(false);
    expect(needsOwnershipDecision({ sourceType: "SOURCED" })).toBe(false);
  });
});

describe("buildOwnershipDecision", () => {
  const draft = (patch: Partial<OwnershipDraft>): OwnershipDraft => ({ ...EMPTY_OWNERSHIP_DRAFT, ...patch });
  const SUPPLIER = "sup_atiwi" as OwnershipDraft["sourcedSupplierId"];

  test("nothing chosen is no decision", () => {
    expect(buildOwnershipDecision(draft({}))).toBeNull();
    expect(buildOwnershipDecision(undefined)).toBeNull();
  });

  test("consignment needs a supplier and a positive cost, and carries no purchase fields", () => {
    expect(buildOwnershipDecision(draft({ sourceType: "SOURCED", sourcedSupplierId: SUPPLIER, sourcedFromName: "Atiwi" }))).toBeNull();
    expect(buildOwnershipDecision(draft({ sourceType: "SOURCED", sourceCost: "9000" }))).toBeNull();
    expect(buildOwnershipDecision(draft({ sourceType: "SOURCED", sourcedSupplierId: SUPPLIER, sourceCost: "0" }))).toBeNull();
    expect(
      buildOwnershipDecision(
        draft({ sourceType: "SOURCED", sourcedSupplierId: SUPPLIER, sourcedFromName: "Atiwi", sourceCost: "9000", purchasePrice: "1", purchasePaymentMethod: "CASH" }),
      ),
    ).toEqual({ sourceType: "SOURCED", sourcedSupplierId: SUPPLIER, sourceCost: 9000 });
  });

  test("a supplier NAME without a picked id is no decision, and no name is ever submitted", () => {
    expect(buildOwnershipDecision(draft({ sourceType: "SOURCED", sourcedFromName: "Atiwi", sourceCost: "9000" }))).toBeNull();
    const base = draft({ sourceType: "STOCK", purchasePrice: "10000", purchasePaymentMethod: "ON_ACCOUNT" });
    expect(buildOwnershipDecision({ ...base, purchaseSupplierName: "Atiwi" })).toBeNull();
  });

  test("owned needs a price and a method, and carries no consignment fields", () => {
    expect(buildOwnershipDecision(draft({ sourceType: "STOCK", purchasePrice: "10000" }))).toBeNull();
    expect(buildOwnershipDecision(draft({ sourceType: "STOCK", purchasePaymentMethod: "CASH" }))).toBeNull();
    expect(
      buildOwnershipDecision(
        draft({ sourceType: "STOCK", purchasePrice: "10000", purchasePaymentMethod: "CASH", sourcedFromName: "stale", sourceCost: "5" }),
      ),
    ).toEqual({ sourceType: "STOCK", purchasePrice: 10000, purchasePaymentMethod: "CASH" });
  });

  test("owned ON_ACCOUNT also needs the creditor, sent as purchaseSupplierId", () => {
    const base = draft({ sourceType: "STOCK", purchasePrice: "10000", purchasePaymentMethod: "ON_ACCOUNT" });
    expect(buildOwnershipDecision(base)).toBeNull();
    expect(buildOwnershipDecision({ ...base, purchaseSupplierId: SUPPLIER, purchaseSupplierName: " Atiwi " })).toEqual({
      sourceType: "STOCK",
      purchasePrice: 10000,
      purchasePaymentMethod: "ON_ACCOUNT",
      purchaseSupplierId: SUPPLIER,
    });
  });

  test("bank-funded approval waits for a bank and carries its exact identity", () => {
    const base = draft({ sourceType: "STOCK", purchasePrice: "10000", purchasePaymentMethod: "BANK_TRANSFER" });
    expect(buildOwnershipDecision(base)).toBeNull();
    const bankAccountId = "bank_test_1" as OwnershipDraft["bankAccountId"];
    expect(buildOwnershipDecision({ ...base, bankAccountId })).toEqual({
      sourceType: "STOCK", purchasePrice: 10000, purchasePaymentMethod: "BANK_TRANSFER", bankAccountId,
    });
  });
});

describe("ApprovalOwnershipChooser", () => {
  function Harness({ onDecision }: { onDecision: (d: ReturnType<typeof buildOwnershipDecision>) => void }) {
    const [value, setValue] = useState<OwnershipDraft>(EMPTY_OWNERSHIP_DRAFT);
    onDecision(buildOwnershipDecision(value));
    return <ApprovalOwnershipChooser idPrefix="own-test" draft={value} onChange={setValue} t={(key: string) => key} />;
  }

  test("starts with nothing chosen and walks the approver to a complete decision", () => {
    const seen: Array<ReturnType<typeof buildOwnershipDecision>> = [];
    render(<Harness onDecision={(d) => seen.push(d)} />);
    expect(screen.getByRole("button", { name: "VehicleOwnershipOwned" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "VehicleOwnershipConsignment" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("VehicleOwnershipChoiceRequired");
    expect(seen.at(-1)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "VehicleOwnershipOwned" }));
    fireEvent.change(screen.getByLabelText(/PurchasePrice/), { target: { value: "12000" } });
    fireEvent.click(screen.getByTestId("item-ON_ACCOUNT"));
    expect(seen.at(-1)).toBeNull();
    fireEvent.click(screen.getByTestId("own-test-creditor"));
    expect(seen.at(-1)).toEqual({
      sourceType: "STOCK",
      purchasePrice: 12000,
      purchasePaymentMethod: "ON_ACCOUNT",
      purchaseSupplierId: "sup_atiwi",
    });
  });
});
