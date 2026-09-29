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

export type StageViewMode = "live" | "past" | "future";

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
 * normal cockpit. A COMPLETE one has recorded evidence to read. Anything else
 * (PENDING, STOPPED) has not happened, so it shows what it will need.
 */
export function stageViewMode(state: DealStageState): StageViewMode {
  if (state === "CURRENT" || state === "BLOCKED") return "live";
  if (state === "COMPLETE") return "past";
  return "future";
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

export function stageNeedsKey(stageKey: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(NEEDS_KEY, stageKey) ? NEEDS_KEY[stageKey] : undefined;
}
