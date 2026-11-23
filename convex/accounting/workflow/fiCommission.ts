import { type Id } from "../../_generated/dataModel";
import { type MutationCtx } from "../../_generated/server";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureSaleFiAccounts } from "../chartAccountsProvision";
import { postDomainEvent } from "./posting";
import { getOpenPeriodForDate } from "../../utils/postingPeriod";
import { reverseAccountingEvent } from "../reversals";
import { enqueuePendingReversal, cancelPendingPostsBySource } from "../outboxIngress";

/** Idempotency key of one deferral's commission recognition for one month. */
export function fiCommissionRecognizedKey(
  deferralId: Id<"dealerProductDeferrals">,
  yearMonth: string
): string {
  return `fi_commission_${deferralId}_${yearMonth}`;
}

/**
 * One FI_COMMISSION_RECOGNIZED event per recognized month. eventVersion is the
 * 1-based month ordinal; postAccountingEvent dedupes on (eventType, sourceType,
 * sourceId, eventVersion), so it must differ per month (SCRUM-537).
 */
export async function hookFiCommissionRecognized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    deferralId: Id<"dealerProductDeferrals">;
    yearMonth: string; // "YYYY-MM", used only for the idempotency key
    occurrence: number; // 1-based ordinal of this recognized month -> eventVersion
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureSaleFiAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FI_COMMISSION_RECOGNIZED",
    sourceType: "dealerProductDeferrals",
    sourceId: args.deferralId.toString(),
    eventVersion: args.occurrence,
    idempotencyKey: fiCommissionRecognizedKey(args.deferralId, args.yearMonth),
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      deferralId: args.deferralId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

/**
 * Claws back every month of F&I commission already recognized for a
 * deferral whose sale was cancelled — unlike makeReversalHook's single-event
 * lookup, a deferral has one FI_COMMISSION_RECOGNIZED event per recognized
 * month (eventVersion = the month's ordinal), so each is reversed
 * individually. reverseAccountingEvent is a no-op (returns alreadyReversed) on an
 * event it's already reversed, so this is safe to call more than once for the same deferral. Also drops any
 * month that was enqueued but never posted, so it never posts later.
 */
export async function hookFiCommissionRecognitionsReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    deferralId: Id<"dealerProductDeferrals">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<void> {
  const postedEvents = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", args.orgId).eq("sourceType", "dealerProductDeferrals").eq("sourceId", args.deferralId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "FI_COMMISSION_RECOGNIZED"))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .collect();

  const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
  for (const event of postedEvents) {
    const reversalIdempotencyKey = `fi_commission_reversed_${event._id}`;
    if (period) {
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
      });
    } else {
      await enqueuePendingReversal(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
        sourceType: "dealerProductDeferrals",
        sourceId: args.deferralId.toString(),
      });
    }
  }

  // Drops every not-yet-posted queued month, PENDING or FAILED — a recognition
  // attempt that failed 10 times (accountingOutbox.ts's MAX_ATTEMPTS) moves to
  // FAILED but stays retryable by a finance user, so a status: "PENDING"-only
  // sweep here would leave it behind: a later manual retry could then post F&I
  // revenue for a deferral whose sale was already cancelled.
  await cancelPendingPostsBySource(ctx, args.orgId, "dealerProductDeferrals", args.deferralId.toString());
}
