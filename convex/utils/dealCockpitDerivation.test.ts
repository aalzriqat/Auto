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
  deriveCashDealStages,
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
    authority: (key: DealStageKey) => rail.find((s) => s.key === key)!.authority,
  };
}

/**
 * Whose move each stage is.
 *
 * The distinction the screen turns on, and the one the product keeps getting
 * wrong in the same direction: a stage that belongs to the finance company gets
 * presented as something the dealership has failed to do, and an operator goes
 * looking for a button that must never exist. These assert the taxonomy at its
 * source, so a stage added later cannot quietly inherit "the dealership acts".
 */
describe("who each stage is waiting on", () => {
  test("every stage on the rail says whose move it is", () => {
    const rail = stages().rail;
    expect(rail.length).toBeGreaterThan(0);
    for (const stage of rail) {
      expect(["MIRROR", "DEALER"]).toContain(stage.authority);
    }
  });

  /**
   * AutoFlow never approves or evaluates a financing request. These four stages
   * record what somebody else decided or did, and the recording must never be
   * refused on the dealership's judgement of whether it should have happened.
   */
  test("the finance company's own decisions are MIRROR stages", () => {
    // CLOSED so the disbursement stage is on the rail at all: it is deliberately
    // absent until the deal can actually disburse.
    const rail = stages({ rawAppraisalGapMinor: 500_000, status: "CLOSED" });
    expect(rail.authority("CREDIT_DECISION")).toBe("MIRROR");
    expect(rail.authority("APPRAISAL")).toBe("MIRROR");
    expect(rail.authority("APPROVED_PURCHASE")).toBe("MIRROR");
    expect(rail.authority("DISBURSEMENT")).toBe("MIRROR");
  });

  test("the steps the dealership itself takes are DEALER stages", () => {
    const rail = stages({ rawAppraisalGapMinor: 500_000 });
    expect(rail.authority("APPLICATION")).toBe("DEALER");
    expect(rail.authority("GAP_RESOLUTION")).toBe("DEALER");
    expect(rail.authority("DELIVERY_ACTIONS")).toBe("DEALER");
    expect(rail.authority("HANDOVER")).toBe("DEALER");
  });

  /**
   * Only defensible because DISBURSEMENT was carved out of it. What is left at
   * SETTLEMENT is registering the expected payment and closing the deal — both
   * the dealership's own actions. The money actually moving is its own MIRROR
   * stage now, and calling the whole tail DEALER before that split would have
   * told the operator to chase a payment they cannot cause.
   */
  test("settlement belongs to the dealership now that disbursement is its own stage", () => {
    const rail = stages({ status: "CLOSED" });
    expect(rail.authority("SETTLEMENT")).toBe("DEALER");
    expect(rail.authority("DISBURSEMENT")).toBe("MIRROR");
  });

  test("a cash deal's stages carry the same answer", () => {
    const cash = deriveCashDealStages({ saleStatus: "PENDING" });
    expect(cash.map((s) => s.authority)).toEqual(cash.map(() => "DEALER"));
  });

  /** The state does not change whose stage it is. */
  test("authority survives every state the stage can be in", () => {
    const stopped = stages({ status: "CANCELLED" });
    expect(stopped.state("CREDIT_DECISION")).toBe("STOPPED");
    expect(stopped.authority("CREDIT_DECISION")).toBe("MIRROR");

    const complete = stages({
      requiredDocumentsComplete: true,
      approvedDealerPurchaseAmountMinor: 12_200_000,
    });
    expect(complete.state("CREDIT_DECISION")).toBe("COMPLETE");
    expect(complete.authority("CREDIT_DECISION")).toBe("MIRROR");
  });
});

