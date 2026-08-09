/**
 * What the cockpit says a deal IS, for rows that answer none of its questions.
 *
 * All five lifecycle dimensions are optional on `financeApplications`. Every
 * application that predates them stores none, so the dangerous case is not the
 * fully-populated deal from the mockup — it is the historical row where the
 * screen has to decide what to claim from almost nothing. Claiming too little
 * ("this delivered car was never delivered") is as wrong as claiming too much.
 */
import { describe, expect, test } from "vitest";
import {
  DEAL_STAGE_ORDER,
  type DealStageFacts,
  type DealStageKey,
  deriveDealStages,
  deriveManagementProfit,
} from "./financingEconomics";

function stages(overrides: Partial<DealStageFacts> = {}) {
  const facts: DealStageFacts = {
    status: "APPROVED",
    requiredDocumentsComplete: false,
    ...overrides,
  };
  const rail = deriveDealStages(facts);
  return {
    rail,
    state: (key: DealStageKey) => rail.find((s) => s.key === key)!.state,
    blocker: (key: DealStageKey) => rail.find((s) => s.key === key)!.blocker,
  };
}

describe("the stage rail", () => {
  test("covers every stage exactly once, in order", () => {
    expect(stages().rail.map((s) => s.key)).toEqual(DEAL_STAGE_ORDER);
  });

  test("marks exactly one stage as the one to act on", () => {
    const current = stages().rail.filter((s) => s.state === "CURRENT" || s.state === "BLOCKED");
    expect(current).toHaveLength(1);
  });
});

/**
 * The legacy row: approved, sold, handed over, disbursed — and not one
 * lifecycle dimension set. Reading unset as "not done" would render a finished
 * deal as one that never got past its credit decision.
 */
describe("a historical deal that answers none of the lifecycle dimensions", () => {
  const legacy: Partial<DealStageFacts> = {
    status: "CLOSED",
    finalizedSaleId: "sale1",
    disbursedAt: Date.UTC(2026, 6, 1),
    approvedDealerPurchaseAmountMinor: 12_500_000,
  };

  test("is not rendered as a deal that never started", () => {
    const s = stages(legacy);
    expect(s.state("APPLICATION")).toBe("COMPLETE");
    expect(s.state("CREDIT_DECISION")).toBe("COMPLETE");
  });

  test("counts its appraisal as done rather than asserting it never happened", () => {
    // No appraisal dimension exists on the row. The credit approval is the only
    // evidence there is, and it means the appraisal was handled off-system.
    expect(stages(legacy).state("APPRAISAL")).toBe("COMPLETE");
  });

  test("does not invent an unresolved appraisal gap where no gap was recorded", () => {
    expect(stages(legacy).state("GAP_RESOLUTION")).toBe("COMPLETE");
  });

  test("shows the car as handed over, because a finalized sale is the evidence", () => {
    expect(stages(legacy).state("HANDOVER")).toBe("COMPLETE");
  });

  test("shows the money as settled, because a disbursement was confirmed", () => {
    expect(stages(legacy).state("SETTLEMENT")).toBe("COMPLETE");
  });

  test("still reports the document checklist it genuinely never filled in", () => {
    // The one thing that IS incomplete, and the only one the rail should flag.
    const s = stages(legacy);
    expect(s.state("DELIVERY_ACTIONS")).toBe("BLOCKED");
    expect(s.blocker("DELIVERY_ACTIONS")).toBe("DocumentsIncomplete");
  });

  test("a later stage stays complete even though an earlier one is not", () => {
    // Judged on its own evidence. Marking everything after the first gap as
    // pending would tell the dealership its delivered car was not delivered.
    const s = stages(legacy);
    expect(s.state("DELIVERY_ACTIONS")).toBe("BLOCKED");
    expect(s.state("HANDOVER")).toBe("COMPLETE");
  });
});

describe("a deal that died", () => {
  test("shows its remaining stages as stopped, not merely pending", () => {
    // PENDING reads as "coming up next" and would invite someone to work a
    // rejected deal.
    const s = stages({ status: "REJECTED" });
    expect(s.state("HANDOVER")).toBe("STOPPED");
    expect(s.state("SETTLEMENT")).toBe("STOPPED");
  });

  test("a cancelled deal is not reported as awaiting settlement", () => {
    const s = stages({ status: "CANCELLED", finalizedSaleId: "sale1" });
    expect(s.state("SETTLEMENT")).toBe("STOPPED");
  });
});

