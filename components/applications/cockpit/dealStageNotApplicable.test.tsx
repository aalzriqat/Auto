/**
 * SCRUM-446 (UI half): the cockpit tolerates a DISBURSEMENT stage the server has
 * PROVEN is not needed (`NOT_APPLICABLE`), before the backend ever emits it.
 *
 * Covers the exhaustive per-state maps, "finished" vs "live" vs "complete", the
 * step-view mode and copy, the EN/AR words, the rail node, and the one thing the
 * operator must never see: a rail that says "not needed" beside a slot that still
 * offers (or refuses) a payment confirmation.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import {
  isFinishedStageState,
  isLiveStageState,
  STAGE_ICON,
  STAGE_NODE_CLASS,
  STAGE_STATE_KEY,
  stageNodeContent,
  type DealStageState,
} from "./DealStagePresentation";
import { stageNotApplicableReasonKey, stageViewCopy, stageViewMode } from "./dealStepView";
import { deriveStepChecklist } from "./dealStepChecklist";
import { DealStageRail, DealStagesComplete } from "./DealStageRail";

const ALL_STATES: DealStageState[] = ["COMPLETE", "CURRENT", "BLOCKED", "PENDING", "STOPPED", "NOT_APPLICABLE"];

const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;

afterEach(cleanup);

describe("the exhaustive state maps know NOT_APPLICABLE", () => {
  test("every map has exactly the six states, no more and no fewer", () => {
    for (const map of [STAGE_STATE_KEY, STAGE_NODE_CLASS, STAGE_ICON]) {
      expect(Object.keys(map).sort()).toEqual([...ALL_STATES].sort());
    }
  });

  test("its state key names it 'Not needed' in English and Arabic, distinct from every other state", () => {
    const key = STAGE_STATE_KEY.NOT_APPLICABLE;
    expect(en[key]).toBe("Not needed");
    expect(ar[key]).toBe("غير مطلوبة");
    const others = ALL_STATES.filter((s) => s !== "NOT_APPLICABLE").map((s) => en[STAGE_STATE_KEY[s]]);
    expect(others).not.toContain(en[key]);
  });

  test("its node is quiet: neither the success green, the warning amber nor the live primary fill", () => {
    const cls = STAGE_NODE_CLASS.NOT_APPLICABLE;
    expect(cls).not.toMatch(/emerald|green|amber|primary/);
    expect(cls).toContain("text-muted-foreground");
    expect(STAGE_NODE_CLASS.CURRENT).toContain("bg-primary");
  });

  test("it is a dash, never the completion tick and never the stage number", () => {
    expect(stageNodeContent("NOT_APPLICABLE", 5)).toEqual(stageNodeContent("STOPPED", 5));
    expect(stageNodeContent("NOT_APPLICABLE", 5)).not.toEqual(stageNodeContent("COMPLETE", 5));
    expect(stageNodeContent("NOT_APPLICABLE", 5)).not.toEqual(stageNodeContent("PENDING", 5));
  });
});

describe("finished, live and complete are three different questions", () => {
  test("NOT_APPLICABLE is finished but neither live nor complete", () => {
    expect(isFinishedStageState("NOT_APPLICABLE")).toBe(true);
    expect(isLiveStageState("NOT_APPLICABLE")).toBe(false);
  });

  test.each(ALL_STATES)("%s: finished only for COMPLETE and NOT_APPLICABLE", (state) => {
    expect(isFinishedStageState(state)).toBe(state === "COMPLETE" || state === "NOT_APPLICABLE");
  });

  test.each(ALL_STATES)("%s: live only for CURRENT and BLOCKED", (state) => {
    expect(isLiveStageState(state)).toBe(state === "CURRENT" || state === "BLOCKED");
  });

  /** The cockpit's `allComplete` is `stages.every(isFinishedStageState)`. */
  test("a deal whose only non-COMPLETE stage is NOT_APPLICABLE is finished; any live, pending or stopped stage is not", () => {
    const finished = (states: DealStageState[]) => states.length > 0 && states.every(isFinishedStageState);
    expect(finished(["COMPLETE", "COMPLETE", "NOT_APPLICABLE", "COMPLETE"])).toBe(true);
    expect(finished(["COMPLETE", "NOT_APPLICABLE", "PENDING"])).toBe(false);
    expect(finished(["COMPLETE", "NOT_APPLICABLE", "BLOCKED"])).toBe(false);
    expect(finished(["COMPLETE", "NOT_APPLICABLE", "STOPPED"])).toBe(false);
    expect(finished([])).toBe(false);
  });
});

