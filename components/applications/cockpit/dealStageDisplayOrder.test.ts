/**
 * SCRUM-417 UX PR 2 (S1) -- the rail shows the EXECUTABLE order.
 *
 * The server keeps DISBURSEMENT at step 6 on purpose (`DEAL_STAGE_ORDER`, pinned
 * by `dealCockpitDerivation.test.ts`), because the dealer describes the deal
 * that way; but the payment can only be confirmed once the deal is CLOSED, and
 * closing needs the handover. The screen therefore re-orders the SAME stage
 * objects for display, by key, and never touches the server's classification.
 */
import { describe, expect, test } from "vitest";
import { deriveDealStages, DEAL_STAGE_ORDER } from "@/convex/utils/financingEconomics";
import type { DealStageFacts } from "@/convex/utils/financingEconomics";
import { orderStagesForDisplay } from "./dealStageDisplayOrder";

const EXECUTABLE_ORDER = [
  "APPLICATION",
  "CREDIT_DECISION",
  "APPRAISAL",
  "APPROVED_PURCHASE",
  "DELIVERY_ACTIONS",
  "HANDOVER",
  "SETTLEMENT",
  "DISBURSEMENT",
];

const facts = (overrides: Partial<DealStageFacts>): DealStageFacts => ({
  status: "APPROVED",
  creditDecision: "APPROVED",
  appraisalStatus: "FINALIZED",
  approvedDealerPurchaseAmountMinor: 12_500_000,
  documentRulesApply: true,
  requiredDocumentsComplete: true,
  ...overrides,
});

describe("the displayed order of the stage rail", () => {
  test("pins the displayed order: payment confirmation is last, everything else keeps its place", () => {
    const shown = orderStagesForDisplay(deriveDealStages(facts({})));
    expect(shown.map((s) => s.key)).toEqual(EXECUTABLE_ORDER);
  });

  test("the server's own order is untouched (this is display only)", () => {
    const derived = deriveDealStages(facts({}));
    orderStagesForDisplay(derived);
    expect(derived.map((s) => s.key)).toEqual(DEAL_STAGE_ORDER);
  });

  test("it moves the stage by KEY, never by index: a shuffled input still ends with the payment", () => {
    const derived = deriveDealStages(facts({}));
    const byKey = (key: string) => derived.find((s) => s.key === key)!;
    // DISBURSEMENT deliberately NOT at index 5, where the server puts it.
    const shuffled = ["DISBURSEMENT", "SETTLEMENT", "APPLICATION", "HANDOVER", "APPRAISAL"].map(byKey);
    const shown = orderStagesForDisplay(shuffled);
    expect(shown.map((s) => s.key)).toEqual(["SETTLEMENT", "APPLICATION", "HANDOVER", "APPRAISAL", "DISBURSEMENT"]);
  });

  test("the SAME stage objects come back: state, blocker and authority are never re-derived", () => {
    const derived = deriveDealStages(facts({}));
    const shown = orderStagesForDisplay(derived);
    for (const stage of derived) expect(shown).toContain(stage);
  });

  test("a rail without the stage (the cash rail, an unknown key) is left exactly as it came", () => {
    const cash = [{ key: "SALE_AGREED" }, { key: "HANDOVER" }, { key: "SETTLEMENT" }];
    expect(orderStagesForDisplay(cash)).toEqual(cash);
    const future = [{ key: "APPLICATION" }, { key: "SOMETHING_NEW" }, { key: "DISBURSEMENT" }, { key: "HANDOVER" }];
    expect(orderStagesForDisplay(future).map((s) => s.key)).toEqual([
      "APPLICATION",
      "SOMETHING_NEW",
      "HANDOVER",
      "DISBURSEMENT",
    ]);
  });

  test("an empty rail stays empty", () => {
    expect(orderStagesForDisplay([])).toEqual([]);
  });
});

describe("the payment confirmation is never the live step before the deal is closed", () => {
  const live = (stages: ReturnType<typeof deriveDealStages>) =>
    stages.find((s) => s.state === "CURRENT" || s.state === "BLOCKED")?.key;
  const stateOf = (stages: ReturnType<typeof deriveDealStages>, key: string) =>
    stages.find((s) => s.key === key)?.state;

  test("a deal at Documents: documents are live, payment is PENDING and last", () => {
    const shown = orderStagesForDisplay(deriveDealStages(facts({ requiredDocumentsComplete: false })));
    expect(live(shown)).toBe("DELIVERY_ACTIONS");
    expect(stateOf(shown, "DISBURSEMENT")).toBe("PENDING");
    expect(shown.at(-1)?.key).toBe("DISBURSEMENT");
  });

  test("a deal at Handover: handover is live and numbered 6, payment is PENDING and numbered 8", () => {
    const shown = orderStagesForDisplay(deriveDealStages(facts({})));
    expect(live(shown)).toBe("HANDOVER");
    expect(shown.findIndex((s) => s.key === "HANDOVER") + 1).toBe(6);
    expect(stateOf(shown, "DISBURSEMENT")).toBe("PENDING");
    expect(shown.findIndex((s) => s.key === "DISBURSEMENT") + 1).toBe(8);
  });

  test("a closed deal whose payment is pending: only now is the payment live, and it is last", () => {
    const shown = orderStagesForDisplay(
      deriveDealStages(
        facts({
          status: "CLOSED",
          finalizedSaleId: "sale_1" as never,
          handoverStatus: "HANDED_OVER",
          settlementComplete: true,
        })
      )
    );
    expect(live(shown)).toBe("DISBURSEMENT");
    expect(shown.at(-1)?.key).toBe("DISBURSEMENT");
    expect(shown.filter((s) => s.state === "CURRENT" || s.state === "BLOCKED")).toHaveLength(1);
  });
});
