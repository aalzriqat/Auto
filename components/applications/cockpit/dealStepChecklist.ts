import type { DealStageState } from "./DealStagePresentation";

/**
 * SCRUM-417 UX PR 4 (O2) -- the sub-steps inside a stage.
 *
 * A stage is one word on the rail ("Handover"), but the operator does three
 * things to finish it. This says which, and which one is next -- derived ONLY
 * from facts the cockpit already holds (the stage states, the documents, the
 * closing-readiness checks, the recorded settlement route). Nothing here is a
 * new query, and nothing here decides a business rule: the server still owns
 * every verdict, and a fact this function cannot see is a sub-step it does not
 * claim.
 *
 * Pure on purpose: no React, no i18n, no DOM. It returns keys and statuses;
 * the caller renders them and wires the destinations to controls that already
 * exist.
 */
export type ChecklistItemStatus = "done" | "current" | "pending";

/**
 * Where the current item is acted on. Each names a destination the cockpit
 * already has (UX1 S4 / UX3 workbench), never a new one.
 */
export type ChecklistDestination =
  | "documents"
  | "financeDecision"
  | "handoverCosts"
  | "closing"
  | "primaryAction";

export type ChecklistItem = Readonly<{
  id: string;
  /** Translation key; the caller owns the words. */
  labelKey: string;
  status: ChecklistItemStatus;
  destination?: ChecklistDestination;
}>;

export type ChecklistFacts = Readonly<{
  stageKey: string;
  stageState: DealStageState;
  /** The server's blocker key for this stage, when it has one. */
  blocker?: string;
  /** Every stage's state by key, so a stage can read its neighbours. */
  stageStates: Readonly<Record<string, DealStageState>>;
  /** The deal's document checklist; undefined when the payload has none. */
  documents?: ReadonlyArray<Readonly<{ required: boolean; status: string }>>;
  /**
   * The closing-readiness verdicts by check key. Undefined while readiness is
   * loading, unreadable or not permitted: the checklist then says nothing about
   * what it cannot see.
   */
  checks?: Readonly<Record<string, string>>;
  /** The overall readiness verdict ("READY", ...), when there is one. */
  readinessState?: string;
  /** Whether a settlement route is on record; undefined when the screen has no route control. */
  routeRecorded?: boolean;
}>;

type Draft = Readonly<{
  id: string;
  labelKey: string;
  /** Whether the fact behind this sub-step is established right now. */
  done: boolean;
  destination?: ChecklistDestination;
}>;

/**
 * Turns established facts into item statuses for a stage in `state`.
 *
 *  - COMPLETE: every item is done (the stage is over; there is nothing left).
 *  - live (CURRENT / BLOCKED): established facts are done, the FIRST one that
 *    is not is current, the rest are pending.
 *  - PENDING / STOPPED: nothing has started, so nothing is claimed done -- a
 *    preview of what the step will ask for, all pending.
 *
 * THE INVARIANT (SCRUM-417 UX4): an item under stage X is a gate the server
 * enforces for completing or leaving X, and the checklist never contradicts the
 * step's own status. A stage the server reports CURRENT has NO blocker -- it
 * says nothing is outstanding -- so a fact-derived item cannot be pending
 * there: only the step's own action (`primaryAction`) is left to do. Costs, for
 * example, are closing-readiness checks: they gate SETTLEMENT, and registering
 * the handover (`registerVehicleHandover`) does not read them, so they are not
 * items of HANDOVER.
 */
function settle(drafts: ReadonlyArray<Draft>, state: DealStageState): ChecklistItem[] {
  const live = state === "CURRENT" || state === "BLOCKED";
  let currentTaken = false;
  const noBlocker = state === "CURRENT";
  return drafts.map((draft): ChecklistItem => {
    let status: ChecklistItemStatus;
    if (state === "COMPLETE") status = "done";
    else if (!live) status = "pending";
    // No server blocker: every established gate reads done; only the action remains.
    else if (draft.done || (noBlocker && draft.destination !== "primaryAction")) status = "done";
    else if (!currentTaken) {
      currentTaken = true;
      status = "current";
    } else status = "pending";
    return draft.destination
      ? { id: draft.id, labelKey: draft.labelKey, status, destination: draft.destination }
      : { id: draft.id, labelKey: draft.labelKey, status };
  });
}

const UPLOADED = new Set(["UPLOADED", "VERIFIED", "WAIVED"]);
const VERIFIED = new Set(["VERIFIED", "WAIVED"]);

function approvedPurchase(f: ChecklistFacts): Draft[] {
  return [
    {
      id: "approved-amount",
      labelKey: "ChecklistApprovedAmountRecorded",
      // Positively identified: a blocker key this code does not know is NOT read as "amount recorded".
      done: f.blocker === "GapUnresolved" || f.blocker === "GapNegotiationFailed",
      destination: "financeDecision",
    },
    // The stage completes exactly when the shortfall is settled, so while it is
    // live this is never established.
    { id: "gap-settled", labelKey: "ChecklistShortfallSettled", done: false, destination: "financeDecision" },
  ];
}