describe("the step view says it is not needed, and why", () => {
  test("mode is notApplicable, and it is not a preview, a record or a stop", () => {
    expect(stageViewMode("NOT_APPLICABLE")).toBe("notApplicable");
    expect(stageViewMode("PENDING")).toBe("future");
    expect(stageViewMode("STOPPED")).toBe("stopped");
  });

  test("DISBURSEMENT names its own reason; a stage the server adds later gets the generic sentence", () => {
    expect(stageNotApplicableReasonKey("DISBURSEMENT")).toBe("StageNotApplicableReasonDisbursement");
    // SCRUM-629 F-07: a deal with no required document says why its paperwork step is not needed.
    expect(stageNotApplicableReasonKey("DELIVERY_ACTIONS")).toBe("StageNotApplicableReasonDeliveryActions");
    expect(stageNotApplicableReasonKey("SOMETHING_NEW")).toBe("StageViewNotApplicableNote");
    expect(stageNotApplicableReasonKey("toString")).toBe("StageViewNotApplicableNote");
    expect(stageViewCopy("notApplicable", "DISBURSEMENT")).toEqual({
      noteKey: "StageNotApplicableReasonDisbursement",
    });
  });

  test("it promises no needs, even for a closed financed deal", () => {
    expect(stageViewCopy("notApplicable", "DISBURSEMENT", { closed: true, path: "APPLICATION" }).needsKey).toBeUndefined();
  });

  test("every new string exists in both languages and Arabic is not the English", () => {
    for (const key of [
      "StageStateNotApplicable",
      "StageViewNotApplicableNote",
      "StageNotApplicableReasonDisbursement",
      "StageNotApplicableReasonDeliveryActions",
      "DealStagesFinished",
      "DealStagesCompleteCount",
      "DealStagesNotNeededCount",
    ]) {
      expect(en[key], `en ${key}`).toBeTruthy();
      expect(ar[key], `ar ${key}`).toBeTruthy();
      expect(ar[key]).not.toBe(en[key]);
    }
    expect(en.StageNotApplicableReasonDisbursement).toBe("No finance company pays the dealership on this deal.");
  });
});

describe("no step checklist for a step that is not needed", () => {
  test("DISBURSEMENT and every other stage: NOT_APPLICABLE lists no sub-steps", () => {
    for (const stageKey of ["DISBURSEMENT", "HANDOVER", "SETTLEMENT", "DELIVERY_ACTIONS", "APPROVED_PURCHASE"]) {
      expect(
        deriveStepChecklist({
          stageKey,
          stageState: "NOT_APPLICABLE",
          stageStates: { HANDOVER: "COMPLETE", SETTLEMENT: "COMPLETE" },
        })
      ).toBeNull();
    }
  });
});

describe("the rail node", () => {
  const stages = [
    { key: "HANDOVER", state: "COMPLETE" as const, label: "Handover", owner: "Dealership" },
    {
      key: "DISBURSEMENT",
      state: "NOT_APPLICABLE" as const,
      label: "Confirm finance company payment",
      blocker: "No finance company pays the dealership on this deal.",
    },
    { key: "SETTLEMENT", state: "COMPLETE" as const, label: "Settlement", owner: "Dealership" },
  ];
  const t = (key: string) => en[key] ?? key;

  test("its accessible name carries the state and the reason; it is never aria-current, and it names no owner", () => {
    render(<DealStageRail stages={stages} t={t} onSelect={() => {}} />);
    const node = screen.getByTestId("deal-stage-node-DISBURSEMENT");
    expect(node.getAttribute("aria-label")).toBe(
      "Confirm finance company payment · Not needed · No finance company pays the dealership on this deal."
    );
    expect(node.getAttribute("aria-current")).toBeNull();
    expect(within(node).queryByTestId("deal-stage-owner")).toBeNull();
    // Nothing else on the rail is live either: a rail with no live node is honest.
    expect(screen.getByTestId("deal-stage-rail").querySelector('[aria-current="step"]')).toBeNull();
  });

  test("pressing it chooses to SHOW that step (never clears the view as the live node does)", () => {
    const onSelect = vi.fn();
    render(<DealStageRail stages={stages} t={t} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("deal-stage-node-DISBURSEMENT"));
    expect(onSelect).toHaveBeenCalledWith("DISBURSEMENT");
  });
});

describe("DealStagesComplete: a finished summary that does not call a not-needed stage complete", () => {
  const t = (key: string) => en[key] ?? key;

  test("all COMPLETE (notNeeded omitted or 0): the original tick, copy and count, unchanged", () => {
    const { container } = render(<DealStagesComplete count={8} expanded={false} onToggle={() => {}} t={t} />);
    expect(container.textContent).toContain("All stages complete");
    expect(container.textContent).toContain("(8)");
    expect(container.querySelector("svg.lucide-check")).not.toBeNull();
    expect(container.textContent).not.toContain("not needed");
  });

  test("with a not-needed stage: neutral wording, both counts, no tick, no completion claim", () => {
    const { container } = render(<DealStagesComplete count={6} notNeeded={1} expanded={false} onToggle={() => {}} t={t} />);
    expect(container.textContent).not.toContain("All stages complete");
    expect(container.textContent).toContain("All stages finished");
    expect(container.textContent).toContain("6 complete");
    expect(container.textContent).toContain("1 not needed");
    expect(container.querySelector("svg.lucide-check")).toBeNull();
    expect(container.querySelector(".text-emerald-800")).toBeNull();
    expect(container.querySelectorAll("bdi[dir=ltr]").length).toBe(2);
  });

  test("Arabic reads naturally with the same two counts", () => {
    const tAr = (key: string) => ar[key] ?? key;
    const { container } = render(<DealStagesComplete count={6} notNeeded={1} expanded={false} onToggle={() => {}} t={tAr} />);
    expect(container.textContent).toContain("انتهت جميع المراحل");
    expect(container.textContent).toContain("مكتملة");
    expect(container.textContent).toContain("غير مطلوبة");
    expect(container.textContent).not.toContain("اكتملت جميع المراحل");
  });
});
