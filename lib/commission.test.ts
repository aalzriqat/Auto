import { describe, it, expect } from "vitest";
import { calculateCommission, getAppliedTier } from "./commission";

const tiers = [
  { minProfitAmount: 0, commissionPct: 2 },
  { minProfitAmount: 1000, commissionPct: 5 },
  { minProfitAmount: 5000, commissionPct: 8 },
];

describe("calculateCommission", () => {
  it("returns 0 when no tiers configured", () => {
    expect(calculateCommission(5000, [])).toBe(0);
  });

  it("applies the lowest tier for profit at its minimum", () => {
    // profit=0 qualifies for tier minProfitAmount=0 at 2%
    expect(calculateCommission(0, tiers)).toBe(0); // 0 * 2% = 0
    expect(calculateCommission(500, tiers)).toBe(10); // 500 * 2% = 10
  });

  it("applies the correct tier as profit increases", () => {
    expect(calculateCommission(1000, tiers)).toBe(50); // 1000 * 5% = 50
    expect(calculateCommission(2000, tiers)).toBe(100); // 2000 * 5% = 100
  });

  it("applies the highest qualifying tier", () => {
    expect(calculateCommission(5000, tiers)).toBe(400); // 5000 * 8% = 400
    expect(calculateCommission(10000, tiers)).toBe(800); // 10000 * 8% = 800
  });

  it("sorts tiers regardless of input order", () => {
    const unsorted = [
      { minProfitAmount: 5000, commissionPct: 8 },
      { minProfitAmount: 0, commissionPct: 2 },
      { minProfitAmount: 1000, commissionPct: 5 },
    ];
    expect(calculateCommission(3000, unsorted)).toBe(150); // 3000 * 5%
  });

  it("handles a single tier", () => {
    const single = [{ minProfitAmount: 100, commissionPct: 10 }];
    expect(calculateCommission(200, single)).toBe(20);
    expect(calculateCommission(50, single)).toBe(0); // below tier, pct stays 0
  });
});

describe("getAppliedTier", () => {
  it("returns null when no tiers", () => {
    expect(getAppliedTier(1000, [])).toBeNull();
  });

  it("returns the highest qualifying tier", () => {
    const tier = getAppliedTier(5000, tiers);
    expect(tier?.commissionPct).toBe(8);
  });

  it("returns the correct tier at boundary", () => {
    const tier = getAppliedTier(1000, tiers);
    expect(tier?.commissionPct).toBe(5);
  });

  it("returns null when profit is below all tiers", () => {
    const strictTiers = [{ minProfitAmount: 500, commissionPct: 5 }];
    // profit 200 < 500, no tier qualifies
    expect(getAppliedTier(200, strictTiers)).toBeNull();
  });
});