function deliveryActions(f: ChecklistFacts): Draft[] | null {
  const required = (f.documents ?? []).filter((doc) => doc.required);
  if (required.length === 0) return null;
  return [
    {
      id: "documents-uploaded",
      labelKey: "ChecklistDocumentsUploaded",
      done: required.every((doc) => UPLOADED.has(doc.status)),
      destination: "documents",
    },
    {
      id: "documents-verified",
      labelKey: "ChecklistDocumentsVerified",
      done: required.every((doc) => VERIFIED.has(doc.status)),
      destination: "documents",
    },
  ];
}

/**
 * Registering the handover is refused (`registerVehicleHandover`) unless the
 * deal is APPROVED with its economics ready (`assertDealerEconomicsReady`); the
 * server reports the second as the HandoverBlocked blocker, which is the only
 * thing the stage state says about it. Handover costs are NOT read there -- they
 * gate the close, so they are SETTLEMENT items.
 */
function handover(f: ChecklistFacts): Draft[] {
  return [
    // Not "blocker !== HandoverBlocked": a stage that is BLOCKED for any reason is not ready.
    { id: "economics-ready", labelKey: "ChecklistDealFiguresReady", done: f.stageState !== "BLOCKED" },
    { id: "register-handover", labelKey: "ChecklistRegisterHandover", done: false, destination: "primaryAction" },
  ];
}

/**
 * A closing-readiness check as a sub-step. `NOT_APPLICABLE` is the server saying
 * the check does not apply to this deal, so it is absent. A key that is simply
 * not in the map is NOT that: it is a check this code expected and cannot see
 * (renamed, or not reported), so it renders not-done -- never omitted, never done.
 */
function closingCheck(
  checks: Readonly<Record<string, string>>,
  key: string,
  id: string,
  labelKey: string
): Draft | null {
  const status = checks[key];
  if (status === "NOT_APPLICABLE") return null;
  return { id, labelKey, done: status === "READY", destination: "handoverCosts" };
}

function settlement(f: ChecklistFacts): Draft[] {
  const drafts: Draft[] = [];
  if (f.routeRecorded !== undefined) {
    drafts.push({ id: "route-recorded", labelKey: "ChecklistRouteRecorded", done: f.routeRecorded });
  }
  // Handover costs gate the CLOSE (finalizeDeal reads the readiness verdict), so they live here.
  if (f.checks !== undefined) {
    const recorded = closingCheck(f.checks, "CONFIGURED_FEES_RECORDED", "costs-recorded", "ChecklistCostsRecorded");
    const paid = closingCheck(f.checks, "HANDOVER_COSTS_PAID", "costs-paid", "ChecklistCostsPaid");
    if (recorded) drafts.push(recorded);
    if (paid) drafts.push(paid);
  }
  if (f.readinessState !== undefined) {
    drafts.push({
      id: "closing-checks",
      labelKey: "ChecklistClosingChecksReady",
      done: f.readinessState === "READY",
      destination: "closing",
    });
  }
  drafts.push({ id: "close-deal", labelKey: "ChecklistCloseDeal", done: false, destination: "primaryAction" });
  return drafts;
}

function disbursement(f: ChecklistFacts): Draft[] | null {
  const handedOver = f.stageStates.HANDOVER;
  const settled = f.stageStates.SETTLEMENT;
  if (handedOver === undefined || settled === undefined) return null;
  return [
    { id: "handed-over", labelKey: "ChecklistHandoverRegistered", done: handedOver === "COMPLETE" },
    // The payment stage only opens once the sale is closed (the server's own
    // reachability rule), so a live payment step has this established.
    { id: "sale-closed", labelKey: "ChecklistSaleClosed", done: f.stageState !== "PENDING" },
    { id: "payment-confirmed", labelKey: "ChecklistPaymentConfirmed", done: false, destination: "primaryAction" },
  ];
}

/**
 * The sub-steps of a stage, or `null` when the stage has none worth listing --
 * either because it is a single event on somebody else's side (the finance
 * company's credit decision, its valuation), or because the facts a list would
 * be built from are not visible to this caller. Fewer than two items is not a
 * checklist, so it is `null` as well.
 */
export function deriveStepChecklist(facts: ChecklistFacts): ChecklistItem[] | null {
  let drafts: Draft[] | null;
  switch (facts.stageKey) {
    case "APPROVED_PURCHASE":
      drafts = approvedPurchase(facts);
      break;
    case "DELIVERY_ACTIONS":
      drafts = deliveryActions(facts);
      break;
    case "HANDOVER":
      drafts = handover(facts);
      break;
    case "SETTLEMENT":
      drafts = settlement(facts);
      break;
    case "DISBURSEMENT":
      drafts = disbursement(facts);
      break;
    default:
      drafts = null;
  }
  if (drafts === null || drafts.length < 2) return null;
  return settle(drafts, facts.stageState);
}
