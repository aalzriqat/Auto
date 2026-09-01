import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import {
  hookDepositApplied,
  hookDepositAppliedToSettlement,
  reverseDepositApplication,
  type DepositApplicationIdentity,
} from "../accounting/workflowHooks";

/**
 * The record of deposit money being applied to a sale, and the only thing
 * allowed to reverse it.
 *
 * ## Why the identity is stored rather than derived
 *
 * A reservation deposit is quote-scoped; a quote can carry several cars; each
 * car is sold on its own sale. So one `deposits` row is applied several times,
 * against several invoices, on several dates. Everything downstream — the
 * journal, the reversal, the refundable balance — needs to know WHICH of those
 * movements it is talking about, and nothing in `deposits` or
 * `depositVehicleHolds` alone can say.
 *
 * Reversal is where getting this wrong stops being theoretical. It used to look
 * up the original journal by `(orgId, sourceType: "deposits", sourceId:
 * depositId, eventType)` and take `.first()`. Cancelling the second car's sale
 * therefore reversed the first car's entry — against an invoice that was still
 * live, so the customer's credit vanished from a deal nobody had touched, while
 * the cancelled deal kept its own credit intact. Both books balanced. Both were
 * wrong.
 *
 * A stored identity also survives a change of format. If the derivation ever
 * moves, a reversal that re-derives goes looking for a key that was never
 * written, finds nothing, and returns quietly — `reverseEventIfPosted` reports
 * "nothing posted" exactly the way it reports "already reversed."
 *
 * ## Lifecycle
 *
 *     APPLIED ──▶ REVERSING ──▶ REVERSED
 *
 * REVERSING is durable, not momentary: with no open accounting period the
 * reversal goes to the outbox, and until it actually posts the slice is not
 * money anybody may spend again.
 */

export type DepositApplicationTreatment =
  | "CUSTOMER_RECEIVABLE"
  | "SUPPLIER_SETTLEMENT"
  | "FINANCED_SALE_CONSIDERATION";

/** Statuses that still hold a claim on the deposit — the money is not back. */
const LIVE_APPLICATION_STATUSES = new Set(["APPLIED", "REVERSING"]);

function identityFor(args: {
  depositId: Id<"deposits">;
  vehicleId: Id<"vehicles">;
  sequence: number;
  treatment: DepositApplicationTreatment;
}): DepositApplicationIdentity {
  const settlement = args.treatment === "SUPPLIER_SETTLEMENT";
  const financedConsideration = args.treatment === "FINANCED_SALE_CONSIDERATION";
  return {
    // The financed-consideration identity names an event that is never posted.
    // That is deliberate rather than a gap: the release lives in the financed
    // sale's own journal, so there is nothing here to reverse, and
    // `reverseEventIfPosted` finds nothing and does nothing — while the row
    // itself still reverses, which is what restores the hold.
    eventType: financedConsideration
      ? "FINANCED_SALE_CONSIDERATION"
      : settlement
        ? "DEPOSIT_APPLIED_TO_SETTLEMENT"
        : "DEPOSIT_APPLIED",
    // Its own source type. The tuple (eventType, sourceType, sourceId,
    // eventVersion) is what `postAccountingEvent` dedupes on, and sharing
    // "deposits" would put every car on the quote under one source.
    sourceType: "depositApplications",
    sourceId: `${args.depositId}:${args.vehicleId}`,
    // A car can be sold, cancelled and sold again off the same deposit. Each is
    // a genuine new movement, so each needs its own version — at version 1 the
    // second posting is silently swallowed as a duplicate.
    eventVersion: args.sequence,
    idempotencyKey: `${
      financedConsideration
        ? "deposit_financed_consideration"
        : settlement
          ? "deposit_applied_settlement"
          : "deposit_applied"
    }_${args.depositId}_${args.vehicleId}_${args.sequence}`,
  };
}