describe("an approval the finance company named without an appraisal", () => {
  /**
   * The rail and the approval writer disagreed, and the rail was the one out of
   * step.
   *
   * `recordSubmittedQuotation` moves the appraisal dimension to PENDING —
   * sending a quotation is what puts an appraisal in play. But
   * `approveDealerPurchaseAmount` explicitly permits `basis: "MANUAL"` with no
   * appraisal, and deliberately refuses to mark the dimension FINALIZED there,
   * because "writing FINALIZED asserted a fact that never happened". So for a
   * figure the company named by phone, the rail said `AwaitingAppraisal`
   * forever while the deal was approved, handed over and finalized around it —
   * and nothing anywhere would ever clear it.
   *
   * The lifecycle now follows the writer that owns the decision: once a
   * manually named approval exists, the appraisal question is moot rather than
   * outstanding. It is NOT skipped for any other basis — APPRAISAL and
   * QUOTATION_EXCEPTION both require real appraisal evidence, and this changes
   * nothing about them.
   */
  test("stops the rail demanding an appraisal that will never come", () => {
    const withoutApproval = stages({ appraisalStatus: "PENDING" });
    expect(withoutApproval.state("APPRAISAL")).toBe("BLOCKED");
    expect(withoutApproval.blocker("APPRAISAL")).toBe("AwaitingAppraisal");

    const manuallyApproved = stages({
      appraisalStatus: "PENDING",
      approvedDealerPurchaseAmountMinor: 12_200_000,
      approvedPurchaseBasis: "MANUAL",
      fundingSplitComputed: true,
    });
    expect(manuallyApproved.state("APPRAISAL")).toBe("COMPLETE");
  });

  test("but not when the company's own rule still needs an appraisal to compute the funding", () => {
    // `approveDealerPurchaseAmount` permits MANUAL with no appraisal even for a
    // company whose LTV rule multiplies the APPRAISAL. There the funding split
    // cannot be computed at all — and SCRUM-61's guard refuses handover for
    // exactly that. Reporting the stage complete would hide the real
    // prerequisite until the operator hit the later refusal with nothing on the
    // rail explaining it.
    const ruleStillNeedsOne = stages({
      appraisalStatus: "PENDING",
      approvedDealerPurchaseAmountMinor: 12_200_000,
      approvedPurchaseBasis: "MANUAL",
      fundingSplitComputed: false,
    });
    expect(ruleStillNeedsOne.state("APPRAISAL")).toBe("BLOCKED");
    expect(ruleStillNeedsOne.blocker("APPRAISAL")).toBe("AwaitingAppraisal");
  });

  test("and still demands one for a basis that rests on appraisal evidence", () => {
    const appraisalBasis = stages({
      appraisalStatus: "PENDING",
      approvedDealerPurchaseAmountMinor: 11_500_000,
      approvedPurchaseBasis: "APPRAISAL",
      // Set, so the BASIS is the only thing keeping this blocked. Omitted, the
      // MANUAL disjunct could never be true whatever the basis said, and the
      // test would stay green with the basis check deleted from the writer.
      fundingSplitComputed: true,
    });
    // An APPRAISAL-basis approval cannot exist without one, so a PENDING
    // dimension here means the evidence has not been finalized — a real
    // outstanding step, not a moot question.
    expect(appraisalBasis.state("APPRAISAL")).toBe("BLOCKED");
  });

  test("and does not skip it merely because some amount was approved", () => {
    const noBasisRecorded = stages({
      appraisalStatus: "PENDING",
      approvedDealerPurchaseAmountMinor: 12_200_000,
      // As above: the ABSENCE of a basis has to be what blocks this, not a
      // second unmet condition standing in for it.
      fundingSplitComputed: true,
    });
    // No basis on the row is not evidence of a manual decision.
    expect(noBasisRecorded.state("APPRAISAL")).toBe("BLOCKED");
  });
});

