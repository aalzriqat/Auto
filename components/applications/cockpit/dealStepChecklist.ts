import { FINALIZE_DENOMINATION_REASON } from "@/components/applications/settlementDenomination";
import type { ClosingReadinessCheckKey } from "@/lib/closingReadinessReasonCodes";
import type { DealStageState } from "./DealStagePresentation";

/**
 * SCRUM-417 UX PR 4 (O2) -- the sub-steps inside a stage.
 *
 * A stage is one word on the rail ("Handover"), but the operator does more than
 * one thing to finish it. This says which, and which one is next.
 *
 * THE INVARIANT (round 1): the checklist is never its own derivation of "what is
 * next". Every item is a gate the SERVER enforces for completing or leaving its
 * stage (`registerVehicleHandover`, `finalizeDeal`, `completeDraft`), and:
 *
 *  (a) an item is DONE only when the server positively reports that fact -- a
 *      stage state, a document status, a readiness verdict, the expected-payment
 *      flag. Nothing is done because nothing else was reported.
 *  (b) an unknown, absent or unreadable fact is NOT DONE. It is never omitted
 *      and never read as done. Only the server's own `NOT_APPLICABLE` removes an
 *      item.
 *  (c) the items mirror the gates in the order the server checks them, for the
 *      deal kind at hand (a cash deal is not given the financed chain).
 *  (d) the CURRENT item agrees with the live control the step offers. A gate the
 *      list does not otherwise model (a held deposit, a pending deposit request,
 *      an unsupported currency, a reconciliation note, a cash deposit decision)
 *      is added ONLY when the live control reports it, and is then the current
 *      item. An item whose fact is UNKNOWN is shown, not done, and never takes
 *      the current slot (round 2): the operator is not sent to act on a guess.
 *
 * ROUND 2 -- the checklist exists for the LIVE stage only. The server reports
 * item-level facts only while a stage is open (readiness closes and returns no
 * checks once the deal is closed) and none before it starts, so a completed or
 * upcoming stage could only be all-ticked or all-pending, and both are false.
 * Those views keep their read-only evidence and their "needs" copy instead.
 *
 * Pure on purpose: no React, no i18n, no DOM. It returns keys and statuses; the
 * caller renders them and wires the destinations to controls that already exist.
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

/** What the step's own control says right now (the cockpit's `workflowAction` for the live stage). */
export type ChecklistLiveAction = Readonly<{
  actionKey: string;
  unavailableReasonKey?: string;
}>;

export type ChecklistFacts = Readonly<{
  stageKey: string;
  stageState: DealStageState;
  /**
   * The identity of the cockpit: "SALE" is the sale-keyed one (`applicationId`
   * is null -- a cash sale, or a financed sale opened without its application),
   * which has the sale's own steps; "APPLICATION" is the financed chain. NOT
   * `dealKind`: an applicationless FINANCED/LEASE sale reports `dealKind:
   * "FINANCED"` and still has no appraisal, handover registration or close.
   */
  path?: "SALE" | "APPLICATION";
  /** The server's blocker key for this stage, when it has one. */
  blocker?: string;
  /** Every stage's state by key, so a stage can read its neighbours. */
  stageStates: Readonly<Record<string, DealStageState>>;
  /** The deal's document checklist; undefined when the payload has none. */
  documents?: ReadonlyArray<Readonly<{ required: boolean; status: string }>>;
  /**
   * The closing-readiness verdicts by check key. `undefined` = not read (loading,
   * unreadable, not permitted); `{}` = read and empty. Both mean "no key is
   * known", so no cost item reads done.
   */
  checks?: Readonly<Partial<Record<ClosingReadinessCheckKey, string>>>;
  /** The overall readiness verdict ("READY", ...), when there is one. */
  readinessState?: string;
  /** The server's `expectedPaymentRegistered`; undefined while unknown, which is not done. */
  expectedPaymentRegistered?: boolean;
  /** The server's `supplierSettlementRouteRequired`: `finalizeDeal` will refuse for want of a route. */
  routeRequired?: boolean;
  /** Whether a settlement route is on record; undefined when the screen has no route control. */
  routeRecorded?: boolean;
  /**
   * The server reports the deal CLOSED (`status === "CLOSED"`). A closed financed
   * deal can keep SETTLEMENT live for what is still owed after the close, and
   * "closing checks -> close the deal" is then false: readiness is closed and no
   * close control exists. Nothing is listed for it (the post-close list needs
   * obligation facts the payload does not carry yet).
   */
  closed?: boolean;
  /** The live control of THIS stage; absent for a stage that is not the live one. */
  liveAction?: ChecklistLiveAction;
}>;