async function applicationsForDeposit(
  ctx: QueryCtx | MutationCtx,
  depositId: Id<"deposits">
): Promise<Doc<"depositApplications">[]> {
  return await ctx.db
    .query("depositApplications")
    .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
    .collect();
}

/**
 * How much of this deposit is committed to sales that still stand.
 *
 * Subtracted from anything that would pay the money out again. Refunding a
 * deposit whose slices had already been credited to live invoices paid the
 * customer the same money twice — once off their invoice, once in cash.
 */
export async function liveAppliedMinorForDeposit(
  ctx: QueryCtx | MutationCtx,
  depositId: Id<"deposits">
): Promise<number> {
  const applications = await applicationsForDeposit(ctx, depositId);
  return applications
    .filter((a) => LIVE_APPLICATION_STATUSES.has(a.status))
    .reduce((sum, a) => sum + a.amountMinor, 0);
}

/** Live applications of this deposit, per vehicle — for the allocation screen. */
export async function liveApplicationsForDeposit(
  ctx: QueryCtx | MutationCtx,
  depositId: Id<"deposits">
): Promise<Doc<"depositApplications">[]> {
  const applications = await applicationsForDeposit(ctx, depositId);
  return applications.filter((a) => LIVE_APPLICATION_STATUSES.has(a.status));
}

/**
 * Records one application and posts its journal under the identity recorded.
 *
 * Both happen here so the two can never disagree. A row that says one thing and
 * an event that says another is the failure this module exists to prevent, and
 * it is invisible until a cancellation reverses the wrong car.
 */
export async function recordDepositApplication(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    quoteId?: Id<"quotes">;
    quoteLineIndex?: number;
    vehicleId: Id<"vehicles">;
    saleId: Id<"sales">;
    customerId: Id<"customers">;
    holdId?: Id<"depositVehicleHolds">;
    amountMinor: number;
    currency: string;
    treatment: DepositApplicationTreatment;
    supplierName?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
): Promise<Id<"depositApplications">> {
  const existing = await applicationsForDeposit(ctx, args.depositId);
  const sequence =
    existing.filter((a) => a.vehicleId === args.vehicleId).length + 1;
  const identity = identityFor({
    depositId: args.depositId,
    vehicleId: args.vehicleId,
    sequence,
    treatment: args.treatment,
  });

  const applicationId = await ctx.db.insert("depositApplications", {
    orgId: args.orgId,
    depositId: args.depositId,
    quoteId: args.quoteId,
    quoteLineIndex: args.quoteLineIndex,
    vehicleId: args.vehicleId,
    saleId: args.saleId,
    customerId: args.customerId,
    holdId: args.holdId,
    amountMinor: args.amountMinor,
    currency: args.currency,
    treatment: args.treatment,
    eventType: identity.eventType,
    eventSourceType: identity.sourceType,
    eventSourceId: identity.sourceId,
    eventVersion: identity.eventVersion,
    eventIdempotencyKey: identity.idempotencyKey,
    status: "APPLIED",
    appliedAt: args.occurredAt,
    appliedBy: args.actorId,
  });

  // No journal of its own. The financed sale's entry already debits the deposit
  // liability for exactly this amount, and emitting DEPOSIT_APPLIED beside it
  // would release the same liability twice — and credit AR-Customers, which on
  // this deal is not the debtor. The row above is still written in full, so the
  // deposit, hold, quote, vehicle and sale provenance is preserved and the
  // application reverses like any other.
  if (args.treatment === "FINANCED_SALE_CONSIDERATION") {
    return applicationId;
  }

  if (args.treatment === "SUPPLIER_SETTLEMENT") {
    await hookDepositAppliedToSettlement(ctx, {
      orgId: args.orgId,
      depositId: args.depositId,
      customerId: args.customerId,
      amountMinor: args.amountMinor,
      currency: args.currency,
      supplierName: args.supplierName,
      actorId: args.actorId,
      occurredAt: args.occurredAt,
      saleId: args.saleId,
      identity,
    });
  } else {
    await hookDepositApplied(ctx, {
      orgId: args.orgId,
      depositId: args.depositId,
      customerId: args.customerId,
      amountMinor: args.amountMinor,
      currency: args.currency,
      actorId: args.actorId,
      occurredAt: args.occurredAt,
      saleId: args.saleId,
      allocationVehicleId: args.vehicleId,
      identity,
    });
  }

  return applicationId;
}

