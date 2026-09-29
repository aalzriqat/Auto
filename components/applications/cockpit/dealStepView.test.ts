/**
 * SCRUM-417 UX PR 4 (O3) -- which step is being looked at: deep-link parsing,
 * the fall-back to the live step, and how each state is shown.
 */
import { describe, expect, test } from "vitest";
import { resolveViewedStage, stageNeedsKey, stageViewCopy, stageViewMode } from "./dealStepView";
import { deriveStepChecklist } from "./dealStepChecklist";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";

const stages = [
  { key: "APPLICATION", state: "COMPLETE" as const },
  { key: "HANDOVER", state: "CURRENT" as const },
  { key: "SETTLEMENT", state: "PENDING" as const },
];

describe("resolveViewedStage (the ?stage= deep link)", () => {
  test("a real stage key resolves to that stage", () => {
    expect(resolveViewedStage("APPLICATION", stages)?.key).toBe("APPLICATION");
    expect(resolveViewedStage("SETTLEMENT", stages)?.key).toBe("SETTLEMENT");
  });
  test.each([null, undefined, "", "APPRAISAL", "handover", "__proto__", "constructor", "HANDOVER "])(
    "%j falls back to no choice (the live step)",
    (value) => {
      expect(resolveViewedStage(value, stages)).toBeUndefined();
    }
  );
  test("a stage this deal does not have is unknown, not invented", () => {
    expect(resolveViewedStage("APPRAISAL", stages.filter((s) => s.key !== "APPRAISAL"))).toBeUndefined();
  });
});

describe("stageViewMode", () => {
  test("live, past and future", () => {
    expect(stageViewMode("CURRENT")).toBe("live");
    expect(stageViewMode("BLOCKED")).toBe("live");
    expect(stageViewMode("COMPLETE")).toBe("past");
    expect(stageViewMode("PENDING")).toBe("future");
    expect(stageViewMode("STOPPED")).toBe("stopped");
  });
});

describe("stageNeedsKey", () => {
  test("every executable stage has a needs sentence; an unknown one has none", () => {
    for (const key of [
      "APPLICATION",
      "CREDIT_DECISION",
      "APPRAISAL",
      "APPROVED_PURCHASE",
      "DELIVERY_ACTIONS",
      "DISBURSEMENT",
      "HANDOVER",
      "SETTLEMENT",
      "SALE_AGREED",
    ]) {
      expect(stageNeedsKey(key)).toMatch(/^StageNeeds/);
    }
    expect(stageNeedsKey("toString")).toBeUndefined();
    expect(stageNeedsKey("NOPE")).toBeUndefined();
  });
  test("the sale-keyed path (applicationId null) gets the cash wording for Handover and Settlement, whatever dealKind says", () => {
    expect(stageNeedsKey("HANDOVER", "SALE")).toBe("StageNeedsHandoverCash");
    expect(stageNeedsKey("SETTLEMENT", "SALE")).toBe("StageNeedsSettlementCash");
    expect(stageNeedsKey("HANDOVER", "APPLICATION")).toBe("StageNeedsHandover");
    expect(stageNeedsKey("SETTLEMENT")).toBe("StageNeedsSettlement");
    expect(stageNeedsKey("DISBURSEMENT", "SALE")).toBe("StageNeedsDisbursement");
  });
});

describe("stageViewCopy", () => {
  test("past and stopped carry a note and no needs; future carries both", () => {
    expect(stageViewCopy("past", "HANDOVER")).toEqual({ noteKey: "StageViewPastNote", needsKey: undefined });
    expect(stageViewCopy("stopped", "HANDOVER")).toEqual({ noteKey: "StageViewStoppedNote", needsKey: undefined });
    expect(stageViewCopy("future", "HANDOVER")).toEqual({ noteKey: "StageViewFutureNote", needsKey: "StageNeedsHandover" });
  });
  test("a pending financed Settlement of a CLOSED deal never says 'has not started'", () => {
    expect(stageViewCopy("future", "SETTLEMENT", { path: "APPLICATION", closed: true })).toEqual({
      noteKey: "StageViewSettlementClosedNote",
    });
  });
  test("controls: open deal, unknown closed fact, sale-keyed path and other stages keep the future copy", () => {
    expect(stageViewCopy("future", "SETTLEMENT", { closed: false }).noteKey).toBe("StageViewFutureNote");
    expect(stageViewCopy("future", "SETTLEMENT", {}).noteKey).toBe("StageViewFutureNote");
    expect(stageViewCopy("future", "SETTLEMENT", { path: "SALE", closed: true })).toEqual({
      noteKey: "StageViewFutureNote",
      needsKey: "StageNeedsSettlementCash",
    });
    expect(stageViewCopy("future", "DISBURSEMENT", { closed: true }).noteKey).toBe("StageViewFutureNote");
  });
});

describe("O2/O3 copy is paired EN/AR", () => {
  const en = salesEn as Record<string, string>;
  const ar = salesAr as Record<string, string>;
  const ours = Object.keys(en).filter((k) => /^(Checklist|StageNeeds|StageView|BackToCurrentStep)/.test(k));

  test("there is copy to check", () => {
    expect(ours.length).toBeGreaterThanOrEqual(20);
  });
  test.each(ours)("%s exists in both languages, Arabic in Arabic script", (key) => {
    expect(en[key]).toBeTruthy();
    expect(ar[key]).toMatch(/[\u0600-\u06FF]/);
  });
  test("every label a checklist can emit is translated", () => {
    const states = { HANDOVER: "CURRENT", SETTLEMENT: "CURRENT" } as const;
    const all = [
      deriveStepChecklist({ stageKey: "APPROVED_PURCHASE", stageState: "CURRENT", stageStates: states }),
      deriveStepChecklist({
        stageKey: "DELIVERY_ACTIONS",
        stageState: "CURRENT",
        stageStates: states,
        documents: [{ required: true, status: "MISSING" }],
      }),
      deriveStepChecklist({
        stageKey: "HANDOVER",
        stageState: "CURRENT",
        path: "SALE",
        stageStates: states,
        liveAction: { actionKey: "CompleteCashSaleAction", unavailableReasonKey: "CashSaleCompletionNeedsDepositDecision" },
      }),
      deriveStepChecklist({
        stageKey: "SETTLEMENT",
        stageState: "CURRENT",
        stageStates: states,
        routeRecorded: true,
        readinessState: "READY",
      }),
      ...["FinalizeNeedsPendingDepositRequestResolved", "FinalizeNeedsHeldDepositResolved", "FinalizeCurrencyMismatch"].map(
        (unavailableReasonKey) =>
          deriveStepChecklist({
            stageKey: "SETTLEMENT",
            stageState: "CURRENT",
            stageStates: states,
            liveAction: { actionKey: "FinalizeDealAction", unavailableReasonKey },
          })
      ),
      deriveStepChecklist({ stageKey: "DISBURSEMENT", stageState: "CURRENT", stageStates: states }),
    ].flatMap((items) => items ?? []);
    expect(all.length).toBeGreaterThan(8);
    for (const item of all) {
      expect(en[item.labelKey], item.labelKey).toBeTruthy();
      expect(ar[item.labelKey], item.labelKey).toBeTruthy();
    }
  });
});