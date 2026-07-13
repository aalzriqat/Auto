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

  test("CreateDraftSaleSchema enforces the same relationship", () => {
    const result = CreateDraftSaleSchema.safeParse({ ...base, gapSold: 200 });
    expect(result.success).toBe(false);
  });
});