describe("the stage rail", () => {
  test("covers each stage it has exactly once, in the canonical order", () => {
    // Since SCRUM-215 P2 the rail carries only the stages this deal actually
    // has, so it is a SUBSEQUENCE of the canonical order rather than all of it.
    // Order and uniqueness are still guaranteed; presence is not.
    const keys = stages().rail.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(DEAL_STAGE_ORDER.filter((k) => keys.includes(k)));
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
    // Previously this rendered as a permanently-green stage. Since SCRUM-215 P2
    // the deal simply does not have the stage — absent, not ticked.
    expect(stages(legacy).rail.map((s) => s.key)).not.toContain("GAP_RESOLUTION");
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
    expect(s.rail.map((x) => x.key)).not.toContain("GAP_RESOLUTION");
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
    // A deal the finance company funded in full, so the dealership put nothing
    // of its own in. The contribution is a real zero here, not an unrecorded one.
    dealerContributionMinor: 0,
    actualExpensesMinor: 590_000,
    currency: "JOD",
  };

  test("reproduces the mockup's arithmetic when the dealership contributes nothing", () => {
    // 12,500 − 9,500 − 0 − 590 = 2,410 JOD, at JOD's three decimal places.
    const profit = deriveManagementProfit({ ...settled, fullySettled: false });
    expect(profit.available && profit.amountMinor).toBe(2_410_000);
  });

  /**
   * H-7, ruled by the dealership on 2026-08-10, with its own worked example.
   *
   * The same deal carrying an 875 JOD dealer contribution is worth 1,535, not
   * 2,410. Whether the finance company nets the contribution from its
   * remittance or the dealership pays it separately changes cash movement, not
   * profit — so calling 2,410 `صافي ربح المعرض` while the dealership still has
   * to fund 875 overstated the deal by exactly that.
   */
  test("nets the dealership's contribution to the financing", () => {
    const profit = deriveManagementProfit({
      ...settled,
      dealerContributionMinor: 875_000,
      fullySettled: false,
    });
    expect(profit.available && profit.amountMinor).toBe(1_535_000);

    if (!profit.available) return;
    const line = profit.lines.find((l) => l.key === "DEALER_CONTRIBUTION");
    expect(line).toBeDefined();
    expect(line!.sign).toBe(-1);
    expect(line!.amountMinor).toBe(875_000);
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

    // Defaulting an unrecorded contribution to zero would republish the
    // pre-contribution figure under the post-contribution name — the H-7 error
    // reached from the other direction, and the more dangerous one because the
    // number still looks perfectly reasonable.
    const noContribution = deriveManagementProfit({
      ...settled,
      dealerContributionMinor: undefined,
      fullySettled: false,
    });
    expect(noContribution).toEqual({ available: false, reason: "NoDealerContribution" });
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

  /**
   * OP-F2 / H-7b. Subtracting the dealership's contribution while omitting the
   * money the customer paid the dealership directly does not converge on
   * `computeDealerProceeds` — it moves the error to the other side of zero.
   *
   * A deal where the customer absorbs a 1,000 gap and the dealership
   * contributes 1,000 has the same profit as one with neither. The half-applied
   * version reported it 1,000 LOW, under a label asserting the contribution had
   * been accounted for. Understating an owner's profit is not the safe
   * direction; it is the same defect wearing the opposite sign.
   */
  test("the customer's direct payment offsets the dealership's contribution", () => {
    const both = deriveManagementProfit({
      ...settled,
      dealerContributionMinor: 1_000_000,
      customerDirectToDealerMinor: 1_000_000,
      fullySettled: false,
    });
    const neither = deriveManagementProfit({
      ...settled,
      dealerContributionMinor: 0,
      customerDirectToDealerMinor: 0,
      fullySettled: false,
    });
    // Asserted before the comparison: `false === false` would otherwise pass if
    // the shared fixture ever stopped being computable, and the test would go
    // green while proving nothing.
    expect(both.available).toBe(true);
    expect(neither.available).toBe(true);
    expect(both.available && both.amountMinor).toBe(neither.available && neither.amountMinor);

    if (!both.available) return;
    const line = both.lines.find((l) => l.key === "CUSTOMER_DIRECT_TO_DEALER");
    expect(line).toBeDefined();
    expect(line!.sign).toBe(1);
    expect(line!.amountMinor).toBe(1_000_000);
  });

  /**
   * The same figure `computeDealerProceeds` would report, which is the whole
   * point of the H-7 ruling: same economics, different accounting
   * classification. Opus's worked example, with the supplier settlement
   * standing in for the vehicle cost on a consigned deal.
   */
  test("agrees with computeDealerProceeds on a negotiated-gap deal", () => {
    const profit = deriveManagementProfit({
      approvedDealerPurchaseAmountMinor: 10_000_000,
      supplierSettlementMinor: 7_000_000,
      dealerContributionMinor: 1_000_000,
      customerDirectToDealerMinor: 1_000_000,
      actualExpensesMinor: 0,
      currency: "JOD",
      fullySettled: false,
    });
    // 10,000 + 1,000 − 7,000 − 1,000 − 0 = 3,000
    expect(profit.available && profit.amountMinor).toBe(3_000_000);
  });

});

/**
 * SCRUM-215 P2 — the rail carries only the stages this deal actually has, and
 * it names the moment the money moved.
 *
 * Two defects the old fixed eight-stage rail produced:
 *
 *  1. A deal that never had an appraisal gap still rendered a GAP_RESOLUTION
 *     stage, permanently COMPLETE. A stage that is green on every deal that
 *     never had the problem is a checklist nobody checked — it teaches
 *     operators that the rail's ticks mean nothing, and this same rail has to
 *     carry a real blocker.
 *  2. There was no disbursement stage at all, although `confirmDisbursement`
 *     and `confirmSupplierDisbursement` are real mutations and `disbursedAt` a
 *     real field. Disbursement was folded invisibly into SETTLEMENT — hiding
 *     the step a dealer cares about most, because it is when the money moves.
 *
 * Absent is not the same as complete, and that is the whole point: `undefined`
 * means "this deal does not have this stage", COMPLETE means "it had it and it
 * is done".
 */
describe("a rail that carries only the stages this deal has", () => {
  const present = (overrides: Partial<DealStageFacts> = {}) =>
    deriveDealStages({
      status: "APPROVED",
      requiredDocumentsComplete: false,
      ...overrides,
    }).map((s) => s.key);

  test("omits gap resolution entirely when no gap was ever recorded", () => {
    expect(present()).not.toContain("GAP_RESOLUTION");
  });

  test("renders gap resolution as soon as a real gap exists", () => {
    expect(
      present({ rawAppraisalGapMinor: 1_000_000, gapResolution: "PENDING_NEGOTIATION" })
    ).toContain("GAP_RESOLUTION");
  });

  test("keeps gap resolution once it has been resolved, because it happened", () => {
    // A resolved gap is history the deal really has. Dropping the stage the
    // moment it completes would erase the record of a decision that moved money.
    expect(
      present({ rawAppraisalGapMinor: 1_000_000, gapResolution: "DEALER_ABSORBS" })
    ).toContain("GAP_RESOLUTION");
  });

  test("omits the document stage when no document rules apply to this deal", () => {
    // Cash deals and orgs without companyDocumentRules have no paperwork gate.
    // The card is already absent rather than empty; the rail must agree.
    expect(present({ documentRulesApply: false })).not.toContain("DELIVERY_ACTIONS");
  });

  test("renders the document stage when rules do apply", () => {
    expect(present({ documentRulesApply: true })).toContain("DELIVERY_ACTIONS");
  });

  test("a zero gap is still not a gap, and now says so by absence", () => {
    expect(present({ rawAppraisalGapMinor: 0 })).not.toContain("GAP_RESOLUTION");
  });
});

describe("the disbursement stage", () => {
  const rail = (overrides: Partial<DealStageFacts> = {}) =>
    stages({ creditDecision: "APPROVED", ...overrides });

  /**
   * The live stage — the first one that is not finished.
   *
   * This is not a cosmetic detail on the deployed cockpit: that build renders a
   * workflow action ONLY when `workflowAction.stageKey === live.key`, and every
   * action it has is attached to HANDOVER or SETTLEMENT. So whichever stage is
   * live decides whether the operator can act at all.
   */
  const liveStage = (overrides: Partial<DealStageFacts> = {}) =>
    rail(overrides).rail.find((s) => s.state === "CURRENT" || s.state === "BLOCKED")?.key;

  /**
   * A disbursement stage must never become the live stage while the actions
   * that PRODUCE a disbursement are still outstanding.
   *
   * The money cannot move until the deal is CLOSED: `confirmDisbursement`
   * refuses anything else, `finalizeDeal` is what closes it, and finalization
   * refuses until the vehicle handover is registered. So on an ordinary
   * approved deal the disbursement is not merely incomplete — it is
   * unreachable, and it sits AHEAD of handover in the order.
   *
   * Emitting it as the live stage therefore replaced the deal's real next step
   * with one nobody can take. On the deployed cockpit that hides the handover
   * button, and then the expected-payment and finalize buttons behind it, so
   * the deal cannot be progressed from the screen at all.
   */
  test("never becomes the live stage while the deal still has to be handed over", () => {
    const readyForHandover = {
      appraisalStatus: "FINALIZED" as const,
      approvedDealerPurchaseAmountMinor: 12_500_000,
      requiredDocumentsComplete: true,
    };
    expect(liveStage(readyForHandover)).toBe("HANDOVER");
  });

  /**
   * A deal that was closed and then cancelled before the money arrived.
   *
   * `cancelApplication` permits cancelling a CLOSED deal — it refuses only once
   * a disbursement has actually been confirmed — and its patch moves `status` to
   * CANCELLED while leaving `finalizedSaleId` in place. So the stage's own
   * evidence of having been reached survives, but the status that made it
   * applicable does not.
   *
   * Every other unresolved stage on a stopped deal renders STOPPED. This one
   * must not silently vanish instead: the rail is the record of what happened to
   * the deal, and a step that was genuinely reached and then abandoned is part
   * of that record.
   */
  test("stays on the rail, stopped, when a closed deal is cancelled before disbursement", () => {
    const s = rail({
      status: "CANCELLED",
      creditDecision: "CANCELLED",
      finalizedSaleId: "sale1",
      vehicleHandoverAt: Date.UTC(2026, 8, 1),
    });
    expect(s.rail.map((stage) => stage.key)).toContain("DISBURSEMENT");
    expect(s.state("DISBURSEMENT")).toBe("STOPPED");
  });

  test("is not shown at all on a deal that cannot yet disburse", () => {
    // Absent, not green: a stage that is ticked on every deal that never
    // reached it teaches operators the ticks mean nothing.
    const s = rail({
      appraisalStatus: "FINALIZED",
      approvedDealerPurchaseAmountMinor: 12_500_000,
      requiredDocumentsComplete: true,
    });
    expect(s.rail.map((stage) => stage.key)).not.toContain("DISBURSEMENT");
  });


  test("is on the financed rail, between the paperwork and the handover", () => {
    expect(DEAL_STAGE_ORDER).toContain("DISBURSEMENT");
    expect(DEAL_STAGE_ORDER.indexOf("DISBURSEMENT")).toBeGreaterThan(
      DEAL_STAGE_ORDER.indexOf("DELIVERY_ACTIONS")
    );
    expect(DEAL_STAGE_ORDER.indexOf("DISBURSEMENT")).toBeLessThan(
      DEAL_STAGE_ORDER.indexOf("HANDOVER")
    );
  });

  test("waits on the finance company, not on the dealership", () => {
    // A MIRROR stage: AutoFlow records that the money arrived, it does not
    // cause it. The blocker names who we are waiting for.
    //
    // CLOSED, because that is the only state in which the money can be awaited
    // at all. This fixture previously used an APPROVED deal and asserted the
    // stage was BLOCKED there — which PINNED the defect this section now
    // guards against, rather than catching it.
    const s = rail({
      status: "CLOSED",
      appraisalStatus: "FINALIZED",
      approvedDealerPurchaseAmountMinor: 12_500_000,
      requiredDocumentsComplete: true,
    });
    expect(s.rail.map((stage) => stage.key)).toContain("DISBURSEMENT");
    expect(s.state("DISBURSEMENT")).toBe("BLOCKED");
    expect(s.blocker("DISBURSEMENT")).toBe("AwaitingDisbursement");
  });

  test("completes when the financier paid the dealership", () => {
    expect(rail({ disbursedAt: Date.UTC(2026, 8, 1) }).state("DISBURSEMENT")).toBe("COMPLETE");
  });

  test("completes when the financier paid the supplier directly instead", () => {
    // On the direct route the dealership is never paid, so judging this stage
    // by `disbursedAt` alone left it blocked forever on a finished deal.
    expect(
      rail({ supplierDisbursementConfirmedAt: Date.UTC(2026, 8, 1) }).state("DISBURSEMENT")
    ).toBe("COMPLETE");
  });

  test("does not report the money as moved merely because a sale was finalized", () => {
    // A finalized sale is handover/settlement evidence, not payment evidence.
    expect(
      rail({ status: "CLOSED", finalizedSaleId: "sale1" }).state("DISBURSEMENT")
    ).not.toBe("COMPLETE");
  });
});