/** The identity a row was posted under, read back rather than re-derived. */
function recordedIdentity(row: Doc<"depositApplications">): DepositApplicationIdentity {
  return {
    // ⚠️ EXHAUSTIVE OVER EVERY TREATMENT `identityFor` CAN WRITE.
    //
    // This is the read-back half of the pair, and it used to be a two-way
    // ternary while the write side had three branches — so a row recorded as
    // FINANCED_SALE_CONSIDERATION was read back as DEPOSIT_APPLIED. That is the
    // precise failure this module's own header says the stored identity exists
    // to prevent: a wrong re-derivation "does not fail — it finds no event and
    // returns quietly."
    //
    // Nothing broke in practice, because a financed-consideration row posts no
    // event and the misread lookup found nothing either — the right answer for
    // the wrong reason. It also made the FINANCED_SALE_CONSIDERATION
    // short-circuit in `reverseDepositApplication` unreachable from
    // `reverseDepositApplicationsForSale`, its only production caller, so the
    // guard read as load-bearing while being dead.
    //
    // The narrow case where it does bite: the tuple this builds
    // (orgId, sourceType, sourceId, eventVersion, eventType) is shared across
    // treatments except for eventType, so a DEPOSIT_APPLIED event on the SAME
    // deposit+vehicle at the SAME sequence is a live target for a reversal that
    // belongs to a different application entirely.
    eventType:
      row.eventType === "FINANCED_SALE_CONSIDERATION"
        ? "FINANCED_SALE_CONSIDERATION"
        : row.eventType === "DEPOSIT_APPLIED_TO_SETTLEMENT"
          ? "DEPOSIT_APPLIED_TO_SETTLEMENT"
          : "DEPOSIT_APPLIED",
    sourceType: row.eventSourceType,
    sourceId: row.eventSourceId,
    eventVersion: row.eventVersion,
    idempotencyKey: row.eventIdempotencyKey,
  };
}

export type ReversedApplication = {
  applicationId: Id<"depositApplications">;
  depositId: Id<"deposits">;
  vehicleId: Id<"vehicles">;
  holdId: Id<"depositVehicleHolds"> | undefined;
  amountMinor: number;
  /**
   * False while the reversing journal is only queued, because no accounting
   * period was open. The money is not back yet: the original entry is still
   * POSTED, and anything that pays it out now pays it out twice.
   */
  journalReversed: boolean;
};

/**
 * Backs out every application made by ONE sale, and nothing else.
 *
 * Each row walks APPLIED → REVERSING → REVERSED around its own journal
 * reversal, so a slice whose reversal was deferred to the outbox is left
 * visibly mid-flight rather than quietly counted as money in hand.
 */
