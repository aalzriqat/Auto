import type { ReactNode } from "react";

/**
 * SCRUM-417 UX PR 3 (O1) -- which panel the live step works from.
 *
 * The cockpit shows the current step's own panel directly under the next-step
 * card and keeps every other panel, whole, in a collapsed "Deal details"
 * record. This map decides ONLY where a panel is drawn. Whether it is offered
 * at all, and who may act in it, stay with the containers that build the props;
 * a panel a caller is not wired for is simply absent, as before.
 *
 * Keyed by stage KEY, never by index, so the display re-ordering and any stage
 * the server adds later cannot silently promote the wrong panel. An unknown
 * stage promotes nothing and the whole record stays open.
 */
export const WORKBENCH_PANELS = [
  "documents",
  "financeDecision",
  "handoverCosts",
  "custody",
  "closing",
  "money",
] as const;

export type WorkbenchPanel = (typeof WORKBENCH_PANELS)[number];

export function recordPanelId(key: string): string {
  return `deal-record-${key}`;
}

export function workbenchPanelId(key: string): string {
  return `deal-workbench-${key}`;
}

const PANELS_BY_STAGE: Readonly<Record<string, readonly WorkbenchPanel[]>> = {
  // The checklist that also does something: upload, verify, view.
  CREDIT_DECISION: ["documents"],
  DELIVERY_ACTIONS: ["documents"],
  // What the finance company told us, and the correction of it.
  APPRAISAL: ["financeDecision"],
  APPROVED_PURCHASE: ["financeDecision"],
  // The costs of handing the car over, and the custody that pays for them.
  HANDOVER: ["handoverCosts", "custody"],
  // The route, the automatic closing checks and the legal invoice.
  SETTLEMENT: ["closing"],
  // Confirming the finance company's payment reads off the money summary.
  DISBURSEMENT: ["money"],
};

const NONE: readonly WorkbenchPanel[] = [];

export function panelsForStage(stageKey: string | undefined): readonly WorkbenchPanel[] {
  if (stageKey === undefined) return NONE;
  return Object.prototype.hasOwnProperty.call(PANELS_BY_STAGE, stageKey) ? PANELS_BY_STAGE[stageKey] : NONE;
}

export function arrangeWorkbenchPanels({
  stageKey,
  panels,
  vehicle,
  plan,
  workbenchPending,
  detailsChoice,
}: Readonly<{
  stageKey: string | undefined;
  panels: Readonly<Record<WorkbenchPanel, ReactNode>>;
  vehicle: ReactNode;
  plan: ReactNode;
  workbenchPending: boolean;
  detailsChoice: boolean | null;
}>) {
  const possible = panelsForStage(stageKey);
  const promoted = possible.filter((panel) => panels[panel] != null);
  const waiting = workbenchPending && possible.length > 0;
  // Keep the record closed while a panel can still arrive, to avoid a flash.
  const detailsOpen = detailsChoice ?? (promoted.length === 0 && !waiting);
  const inRecord = (panel: WorkbenchPanel) => promoted.includes(panel) ? null : panels[panel];

  const recordItems: Array<[string, ReactNode]> = [
    ["money", inRecord("money")],
    ["vehicle", vehicle],
    ["plan", plan],
    ["financeDecision", inRecord("financeDecision")],
    ["handoverCosts", inRecord("handoverCosts")],
    ["closing", inRecord("closing")],
    ["custody", inRecord("custody")],
    ["documents", inRecord("documents")],
  ];
  const workbenchItems: Array<[WorkbenchPanel, ReactNode]> = promoted.map((panel) => [panel, panels[panel]]);
  return { detailsOpen, workbenchItems, recordItems: recordItems.filter(([, node]) => node != null) };
}