describe("a live deal mid-flight", () => {
  test("a recorded but unresolved appraisal gap blocks on the gap", () => {
    const s = stages({
      creditDecision: "APPROVED",
      appraisalStatus: "COMPLETED",
      rawAppraisalGapMinor: 1_000_000,
      gapResolution: "PENDING_NEGOTIATION",
    });
    expect(s.state("GAP_RESOLUTION")).toBe("BLOCKED");
    expect(s.blocker("GAP_RESOLUTION")).toBe("GapUnresolved");
  });

  test("a failed negotiation is distinguished from one still running", () => {
    const s = stages({
      creditDecision: "APPROVED",
      appraisalStatus: "COMPLETED",
      rawAppraisalGapMinor: 1_000_000,
      gapResolution: "FAILED",
    });
    expect(s.blocker("GAP_RESOLUTION")).toBe("GapNegotiationFailed");
  });

  test("a zero gap is not a gap", () => {
    const s = stages({
      creditDecision: "APPROVED",
      appraisalStatus: "COMPLETED",
      rawAppraisalGapMinor: 0,
      approvedDealerPurchaseAmountMinor: 12_500_000,
      requiredDocumentsComplete: true,
    });
    expect(s.state("GAP_RESOLUTION")).toBe("COMPLETE");
  });

  test("the mockup's deal is at إجراءات التسليم", () => {
    const s = stages({
      creditDecision: "APPROVED",
      appraisalStatus: "FINALIZED",
      gapResolution: "NOT_REQUIRED",
      approvedDealerPurchaseAmountMinor: 12_500_000,
      requiredDocumentsComplete: false,
    });
    expect(s.state("DELIVERY_ACTIONS")).toBe("BLOCKED");
    expect(s.state("HANDOVER")).toBe("PENDING");
  });
});

describe("صافي ربح المعرض", () => {
  const settled = {
    approvedDealerPurchaseAmountMinor: 12_500_000,
    supplierSettlementMinor: 9_500_000,
    actualExpensesMinor: 590_000,
    currency: "JOD",
  };

  test("reproduces the mockup's arithmetic", () => {
    // 12,500 − 9,500 − 590 = 2,410 JOD, at JOD's three decimal places.
    const profit = deriveManagementProfit({ ...settled, fullySettled: false });
    expect(profit.available && profit.amountMinor).toBe(2_410_000);
  });

  test("the headline equals its own derivation, never a second computation", () => {
    const profit = deriveManagementProfit({ ...settled, fullySettled: false });
    expect(profit.available).toBe(true);
    if (!profit.available) return;
    const fromLines = profit.lines.reduce((t, l) => t + l.sign * l.amountMinor, 0);
    expect(fromLines).toBe(profit.amountMinor);
  });

  test("carries its qualifier while money is still moving", () => {
    const profit = deriveManagementProfit({ ...settled, fullySettled: false });
    expect(profit.available && profit.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });

  test("is STILL not postable once everything has settled", () => {
    // The spread it is built on appears on no invoice. Settling the deal does
    // not turn a management figure into an accounting one.
    const profit = deriveManagementProfit({ ...settled, fullySettled: true });
    expect(profit.available && profit.classification).toBe("ACTUAL_UNPOSTABLE");
    expect(profit.available && profit.postable).toBe(false);
  });

  test("reports that it cannot be computed rather than reporting zero", () => {
    // Zero profit and unknowable profit are different claims, and this screen
    // is where a dealership decides whether a deal made money.
    const noApproval = deriveManagementProfit({
      ...settled,
      approvedDealerPurchaseAmountMinor: undefined,
      fullySettled: false,
    });
    expect(noApproval).toEqual({ available: false, reason: "NoApprovedPurchaseAmount" });

    const noSupplier = deriveManagementProfit({
      ...settled,
      supplierSettlementMinor: undefined,
      fullySettled: false,
    });
    expect(noSupplier).toEqual({ available: false, reason: "NoSupplierSettlement" });
  });

  test("a deal that cost more than it approved reports the loss, not a floor of zero", () => {
    const profit = deriveManagementProfit({
      ...settled,
      supplierSettlementMinor: 12_400_000,
      actualExpensesMinor: 590_000,
      fullySettled: false,
    });
    expect(profit.available && profit.amountMinor).toBe(-490_000);
  });
});
