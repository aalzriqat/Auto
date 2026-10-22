/**
 * SCRUM-411 - which deals the recognition model covers on the direct-to-supplier
 * route. Only plan v3 describes that route, so a deal that CLOSED under v0/v1/v2
 * must stay outside it (it posted the way it always did), while a deal that has
 * not finalized yet is covered prospectively. Pure: no database.
 */
import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { financedSaleRecognitionApplies } from "./financedSaleRecognition";
import { isForwardPlan, isForwardPlanVersion, isServerDerivedPlanVersion } from "./financedSalePostingPlan";

const app = (over: Partial<Doc<"financeApplications">> = {}): Doc<"financeApplications"> =>
  ({ companyId: "company" as Id<"financeCompanies">, ...over }) as Doc<"financeApplications">;

const FINALIZED: Partial<Doc<"financeApplications">> = { finalizedSaleId: "sale" as Id<"sales"> };

describe("direct-to-supplier recognition coverage follows the deal's own plan version", () => {
  test.each<[string, Partial<Doc<"financeApplications">>]>([
    ["v1", { ...FINALIZED, financedSalePlanVersion: 1 }],
    ["v2", { ...FINALIZED, financedSalePlanVersion: 2 }],
    ["a pre-plan deal (no version, no fingerprint)", { ...FINALIZED }],
    ["a v1 fingerprint with no version field", { ...FINALIZED, financedSaleRecognitionFingerprint: "v1;JOD;L1" }],
  ])("a closed %s direct deal is NOT covered", (_name, over) => {
    expect(financedSaleRecognitionApplies(app(over), { settlesDirect: true })).toBe(false);
  });

  test("a closed v3 direct deal is covered, by field or by fingerprint prefix", () => {
    expect(financedSaleRecognitionApplies(app({ ...FINALIZED, financedSalePlanVersion: 3 }), { settlesDirect: true })).toBe(true);
    expect(
      financedSaleRecognitionApplies(app({ ...FINALIZED, financedSaleRecognitionFingerprint: "v3;JOD;DIRECT" }), { settlesDirect: true })
    ).toBe(true);
  });

  test("a direct deal that has not finalized yet is covered (it will freeze v3)", () => {
    expect(financedSaleRecognitionApplies(app(), { settlesDirect: true })).toBe(true);
  });

  test("an explicit plan version wins over the record", () => {
    expect(financedSaleRecognitionApplies(app(FINALIZED), { settlesDirect: true, planVersion: 3 })).toBe(true);
    expect(financedSaleRecognitionApplies(app(), { settlesDirect: true, planVersion: 2 })).toBe(false);
  });

  test("a deal with no financier is never covered, and the through-dealership route ignores the version", () => {
    expect(financedSaleRecognitionApplies(app({ companyId: undefined }), { settlesDirect: true, planVersion: 3 })).toBe(false);
    expect(financedSaleRecognitionApplies(app({ ...FINALIZED, financedSalePlanVersion: 1 }), { settlesDirect: false })).toBe(true);
  });
});

describe("the plan-version predicates agree on what a forward / server-derived plan is", () => {
  test("forward = v2 and v3; server-derived = v3 only", () => {
    expect([0, 1, 2, 3].map(isForwardPlanVersion)).toEqual([false, false, true, true]);
    expect([0, 1, 2, 3].map(isServerDerivedPlanVersion)).toEqual([false, false, false, true]);
  });

  test("isForwardPlan reads the plan's own version", () => {
    expect(isForwardPlan({ version: 2 } as Parameters<typeof isForwardPlan>[0])).toBe(true);
    expect(isForwardPlan({ version: 3 } as Parameters<typeof isForwardPlan>[0])).toBe(true);
    expect(isForwardPlan({ version: 1 } as Parameters<typeof isForwardPlan>[0])).toBe(false);
  });
});
