import { describe, expect, test } from "vitest";
import { CreateSaleSchema, CreateDraftSaleSchema } from "./sales";

const base = {
  orgId: "org1",
  vehicleId: "veh1",
  customerId: "cust1",
  salespersonId: "sp1",
  salePrice: 15000,
  saleDate: Date.now(),
};

describe("CreateSaleSchema — warranty/GAP term required when a premium is charged", () => {
  test("rejects a warranty premium with no term", () => {
    const result = CreateSaleSchema.safeParse({ ...base, status: "COMPLETED", warrantySold: 500 });
    expect(result.success).toBe(false);
  });

  test("rejects a GAP premium with no term", () => {
    const result = CreateSaleSchema.safeParse({ ...base, status: "COMPLETED", gapSold: 200 });
    expect(result.success).toBe(false);
  });

  test("accepts a warranty premium with a term", () => {
    const result = CreateSaleSchema.safeParse({
      ...base, status: "COMPLETED", warrantySold: 500, warrantyTermMonths: 12,
    });
    expect(result.success).toBe(true);
  });

  test("rejects a term over 360 months", () => {
    const result = CreateSaleSchema.safeParse({
      ...base, status: "COMPLETED", warrantySold: 500, warrantyTermMonths: 361,
    });
    expect(result.success).toBe(false);
  });

  test("accepts a GAP premium with a term", () => {
    const result = CreateSaleSchema.safeParse({
      ...base, status: "COMPLETED", gapSold: 200, gapTermMonths: 12,
    });
    expect(result.success).toBe(true);
  });

  test("rejects a GAP term over 360 months", () => {
    const result = CreateSaleSchema.safeParse({
      ...base, status: "COMPLETED", gapSold: 200, gapTermMonths: 361,
    });
    expect(result.success).toBe(false);
  });

  test("CreateDraftSaleSchema enforces the same relationship", () => {
    const result = CreateDraftSaleSchema.safeParse({ ...base, gapSold: 200 });
    expect(result.success).toBe(false);
  });
});

describe("CreateSaleSchema — literal 0 defaults from the frontend form must not be rejected", () => {
  test("accepts termMonths/warrantyTermMonths/gapTermMonths all explicitly 0 (no financing/warranty/GAP used)", () => {
    // SaleDialog.tsx always sends these fields, defaulting to a literal 0 —
    // never undefined — regardless of whether financing/warranty/GAP is
    // actually used. z.optional() only skips validation for `undefined`, so
    // a min(1) bound here would reject this every-day, no-add-ons cash sale.
    const result = CreateSaleSchema.safeParse({
      ...base, status: "COMPLETED",
      financingType: "CASH", termMonths: 0,
      warrantySold: 0, warrantyCost: 0, warrantyTermMonths: 0,
      gapSold: 0, gapCost: 0, gapTermMonths: 0,
    });
    expect(result.success).toBe(true);
  });
});
