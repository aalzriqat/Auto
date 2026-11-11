import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
  OPENING_STOCK_PROOF_VIN_LIMIT,
  orphanedOpeningStockProofs,
  refuseOrphanedOpeningStockProofs,
} from "./openingStockProofRefusal";

function refusalFor(vins: string[]): { code: string; message: string; count: number; vins: string; more: number } {
  try {
    refuseOrphanedOpeningStockProofs(vins);
  } catch (error) {
    if (error instanceof ConvexError) return error.data;
  }
  throw new Error("expected a ConvexError");
}

describe("SCRUM-944 orphaned opening-stock proof refusal", () => {
  test("proofs whose car is not a live costed owned car are the orphans, in evidence order", () => {
    const evidence = [
      { vehicleId: "c", vin: "VIN-C" },
      { vehicleId: "a", vin: "VIN-A" },
      { vehicleId: "b", vin: "VIN-B" },
    ];
    expect(orphanedOpeningStockProofs(evidence, new Set(["a"])).map((proof) => proof.vin)).toEqual(["VIN-C", "VIN-B"]);
    expect(orphanedOpeningStockProofs(evidence, new Set(["a", "b", "c"]))).toEqual([]);
  });

  test("the refusal names the VINs in a stable sorted order whatever order the evidence arrived in", () => {
    const refusal = refusalFor(["VIN-C", "VIN-A", "VIN-B"]);
    expect(refusal).toMatchObject({ code: "OPENING_STOCK_PROOF_ORPHANED", count: 3, vins: "VIN-A, VIN-B, VIN-C", more: 0 });
    expect(refusal.message).toContain("VINs: VIN-A, VIN-B, VIN-C.");
  });

  test("the refusal lists the first ten sorted VINs and counts the rest", () => {
    const vins = Array.from({ length: 12 }, (_, index) => `VIN-${String(12 - index).padStart(2, "0")}`);
    const refusal = refusalFor(vins);
    expect(OPENING_STOCK_PROOF_VIN_LIMIT).toBe(10);
    expect(refusal.count).toBe(12);
    expect(refusal.more).toBe(2);
    expect(refusal.vins.split(", ")).toEqual(Array.from({ length: 10 }, (_, index) => `VIN-${String(index + 1).padStart(2, "0")}`));
  });
});
