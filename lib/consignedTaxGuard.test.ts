import { describe, expect, test } from "vitest";
import { consignedTaxRefusal } from "./consignedTaxGuard";

const completed = { status: "COMPLETED" as const };

describe("the sale form's consigned-tax guard", () => {
  test("refuses a completed consigned sale carrying tax", () => {
    expect(consignedTaxRefusal({ isSourced: true, taxAmount: 500, ...completed })).toBe(
      "CONSIGNED_TAX_UNSUPPORTED"
    );
  });

  test("says nothing about the dealership's own stock", () => {
    // The principal rule posts tax on owned sales and always has. Refusing it
    // here would break every ordinary taxed deal to guard a consigned one.
    expect(consignedTaxRefusal({ isSourced: false, taxAmount: 500, ...completed })).toBeNull();
  });

  test("says nothing while the vehicle's basis is still unknown", () => {
    // `undefined` is the vehicle query in flight, not "owned". Refusing on it
    // would flash a refusal on every consigned sale as the dialog opens.
    expect(consignedTaxRefusal({ isSourced: undefined, taxAmount: 500, ...completed })).toBeNull();
  });

  test("lets a consigned draft through", () => {
    // A PENDING sale posts no journal, so there is nothing to refuse yet. An
    // operator may legitimately save a draft while the tax question is open.
    expect(
      consignedTaxRefusal({ isSourced: true, taxAmount: 500, status: "PENDING" })
    ).toBeNull();
  });

  test("treats an untouched or cleared tax field as no tax", () => {
    for (const taxAmount of [undefined, 0, NaN]) {
      expect(consignedTaxRefusal({ isSourced: true, taxAmount, ...completed })).toBeNull();
    }
  });

  test("does not refuse a negative tax, which is a different complaint", () => {
    // Nothing is collected, so the agency question does not arise. The field's
    // own validation owns this, and answering it here would put the wrong
    // explanation on the screen.
    expect(consignedTaxRefusal({ isSourced: true, taxAmount: -10, ...completed })).toBeNull();
  });
});
