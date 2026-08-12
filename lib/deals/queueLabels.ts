/**
 * Translation keys for the deal stage and status enums.
 *
 * The server sends raw enum keys — `CREDIT_DECISION`, `PENDING_DOCS` — because
 * a Convex query has no business knowing what language the operator reads. This
 * is where they become translation keys.
 *
 * ⚠️ `components/applications/cockpit/DealCockpit.tsx` currently carries its own
 * copies of these two maps. This module is the intended single home for them;
 * the cockpit is not switched over here only because that file is owned by
 * another session's in-flight change (SCRUM-61 / claim AF-20) and a drive-by
 * edit would collide with it. Migrating the cockpit to import from here is a
 * tracked follow-up on SCRUM-63, and until it happens the two must be changed
 * together. The underlying translation keys are shared, so a divergence shows up
 * as a missing key rather than as two screens quietly disagreeing.
 */

/** Every stage key either rail can produce, financed and cash. */
export const DEAL_STAGE_LABEL: Record<string, string> = {
  /** CASH only — the cash rail's anchor stage. */
  SALE_AGREED: "StageSaleAgreed",
  APPLICATION: "StageApplication",
  CREDIT_DECISION: "StageCreditDecision",
  APPRAISAL: "StageAppraisal",
  GAP_RESOLUTION: "StageGapResolution",
  APPROVED_PURCHASE: "StageApprovedPurchase",
  DELIVERY_ACTIONS: "StageDeliveryActions",
  HANDOVER: "StageHandover",
  SETTLEMENT: "StageSettlement",
};

/**
 * Two different enums share this map: `financeApplications.status` and
 * `sales.status`. They do not overlap, which is what makes one map safe.
 */
export const DEAL_STATUS_LABEL: Record<string, string> = {
  /** `sales.status`. */
  PENDING: "SaleStatusPending",
  COMPLETED: "SaleStatusCompleted",
  /** `financeApplications.status`. */
  DRAFT: "Draft",
  PENDING_DOCS: "PendingDocs",
  UNDER_REVIEW: "UnderReview",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

/**
 * How long a deal has gone without activity before the queue draws attention.
 *
 * These are DISPLAY thresholds, not business rules. Nothing in the accounting
 * or lifecycle model says a deal is late at seven days; this is the queue
 * deciding how loudly to draw a row so an operator can triage a floor at a
 * glance. Named and exported so the values are reviewable in one place rather
 * than buried as magic numbers in a class name.
 *
 * ⚠️ They measure SILENCE, not time in the current stage. See
 * `daysSinceLastActivity`.
 */
export const STALL_ATTENTION_DAYS = 3;
export const STALL_URGENT_DAYS = 7;

export type StallLevel = "FRESH" | "ATTENTION" | "URGENT";

/**
 * How long a row has been silent, banded for display.
 *
 * A deal nobody is waiting on is never stalled, however old it is — a closed
 * deal from March is not urgent, it is finished. Age only means something while
 * something is outstanding, which is why this takes `needsAttention` rather than
 * colouring purely by date.
 */
export function stallLevel(args: {
  lastActivityAt: number;
  needsAttention: boolean;
  now: number;
}): StallLevel {
  if (!args.needsAttention) return "FRESH";
  const days = (args.now - args.lastActivityAt) / 86_400_000;
  if (days >= STALL_URGENT_DAYS) return "URGENT";
  if (days >= STALL_ATTENTION_DAYS) return "ATTENTION";
  return "FRESH";
}

/**
 * Whole days since the deal last moved at all — floored, never negative.
 *
 * ⚠️ This is NOT how long the deal has been in its current stage, and the
 * wording it feeds must never say so. There is no canonical stage-entered
 * timestamp in the model: `lastActivityAt` is the application's `updatedAt`, or
 * a sale's creation when no application exists. An edit that touches nothing
 * about the stage still resets it. Presenting that as "waiting since this step
 * began" would be a precise-sounding number that is simply not the number the
 * data holds — an independent review caught the earlier copy doing exactly
 * that. Staleness is what this measures, so staleness is what it may claim.
 */
export function daysSinceLastActivity(lastActivityAt: number, now: number): number {
  return Math.max(0, Math.floor((now - lastActivityAt) / 86_400_000));
}
