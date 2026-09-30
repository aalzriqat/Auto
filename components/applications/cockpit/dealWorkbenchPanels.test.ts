/**
 * SCRUM-417 UX PR 3 (O1) -- which panel belongs to which live step.
 *
 * Pure presentation: the map decides only WHERE a panel is drawn, never
 * whether it is offered or who may act in it (containers still own that).
 */
import { describe, expect, test } from "vitest";
import { CASH_DEAL_STAGE_ORDER, DEAL_STAGE_ORDER } from "@/convex/utils/financingEconomics";
import { panelsForStage, WORKBENCH_PANELS } from "./dealWorkbenchPanels";

describe("panelsForStage", () => {
  test.each([
    ["CREDIT_DECISION", ["documents"]],
    ["APPRAISAL", ["financeDecision"]],
    ["APPROVED_PURCHASE", ["financeDecision"]],
    ["DELIVERY_ACTIONS", ["documents"]],
    ["HANDOVER", ["handoverCosts", "custody"]],
    ["SETTLEMENT", ["closing"]],
    ["DISBURSEMENT", ["money"]],
  ])("%s promotes %j", (stage, expected) => {
    expect(panelsForStage(stage)).toEqual(expected);
  });

  test("a stage with no panel of its own, an unknown stage and no stage promote nothing", () => {
    expect(panelsForStage("APPLICATION")).toEqual([]);
    expect(panelsForStage("SALE_AGREED")).toEqual([]);
    expect(panelsForStage("SOMETHING_THE_SERVER_ADDS_LATER")).toEqual([]);
    expect(panelsForStage(undefined)).toEqual([]);
  });

  test("every stage either of the deal kinds can emit answers, and only with known panels", () => {
    for (const stage of [...DEAL_STAGE_ORDER, ...CASH_DEAL_STAGE_ORDER]) {
      for (const panel of panelsForStage(stage)) expect(WORKBENCH_PANELS).toContain(panel);
    }
  });

  test("one stage never lists a panel twice", () => {
    for (const stage of [...DEAL_STAGE_ORDER, ...CASH_DEAL_STAGE_ORDER]) {
      const panels = panelsForStage(stage);
      expect(new Set(panels).size).toBe(panels.length);
    }
  });
});
