import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { orderStagesForDisplay } from "./dealStageDisplayOrder";
import { resolveViewedStage, type StageDeepLink } from "./dealStepView";
import { isLiveStageState, type DealCockpitData } from "./DealStagePresentation";
import { recordPanelId, workbenchPanelId, type WorkbenchPanel } from "./dealWorkbenchPanels";

export function useDealStageNavigation({
  deal,
  stageDeepLink,
  lowerTabsRef,
  documentsTriggerRef,
  flowRef,
  flowFocusRef,
}: Readonly<{
  deal: DealCockpitData | null | undefined;
  stageDeepLink?: StageDeepLink;
  lowerTabsRef: RefObject<HTMLDivElement | null>;
  documentsTriggerRef: RefObject<HTMLButtonElement | null>;
  flowRef: RefObject<HTMLDivElement | null>;
  flowFocusRef: RefObject<HTMLElement | null>;
}>) {
  // O4: whether the phone's folded stage rail is open. Presentation only.
  const [railOpen, setRailOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  // The lower documents · activity tabs are controlled so the live step can
  // send the operator to the documents it says are outstanding. The default is
  // unchanged, and a manual switch to Activity still goes through.
  const [lowerTab, setLowerTab] = useState<"documents" | "activity">("documents");

  // SCRUM-417 UX3 (O1): the "Deal details" record. `null` = the operator has not
  // chosen, so it follows the default (collapsed while the live step has a panel
  // of its own, open when nothing is promoted); a choice, or a blocker link that
  // needs a panel inside it, overrides.
  const [detailsChoice, setDetailsChoice] = useState<boolean | null>(null);
  // Which step the operator is LOOKING at when no deep link owns that choice.
  const [localViewedKey, setLocalViewedKey] = useState<string | null>(null);
  const requestedStageKey = stageDeepLink ? stageDeepLink.value : localViewedKey;
  const requestStage = stageDeepLink ? stageDeepLink.onChange : setLocalViewedKey;
  const liveStageKey = deal
    ? (orderStagesForDisplay(deal.stages).find((s) => isLiveStageState(s.state))?.key ?? null)
    : null;
  const seenLiveStageRef = useRef(liveStageKey);
  // A reactive stage change (another user registers the handover) demotes the
  // panel the operator is working in into the collapsed record. A demoted panel
  // that holds an ACTIVE TASK — focus inside it, or a child marking
  // `data-active-task` (an open add-cost form, an unresolved attempt, an open
  // custody dialog) — opens the record instead of vanishing under the operator.
  // A demoted panel with nothing active stays collapsed. Child state is not
  // lifted: the panel says so on its own DOM. Layout effect, so the record is
  // open again before the browser paints or fixes focus up.
  useLayoutEffect(() => {
    if (seenLiveStageRef.current === liveStageKey) return;
    seenLiveStageRef.current = liveStageKey;
    const active = document.activeElement;
    const holdsTask = Array.from(flowRef.current?.querySelectorAll<HTMLElement>('[data-zone="record"]') ?? []).some(
      (wrapper) =>
        wrapper.hidden && (wrapper.querySelector("[data-active-task]") !== null || (active !== null && wrapper.contains(active)))
    );
    if (holdsTask) setDetailsChoice(true);
  }, [flowRef, liveStageKey]);
  // A step that was being LOOKED at and has since become the live one is no
  // longer "another step": clear the choice, so the address bar does not keep a
  // `?stage=` that would resurface as a stale view when the deal moves on.
  useEffect(() => {
    if (!deal || requestedStageKey === null) return;
    const chosen = resolveViewedStage(requestedStageKey, deal.stages);
    if (chosen && isLiveStageState(chosen.state)) requestStage(null);
  }, [deal, requestedStageKey, requestStage]);
  // Focus follows the task: if the stage change (or the re-open above) left
  // the document without focus, return it to where the operator was.
  useLayoutEffect(() => {
    const focused = flowFocusRef.current;
    if (
      focused?.isConnected &&
      (document.activeElement === null || document.activeElement === document.body) &&
      focused.closest("[hidden]") === null
    ) {
      focused.focus({ preventScroll: true });
    }
  }, [flowFocusRef, liveStageKey, detailsChoice]);
  // Open the record if `target` lives in it. Called from the click handler,
  // BEFORE the scroll frame: React flushes a discrete event's update at its end,
  // so the panel is on screen (and focusable) when the scroll and focus land.
  // Looked up in the document, never through a ref, so nothing reads a ref while
  // rendering (the closing destinations below are built during render).
  const revealDetailsFor = (target: Element | null) => {
    if (target && target.closest('[data-zone="record"]')) setDetailsChoice(true);
  };
  const goToDocuments = () => {
    setLowerTab("documents");
    revealDetailsFor(document.querySelector('[data-testid="deal-lower-tabs"]'));
    // After the switch has painted, so the scroll lands on the visible pane.
    // The target's `scroll-mt-*` keeps it clear of the sticky header; focus
    // moves to the Documents tab without a second, instant jump.
    requestAnimationFrame(() => {
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      lowerTabsRef.current?.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      documentsTriggerRef.current?.focus({ preventScroll: true });
    });
  };

  // SCRUM-417 UX1 (S4): a failed closing check opens the panel that resolves
  // it. Same scroll-then-focus contract as `goToDocuments`; the target is a
  // panel this view renders itself, found by id at click time (never at render).
  const goToPanel = (id: string) => {
    revealDetailsFor(document.getElementById(id));
    requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (!target) return;
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      target.focus({ preventScroll: true });
    });
  };
  // Bring a promoted or recorded panel into view by its flow wrapper, opening the
  // Deal-details record first when it lives there. Focus goes to the first
  // control inside it, when it has one; the wrapper itself is never focusable.
  const goToFlowPanel = (panel: WorkbenchPanel) => {
    const find = () =>
      document.getElementById(workbenchPanelId(panel)) ?? document.getElementById(recordPanelId(panel));
    revealDetailsFor(find());
    requestAnimationFrame(() => {
      const target = find();
      if (!target) return;
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      target
        .querySelector<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ?.focus({ preventScroll: true });
    });
  };

  return {
    requestedStageKey,
    requestStage,
    goToPanel,
    goToFlowPanel,
    rail: {
      open: railOpen,
      showCompleted,
      toggle: () => setRailOpen((open) => !open),
      toggleCompleted: () => setShowCompleted((open) => !open),
    },
    details: {
      choice: detailsChoice,
      onChange: setDetailsChoice,
    },
    documents: {
      tab: lowerTab,
      onChange: (value: string) => setLowerTab(value === "activity" ? "activity" : "documents"),
      goTo: goToDocuments,
    },
  };
}