export async function reverseDepositApplicationsForSale(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<ReversedApplication[]> {
  const applications = await ctx.db
    .query("depositApplications")
    .withIndex("by_sale", (q) => q.eq("saleId", args.saleId))
    .collect();

  const reversed: ReversedApplication[] = [];
  for (const application of applications) {
    if (application.orgId !== args.orgId) continue;
    if (application.status === "REVERSED") continue;

    await ctx.db.patch(application._id, {
      status: "REVERSING",
      reversalStartedAt: args.reversalDate,
    });

    const outcome = await reverseDepositApplication(ctx, {
      orgId: args.orgId,
      identity: recordedIdentity(application),
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
    });

    // DEFERRED means the reversing entry is queued and the original is still
    // POSTED. The application stays REVERSING until the outbox drains — see
    // completeDeferredReversal — so nothing downstream can treat the amount as
    // recovered while the ledger still shows it spent.
    const journalReversed = outcome !== "DEFERRED";
    await ctx.db.patch(
      application._id,
      journalReversed
        ? {
            status: "REVERSED",
            reversedAt: args.reversalDate,
            reversedBy: args.actorId,
            reversalReason: args.reason,
          }
        : { reversedBy: args.actorId, reversalReason: args.reason }
    );

    reversed.push({
      applicationId: application._id,
      depositId: application.depositId,
      vehicleId: application.vehicleId,
      holdId: application.holdId,
      amountMinor: application.amountMinor,
      journalReversed,
    });
  }
  return reversed;
}

/**
 * Finishes a reversal that had to wait for an accounting period.
 *
 * Called by the outbox when a queued REVERSE entry actually posts. Until then
 * the application sits at REVERSING and its slice is unspendable — which is the
 * whole reason the state exists, and why nothing may transition out of it on a
 * timer or on a read.
 *
 * Keyed on the reversal's idempotency key, which `reverseDepositApplication`
 * derives as `reversed_<the application's own key>`. Frees the slice itself and
 * returns the holds it advanced, for callers that want to report on them.
 */
/**
 * SCRUM-208 — the EXACT source a completed reversal frees, typed.
 *
 * ⚠️ CARRIED FROM THE APPLICATION ROW, NEVER INFERRED FROM HISTORY. The row
 * already records which deposit, which car, which sale and — only for a
 * multi-vehicle quote — which slice. Re-deriving any of that at completion
 * time is the rediscovery this model removes.
 *
 * ⚠️ A DIRECT DEPOSIT HAS NO SLICE, AND NONE MAY BE FABRICATED. `holdId` is
 * absent on a single-vehicle quote because the whole row IS the slice.
 * Inventing a `depositVehicleHolds` row to make the shapes uniform would put a
 * hold on a car whose money never had one.
 */
export type ReversalCompletionSource = {
  readonly kind: "SLICE" | "DIRECT";
  readonly depositId: Id<"deposits">;
  readonly vehicleId: Id<"vehicles">;
  /** The exact sale this application was consumed by. */
  readonly saleId: Id<"sales">;
  /** Present only on the sliced representation. */
  readonly holdId?: Id<"depositVehicleHolds">;
};

/**
 * What a completed reversal WOULD free, and the rows that would be consumed to
 * free it. Read-only.
 *
 * ⚠️ SPLIT FROM THE CONSUMING WRITES ON PURPOSE (SCRUM-208 F1). Resolving and
 * consuming used to be one step, so the caller could not record what authority
 * was owed BEFORE the reversal's idempotency was spent. See
 * `commitDeferredReversal` for why that ordering is load-bearing.
 */
export type ResolvedDeferredReversal = {
  /** Null when there is nothing to complete — no key match, or already done. */
  readonly applicationId: Id<"depositApplications"> | null;
  /** Present only for the sliced representation, and only while REVERSING. */
  readonly holdId: Id<"depositVehicleHolds"> | null;
  readonly sources: ReversalCompletionSource[];
};

const NOTHING_TO_COMPLETE: ResolvedDeferredReversal = {
  applicationId: null,
  holdId: null,
  sources: [],
};

export async function resolveDeferredReversalSources(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; reversalIdempotencyKey: string }
): Promise<ResolvedDeferredReversal> {
  const prefix = "reversed_";
  if (!args.reversalIdempotencyKey.startsWith(prefix)) return NOTHING_TO_COMPLETE;
  const applicationKey = args.reversalIdempotencyKey.slice(prefix.length);

  const application = await ctx.db
    .query("depositApplications")
    .withIndex("by_org_event_key", (q) =>
      q.eq("orgId", args.orgId).eq("eventIdempotencyKey", applicationKey)
    )
    .unique();
  if (!application || application.status !== "REVERSING") return NOTHING_TO_COMPLETE;

  if (application.holdId) {
    const hold = await ctx.db.get(application.holdId);
    if (hold && hold.allocationStatus === "REVERSING") {
      return {
        applicationId: application._id,
        holdId: hold._id,
        sources: [
          {
            kind: "SLICE",
            depositId: application.depositId,
            vehicleId: hold.vehicleId,
            saleId: application.saleId,
            holdId: hold._id,
          },
        ],
      };
    }
    // The application is still completable; its slice simply is not.
    return { applicationId: application._id, holdId: null, sources: [] };
  }

  // DIRECT — the whole row is the slice, and its car is the one the
  // application named. Reported so the outbox can finish what the cancellation
  // deliberately left undone: on a deferred reversal the hold was NOT
  // reinstated, because a live vehicle hold whose reversing journal is still
  // queued is a car held against an entry the ledger still shows posted.
  return {
    applicationId: application._id,
    holdId: null,
    sources: [
      {
        kind: "DIRECT",
        depositId: application.depositId,
        vehicleId: application.vehicleId,
        saleId: application.saleId,
      },
    ],
  };
}

