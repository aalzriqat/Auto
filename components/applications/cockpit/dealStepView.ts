import type { DealStageState } from "./DealStagePresentation";

/**
 * SCRUM-417 UX PR 4 (O3) -- which step the operator is LOOKING at.
 *
 * Looking is not doing. The live stage is decided by the server and by nothing
 * else; this only decides which step's card is shown above the working surface.
 * It never feeds `live`, the workbench, or any command, so viewing a past or
 * future step cannot change what the deal is waiting on.
 */
export const STAGE_PARAM = "stage";

export type StageViewMode = "live" | "past" | "future" | "stopped" | "notApplicable";

/**
 * The `?stage=` deep link, owned by the route and handed down: the value as it
 * is in the address bar, and the way to write it back. `null` clears it.
 */
export type StageDeepLink = Readonly<{
  value: string | null;
  onChange: (key: string | null) => void;
}>;

type StageLike = Readonly<{ key: string; state: DealStageState }>;

/**
 * The stage a `?stage=` value names, or `undefined` for anything else.
 *
 * An empty, repeated-array, unknown or prototype-ish value falls back to "no
 * choice", which is the live step. Matched against the stage keys the deal
 * actually HAS -- a cash deal has no APPRAISAL, so `?stage=APPRAISAL` there is
 * unknown, not a stage to invent.
 */
export function resolveViewedStage<S extends StageLike>(
  value: string | null | undefined,
  stages: ReadonlyArray<S>
): S | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return stages.find((stage) => stage.key === value);
}

/**
 * How a step is shown. A live step (the server's CURRENT / BLOCKED) is the
 * normal cockpit. A COMPLETE one has recorded evidence to read. A PENDING one
 * has not happened yet, so it shows what it will need. A STOPPED one belongs to
 * a rejected or cancelled deal and will never happen: it says so, and promises
 * no needs and no actor.
 */
export function stageViewMode(state: DealStageState): StageViewMode {
  if (state === "CURRENT" || state === "BLOCKED") return "live";
  if (state === "COMPLETE") return "past";
  if (state === "STOPPED") return "stopped";
  // Proven never to happen on this deal: not a preview (nothing is coming), not
  // a stop (the deal did not fail) -- it says it is not needed, and why.
  if (state === "NOT_APPLICABLE") return "notApplicable";
  return "future";
}

/**
 * Why a stage the server marked NOT_APPLICABLE is not needed, per stage KEY.
 * DISBURSEMENT (SCRUM-446) and DELIVERY_ACTIONS (SCRUM-629 F-07) are emitted
 * today; a stage the server adds later says the generic sentence rather than a
 * reason nobody verified.
 */
const NOT_APPLICABLE_REASON_KEY: Readonly<Record<string, string>> = {
  DISBURSEMENT: "StageNotApplicableReasonDisbursement",
  DELIVERY_ACTIONS: "StageNotApplicableReasonDeliveryActions",
};

export function stageNotApplicableReasonKey(stageKey: string): string {
  return Object.prototype.hasOwnProperty.call(NOT_APPLICABLE_REASON_KEY, stageKey)
    ? NOT_APPLICABLE_REASON_KEY[stageKey]
    : "StageViewNotApplicableNote";
}

/**
 * What a not-yet-happened step will need, as a translation key per stage.
 * Keyed by stage KEY, never by index. A stage the server adds later has no
 * entry and says only who acts, rather than a guess.
 */
const NEEDS_KEY: Readonly<Record<string, string>> = {
  APPLICATION: "StageNeedsApplication",
  CREDIT_DECISION: "StageNeedsCreditDecision",
  APPRAISAL: "StageNeedsAppraisal",
  APPROVED_PURCHASE: "StageNeedsApprovedPurchase",
  DELIVERY_ACTIONS: "StageNeedsDeliveryActions",
  DISBURSEMENT: "StageNeedsDisbursement",
  HANDOVER: "StageNeedsHandover",
  SETTLEMENT: "StageNeedsSettlement",
  SALE_AGREED: "StageNeedsSaleAgreed",
};

/**
 * The two stages a cash deal has that mean something different from the
 * financed ones: its handover is the draft sale being completed, and its
 * settlement is the supplier's claim -- neither is the financed chain.
 */
const CASH_NEEDS_KEY: Readonly<Record<string, string>> = {
  HANDOVER: "StageNeedsHandoverCash",
  SETTLEMENT: "StageNeedsSettlementCash",
};

/**
 * `path` is the cockpit's identity, not the deal's kind: "SALE" (no
 * `applicationId`) is the sale-keyed cockpit, whose handover and settlement mean
 * something different from the financed chain, even when the sale is a financed
 * one.
 */
export function stageNeedsKey(stageKey: string, path?: "SALE" | "APPLICATION"): string | undefined {
  if (path === "SALE" && Object.prototype.hasOwnProperty.call(CASH_NEEDS_KEY, stageKey)) {
    return CASH_NEEDS_KEY[stageKey];
  }
  return Object.prototype.hasOwnProperty.call(NEEDS_KEY, stageKey) ? NEEDS_KEY[stageKey] : undefined;
}

const NOTE_KEY: Readonly<Record<Exclude<StageViewMode, "live">, string>> = {
  past: "StageViewPastNote",
  future: "StageViewFutureNote",
  stopped: "StageViewStoppedNote",
  notApplicable: "StageViewNotApplicableNote",
};

/**
 * The words a viewed (non-live) step shows: a note, and -- for a step still to
 * come -- what it will need.
 *
 * One case is neither "not started" nor a preview: the financed SETTLEMENT step
 * of a deal the server reports CLOSED. The deal's own closing steps are done;
 * the step stays PENDING until the finance company's payment is confirmed, so it
 * says exactly that instead of "has not started". `closed` must be a fact the
 * payload reports (`status === "CLOSED"`), never an inference from the rail.
 */
export function stageViewCopy(
  mode: Exclude<StageViewMode, "live">,
  stageKey: string,
  opts: Readonly<{ path?: "SALE" | "APPLICATION"; closed?: boolean }> = {}
): Readonly<{ noteKey: string; needsKey?: string }> {
  if (mode === "future" && stageKey === "SETTLEMENT" && opts.path !== "SALE" && opts.closed === true) {
    return { noteKey: "StageViewSettlementClosedNote" };
  }
  if (mode === "notApplicable") return { noteKey: stageNotApplicableReasonKey(stageKey) };
  return {
    noteKey: NOTE_KEY[mode],
    needsKey: mode === "future" ? stageNeedsKey(stageKey, opts.path) : undefined,
  };
}