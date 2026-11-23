import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { type EventType } from "../postingRules";
import { getOpenPeriodForDate } from "../../utils/postingPeriod";
import { reverseAccountingEvent } from "../reversals";
import { enqueuePendingReversal, cancelPendingPostByKey } from "../outboxIngress";

/**
 * What actually became of a reversal.
 *
 *  - REVERSED — the reversing journal is posted. The money is back.
 *  - DEFERRED — no period was open, so the reversal is queued. The original
 *    entry is STILL POSTED until the outbox drains, and anything that treats
 *    the amount as recovered before then is spending money the ledger still
 *    shows as spent.
 *  - NOT_POSTED — no live POSTED forward occurrence remains, and no queued
 *    forward post survives. An OPERATIONAL statement about the ledger NOW,
 *    never a claim about history.
 *
 * Returned rather than swallowed because the caller has to tell DEFERRED from
 * REVERSED. Collapsing the two is what let a slice be refunded in cash while
 * its original application was still live in the general ledger.
 *
 * ## Why NOT_POSTED is operational and not historical (owner ruling c17613 §1)
 *
 * This used to read "the forward entry never posted, and any queued copy of it
 * has been cancelled" — a claim about history, and a FALSE one in a case the
 * suite deliberately accepts. `clearCheque`'s return path in `collections.ts`
 * reverses a `collectionPayments` occurrence under
 * `cheque_return_after_clear_<chequeId>`, a key this module can never mint. An
 * occurrence reversed that way DID post; asked afterwards, the helpers below
 * find no POSTED row and answer NOT_POSTED. Reproduced through the real outbox
 * worker in `accountingReceiptOccurrenceIdentity.test.ts` §12 OB2.
 *
 * The already-reversed case is NOT given an outcome of its own, because no
 * consumer needs the distinction. The enumeration, current and planned:
 *
 *   - `utils/depositApplications.ts` `reverseDepositApplicationsForSale` is the
 *     ONLY production branch on this type at all: `journalReversed = outcome
 *     !== "DEFERRED"`. Downstream (`utils/saleCancellation.ts`) reads that
 *     boolean and never the outcome. It asks "is a forward journal still
 *     standing?" — for which never-posted and already-reversed are one answer.
 *   - `reverseReceiptOccurrence` has NO production caller; the facade is
 *     interface-only at this revision.
 *   - SCRUM-236 needs proof that one producer owns an occurrence identity.
 *   - SCRUM-130 needs the cheque's GL reversal and its debt reopening to move
 *     together, and the reopening to use the outstanding balance.
 *
 * None of the four needs the history. Add a fourth outcome when a consumer
 * actually requires it — and note that `depositApplications`' own comment
 * already records the stronger lesson: that guard was rewritten to read the
 * LEDGER rather than the caller's `ReversalOutcome`, precisely because an
 * outcome describes one branch's path and not the state of the books.
 */
export type ReversalOutcome = "REVERSED" | "DEFERRED" | "NOT_POSTED";

/**
 * Generic "undo this posted event, or drop it if it never posted" used when
 * voiding an upstream operation (a cancelled sale, a voided finance deal, a
 * deposit recorded in error). Reverses the posted journal inside an open
 * period, defers the reversal to the outbox when no period is open, and
 * cancels a still-unposted outbox entry so the round trip nets to zero.
 */
export async function reverseEventIfPosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sourceType: string;
    sourceId: string;
    eventType: EventType;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
    reversalIdempotencyKey: string;
    pendingPostIdempotencyKey: string;
    /**
     * Pins the reversal to ONE event when several share a source.
     *
     * A source that can move money more than once — a deposit applied to each
     * car on its quote, a claim collected in instalments — writes several
     * events under one `sourceId`, distinguished only by version. Without this
     * the lookup below takes `.first()`, so a reversal aimed at the third
     * movement backs out the first: a live invoice loses its credit and the
     * cancelled one keeps it. Omit it only where the source genuinely posts
     * once.
     */
    eventVersion?: number;
  }
): Promise<ReversalOutcome> {
  const originalEvent =
    args.eventVersion === undefined
      ? await ctx.db
          .query("accountingEvents")
          .withIndex("by_org_source", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("sourceType", args.sourceType)
              .eq("sourceId", args.sourceId)
          )
          .filter((q) => q.eq(q.field("eventType"), args.eventType))
          .filter((q) => q.eq(q.field("status"), "POSTED"))
          .first()
      : await ctx.db
          .query("accountingEvents")
          .withIndex("by_org_event_source_version", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("eventType", args.eventType)
              .eq("sourceType", args.sourceType)
              .eq("sourceId", args.sourceId)
              .eq("eventVersion", args.eventVersion!)
          )
          .filter((q) => q.eq(q.field("status"), "POSTED"))
          .first();

  if (originalEvent) {
    const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
    if (period) {
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: originalEvent._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: args.reversalIdempotencyKey,
      });
      return "REVERSED";
    }
    // No open period — defer the reversal to the outbox instead of skipping it.
    await enqueuePendingReversal(ctx, {
      orgId: args.orgId,
      originalEventId: originalEvent._id,
      reversalDate: args.reversalDate,
      reason: args.reason,
      actorId: args.actorId,
      idempotencyKey: args.reversalIdempotencyKey,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
    });
    return "DEFERRED";
  }

  // No posted GL entry. If it's still sitting unposted in the outbox, cancel
  // it so it never posts (net GL effect of the round trip is zero).
  await cancelPendingPostByKey(ctx, args.orgId, args.pendingPostIdempotencyKey);
  return "NOT_POSTED";
}

type ReversalHookArgs<TSourceId> = {
  orgId: Id<"organizations">;
  reason: string;
  actorId: Id<"users">;
  reversalDate: number;
} & TSourceId;

/**
 * All void/cancel hooks share reverseEventIfPosted semantics and differ only
 * in which original event they target and how their idempotency keys are
 * derived from the source id.
 */
export function makeReversalHook<TSourceId extends Record<string, unknown>>(cfg: {
  eventType: EventType;
  sourceType: string;
  sourceId: (args: TSourceId) => string;
  reversalKey: (args: TSourceId) => string;
  pendingPostKey: (args: TSourceId) => string;
}) {
  return async (ctx: MutationCtx, args: ReversalHookArgs<TSourceId>) =>
    reverseEventIfPosted(ctx, {
      orgId: args.orgId,
      sourceType: cfg.sourceType,
      sourceId: cfg.sourceId(args),
      eventType: cfg.eventType,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
      reversalIdempotencyKey: cfg.reversalKey(args),
      pendingPostIdempotencyKey: cfg.pendingPostKey(args),
    });
}