/**
 * Spend the reversal's idempotency. THE LAST STEP, NEVER AN EARLY ONE.
 *
 * ⚠️ THIS IS THE WRITE THAT CANNOT BE UNDONE BY A RETRY (SCRUM-208 F1). Once
 * the application reads REVERSED, `resolveDeferredReversalSources` returns
 * nothing forever after — that is exactly what makes the completion idempotent,
 * and exactly why anything that must happen "because this reversal completed"
 * has to be durably recorded FIRST.
 *
 * In Convex a CAUGHT exception rolls nothing back; only an uncaught one aborts
 * the mutation. `drainEntries` catches per row, by design, so a throw between
 * this patch and the work-item insert used to commit the consumption while the
 * obligation was never written — and the retry then found nothing left to do
 * and settled clean over the loss. Reproduced in
 * `authorityOutcomePersistence.test.ts`.
 */
export async function commitDeferredReversal(
  ctx: MutationCtx,
  resolved: ResolvedDeferredReversal,
  postedAt: number
): Promise<void> {
  if (!resolved.applicationId) return;

  // ⚠️ THE HOLD FIRST, THE APPLICATION LAST — THE SAME PRINCIPLE ONE LEVEL DOWN.
  //
  // The application patch is what gates retryability: once it reads REVERSED,
  // `resolveDeferredReversalSources` returns nothing forever after. So it must
  // be the LAST write, for exactly the reason `recordAuthorityWork` had to move
  // before it one level up.
  //
  // Written application-first, a throw on the hold patch committed the
  // application (a caught exception rolls nothing back) and the retry then
  // resolved to nothing — leaving the slice stranded at REVERSING, a state that
  // never surfaces for the refund/reallocate decision it is waiting on, while
  // the row still reached POSTED cleanly. Raised by Sonnet MAX against
  // 6e2dceb83, and verified pre-existing at the Phase-2 anchor 1bb62ab4c.
  //
  // In this order a throw on the application patch leaves the application
  // REVERSING, so the retry re-resolves, finds the hold already released, and
  // takes the existing "the application is still completable; its slice simply
  // is not" branch — completing correctly. A throw on the hold patch commits
  // nothing at all.
  if (resolved.holdId) {
    await ctx.db.patch(resolved.holdId, { allocationStatus: "RELEASED_AWAITING_DECISION" });
  }
  await ctx.db.patch(resolved.applicationId, {
    status: "REVERSED",
    reversedAt: postedAt,
  });
}

export async function completeDeferredReversal(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; reversalIdempotencyKey: string; postedAt: number }
): Promise<ReversalCompletionSource[]> {
  const resolved = await resolveDeferredReversalSources(ctx, args);
  await commitDeferredReversal(ctx, resolved, args.postedAt);
  return resolved.sources;
}