type Draft = Readonly<{
  id: string;
  labelKey: string;
  /** Whether the fact behind this sub-step is positively established right now. */
  done: boolean;
  destination?: ChecklistDestination;
  /**
   * A gate that exists in the list only because the live control reports it, so
   * it outranks the order of the facts: it is what the operator is being asked
   * to do (invariant d).
   */
  gate?: true;
  /** The fact is not on hand (not reported, unreadable): shown, not done, never current. */
  unknown?: true;
}>;

/**
 * Turns established facts into item statuses for the LIVE stage.
 *
 * Positively established facts are done. The current item is the live control's
 * gate when it reported one, otherwise the FIRST item that is neither done nor
 * unknown; the rest are pending. Nothing here infers "done" from the absence of
 * a blocker, and nothing is ticked for a stage that is not live.
 */
function settle(drafts: ReadonlyArray<Draft>): ChecklistItem[] {
  const gate = drafts.find((draft) => draft.gate && !draft.done);
  let currentTaken = false;
  return drafts.map((draft): ChecklistItem => {
    let status: ChecklistItemStatus;
    if (draft.done) status = "done";
    else if (gate ? draft === gate : !currentTaken && !draft.unknown) {
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
const CURRENCY_REASONS: ReadonlySet<string> = new Set(Object.values(FINALIZE_DENOMINATION_REASON));

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
    // live this is never established. Settled by `resolveAppraisalGap`, which is
    // the step's own action -- not by the finance-decision panel.
    { id: "gap-settled", labelKey: "ChecklistShortfallSettled", done: false, destination: "primaryAction" },
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
 * Financed handover: a single act, `registerVehicleHandover`. The server has no
 * item-level fact for its other precondition (the deal's economics being ready)
 * -- the stage state is one verdict for the whole step, not a tick for one part
 * of it -- so nothing is listed or ticked for it. One item is not a checklist:
 * the live control already carries the action and any reason it is withheld.
 * Handover costs are not read here either; they gate the close, so they are
 * SETTLEMENT items.
 */
function handover(): Draft[] {
  return [{ id: "register-handover", labelKey: "ChecklistRegisterHandover", done: false, destination: "primaryAction" }];
}
/**
 * A cash deal's handover is the sale still being a draft: the step is
 * `completeDraft`. There is no server fact for the deal's figures on this path,
 * so none is ticked. The one other thing the step can be waiting on is the
 * deposit decision, listed only when the live control reports it.
 */
function cashHandover(f: ChecklistFacts): Draft[] {
  const drafts: Draft[] = [];
  if (f.liveAction?.unavailableReasonKey === "CashSaleCompletionNeedsDepositDecision") {
    drafts.push({ id: "cash-deposit-decision", labelKey: "ChecklistCashDepositDecision", done: false, gate: true });
  }
  drafts.push({ id: "complete-sale", labelKey: "ChecklistCompleteSale", done: false, destination: "primaryAction" });
  return drafts;
}

/**
 * A closing-readiness check as a sub-step. `NOT_APPLICABLE` is the server saying
 * the check does not apply to this deal, so it is absent. A key that is simply
 * not in the map is NOT that: it is a check this code expected and cannot see
 * (renamed, not reported, or the read failed), so it renders not-done -- never
 * omitted, never done.
 */
function closingCheck(
  checks: Readonly<Partial<Record<ClosingReadinessCheckKey, string>>>,
  key: ClosingReadinessCheckKey,
  id: string,
  labelKey: string
): Draft | null {
  const status = checks[key];
  if (status === "NOT_APPLICABLE") return null;
  return {
    id,
    labelKey,
    done: status === "READY",
    destination: "handoverCosts",
    ...(status === undefined ? { unknown: true as const } : {}),
  };
}

/**
 * Financed settlement, in the order `finalizeDeal` checks: the expected payment,
 * the settlement route, then the closing readiness (of which the handover costs
 * are the two the operator acts on), then the close itself.
 */
function settlement(f: ChecklistFacts): Draft[] {
  const drafts: Draft[] = [
    {
      id: "expected-payment",
      labelKey: "ChecklistExpectedPaymentRegistered",
      done: f.expectedPaymentRegistered === true,
      destination: "primaryAction",
    },
  ];
  // Gates the live control reports, none of which the facts above can see.
  const reason = f.liveAction?.unavailableReasonKey;
  // `finalizeDeal` refuses FIRST on a waiting deposit request (before the
  // route), so it is listed first; the live control says so, and it is then what
  // the operator has to resolve.
  if (reason === "FinalizeNeedsPendingDepositRequestResolved") {
    drafts.push({ id: "deposit-request-resolved", labelKey: "ChecklistDepositRequestResolved", done: false, gate: true });
  }
  // Present only when the server says a route is required, or one is already on
  // record (so the tick survives recording it). Done only when the server no
  // longer requires it AND one is recorded.
  if (f.routeRequired === true || f.routeRecorded === true) {
    drafts.push({
      id: "route-recorded",
      labelKey: "ChecklistRouteRecorded",
      done: f.routeRequired === false && f.routeRecorded === true,
    });
  }
  if (reason === "FinalizeNeedsHeldDepositResolved") {
    drafts.push({ id: "deposit-resolved", labelKey: "ChecklistDepositResolved", done: false, gate: true });
  }
  if (reason !== undefined && CURRENCY_REASONS.has(reason)) {
    drafts.push({ id: "currency-supported", labelKey: "ChecklistCurrencySupported", done: false, gate: true });
  }
  if (f.liveAction?.actionKey === "ResolveReconciliationAction") {
    drafts.push({ id: "reconciliation-resolved", labelKey: "ChecklistReconciliationResolved", done: false, gate: true });
  }
  // Handover costs gate the CLOSE (finalizeDeal reads the readiness verdict).
  const checks = f.checks ?? {};
  const recorded = closingCheck(checks, "CONFIGURED_FEES_RECORDED", "costs-recorded", "ChecklistCostsRecorded");
  const paid = closingCheck(checks, "HANDOVER_COSTS_PAID", "costs-paid", "ChecklistCostsPaid");
  if (recorded) drafts.push(recorded);
  if (paid) drafts.push(paid);
  // No readiness verdict on hand (loading, unreadable, not permitted): the
  // closing checks are unknown, and the close cannot be offered either, so
  // neither is what the operator is sent to act on.
  const readinessUnknown = f.readinessState === undefined;
  drafts.push({
    id: "closing-checks",
    labelKey: "ChecklistClosingChecksReady",
    done: f.readinessState === "READY",
    destination: "closing",
    ...(readinessUnknown ? { unknown: true as const } : {}),
  });
  drafts.push({
    id: "close-deal",
    labelKey: "ChecklistCloseDeal",
    done: false,
    destination: "primaryAction",
    ...(readinessUnknown ? { unknown: true as const } : {}),
  });
  return drafts;
}

function disbursement(f: ChecklistFacts): Draft[] | null {
  const handedOver = f.stageStates.HANDOVER;
  const settled = f.stageStates.SETTLEMENT;
  if (handedOver === undefined || settled === undefined) return null;
  return [
    { id: "handed-over", labelKey: "ChecklistHandoverRegistered", done: handedOver === "COMPLETE" },
    // The payment stage only opens once the sale is closed (the server's own
    // reachability rule), so the server having made it live IS the report. The
    // settlement stage cannot say it: it stays PENDING until the finance
    // company pays.
    { id: "sale-closed", labelKey: "ChecklistSaleClosed", done: f.stageState !== "PENDING" },
    { id: "payment-confirmed", labelKey: "ChecklistPaymentConfirmed", done: false, destination: "primaryAction" },
  ];
}

/**
 * The sub-steps of a stage, or `null` when the stage has none worth listing --
 * either because it is a single event on somebody else's side (the finance
 * company's credit decision, its valuation), because it is a single action of
 * ours (a cash sale with nothing else to say), or because the list would be a
 * guess. Fewer than two items is not a checklist, so it is `null` as well.
 */
export function deriveStepChecklist(facts: ChecklistFacts): ChecklistItem[] | null {
  let drafts: Draft[] | null;
  // Only the live stage has item-level facts the server reports.
  if (facts.stageState !== "CURRENT" && facts.stageState !== "BLOCKED") return null;
  if (facts.path === "SALE") {
    drafts = facts.stageKey === "HANDOVER" ? cashHandover(facts) : null;
  } else {
    switch (facts.stageKey) {
      case "APPROVED_PURCHASE":
        drafts = approvedPurchase(facts);
        break;
      case "DELIVERY_ACTIONS":
        drafts = deliveryActions(facts);
        break;
      case "HANDOVER":
        drafts = handover();
        break;
      case "SETTLEMENT":
        // A closed deal has no close to walk towards.
        drafts = facts.closed === true ? null : settlement(facts);
        break;
      case "DISBURSEMENT":
        drafts = disbursement(facts);
        break;
      default:
        drafts = null;
    }
  }
  if (drafts === null || drafts.length < 2) return null;
  return settle(drafts);
}
