import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { postDomainEvent } from "./posting";
import { type ReversalOutcome, reverseEventIfPosted, makeReversalHook } from "./reversal";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureConsignmentAccounts } from "../chartAccountsProvision";

export async function hookDepositReceived(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    paymentMethod: string;
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_RECEIVED",
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    idempotencyKey: `deposit_received_${args.depositId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      bankAccountId: args.bankAccountId,
      customerId: args.customerId.toString(),
    },
  });
}

/**
 * The exact accounting coordinates of one application of deposit money.
 *
 * Passed in rather than derived, and stored on the `depositApplications` row
 * that owns it, so the reversal reads back precisely what was posted. A
 * reversal that re-derives its target and gets it wrong does not fail — it
 * finds no event and returns quietly, leaving the subledger reinstated and the
 * ledger still showing the liability discharged.
 */
export type DepositApplicationIdentity = {
  // FINANCED_SALE_CONSIDERATION names an event that is never posted: the release
  // is a line inside the financed sale journal, so there is nothing separate to
  // reverse. The identity is still recorded in full so the application row is
  // indistinguishable in shape from the two that do post.
  eventType:
    | "DEPOSIT_APPLIED"
    | "DEPOSIT_APPLIED_TO_SETTLEMENT"
    | "FINANCED_SALE_CONSIDERATION";
  sourceType: string;
  sourceId: string;
  eventVersion: number;
  idempotencyKey: string;
};

export async function hookDepositApplied(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
    saleId?: Id<"sales">;
    /** Which car on a multi-vehicle quote consumed its share. */
    allocationVehicleId?: Id<"vehicles">;
    /**
     * The identity this application was recorded under.
     *
     * One deposit row can be applied several times — once per car it was
     * allocated across — and each is its own movement of money against its own
     * sale. Sharing an identity makes the second application collide with the
     * first on both the key and the (eventType, sourceType, sourceId,
     * eventVersion) tuple and silently post nothing, and makes every reversal
     * ambiguous. Omitted only by callers that predate the application record.
     */
    identity?: DepositApplicationIdentity;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_APPLIED",
    sourceType: args.identity?.sourceType ?? "deposits",
    sourceId: args.identity?.sourceId ?? args.depositId.toString(),
    idempotencyKey: args.identity?.idempotencyKey ?? `deposit_applied_${args.depositId}`,
    eventVersion: args.identity?.eventVersion ?? 1,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      saleId: args.saleId?.toString(),
      allocationVehicleId: args.allocationVehicleId?.toString(),
    },
  });
}

/**
 * Backs out ONE recorded application, using the identity it was posted under.
 *
 * Deliberately takes no depositId: reversing "the deposit" is what let a
 * cancellation on one car unwind another car's live credit.
 */
export async function reverseDepositApplication(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    identity: DepositApplicationIdentity;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<ReversalOutcome> {
  // A financed-consideration application never posted an entry of its own — the
  // deposit liability was released by a line inside the financed sale journal, and
  // reversing THAT sale restores it. There is nothing here to undo, and saying so
  // is different from failing to find it: the caller still marks the application
  // row REVERSED, which is what puts the hold back.
  // ⚠️ NOT_POSTED here is a statement about THIS row, never about the parent.
  //
  // A neighbouring comment used to say reversing the sale restores the deposit.
  // It does not, by itself: nothing consumes the parent reversal's completion
  // for this row shape — `resolveDeferredReversalSources` accepts only a
  // `reversed_<applicationKey>` key, and the parent is queued under
  // `sale_cancelled_<saleId>`. Callers that treat this outcome as proof the
  // parent journal is off the books are wrong, which is why
  // `assertFinancedDepositsSurviveParentReversal` refuses a cancellation whose
  // parent reversal defers.
  if (args.identity.eventType === "FINANCED_SALE_CONSIDERATION") {
    return "NOT_POSTED";
  }

  return await reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: args.identity.sourceType,
    sourceId: args.identity.sourceId,
    eventType: args.identity.eventType,
    eventVersion: args.identity.eventVersion,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `reversed_${args.identity.idempotencyKey}`,
    pendingPostIdempotencyKey: args.identity.idempotencyKey,
  });
}

/**
 * The deposit is retained by the dealership against the margin the supplier
 * owes it — only ever reachable on the DIRECT_TO_SUPPLIER route. See
 * ruleDepositAppliedToSettlement for why this credits the supplier receivable
 * rather than recognizing commission revenue a second time.
 */
export async function hookDepositAppliedToSettlement(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    supplierName?: string;
    actorId: Id<"users">;
    occurredAt: number;
    saleId?: Id<"sales">;
    /** See hookDepositApplied — one row, one identity per application. */
    identity?: DepositApplicationIdentity;
  }
) {
  // Every existing org's chart predates agent accounting, and this rule needs
  // RECEIVABLE_FROM_SUPPLIERS. Deposits are resolved BEFORE hookSaleCompleted
  // runs, so its self-heal comes too late: the first settlement-treated
  // consigned sale in any live org would roll the whole completion back with
  // "System account RECEIVABLE_FROM_SUPPLIERS is not mapped". No fixture can
  // catch it — they all call chartOfAccounts.initialize, which seeds it.
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureConsignmentAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_APPLIED_TO_SETTLEMENT",
    sourceType: args.identity?.sourceType ?? "deposits",
    sourceId: args.identity?.sourceId ?? args.depositId.toString(),
    // Distinct from `deposit_applied_*`: a deposit resolves exactly once, but
    // the two treatments credit different accounts, so sharing a key would let
    // whichever posted first silently suppress the other.
    idempotencyKey:
      args.identity?.idempotencyKey ?? `deposit_applied_settlement_${args.depositId}`,
    eventVersion: args.identity?.eventVersion ?? 1,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      supplierName: args.supplierName,
      saleId: args.saleId?.toString(),
    },
  });
}

type DepositResolutionHookArgs = {
  orgId: Id<"organizations">;
  depositId: Id<"deposits">;
  customerId: Id<"customers">;
  amountMinor: number;
  currency: string;
  actorId: Id<"users">;
  occurredAt: number;
  /** Only meaningful for DEPOSIT_REFUNDED — forfeiture never moves cash. */
  paymentMethod?: string;
  bankAccountId?: Id<"bankAccounts">;
  /**
   * Scopes the entry to ONE vehicle's slice of a shared quote deposit.
   *
   * Refunding part of a multi-vehicle deposit is a different movement from
   * resolving the whole row, and the two must not share an identity: keyed on
   * the deposit alone, the first partial refund would make every later one —
   * and the eventual release of the remainder — return "already posted" and
   * move no money at all.
   */
  sliceHoldId?: Id<"depositVehicleHolds">;
  /**
   * Which release of this row it is. Defaults to 1.
   *
   * A quote-scoped deposit can be released more than once — the free part now,
   * the rest when the cars it was held against fall away. Keyed on the row
   * alone, every release after the first returned "already posted" and moved
   * cash with no journal behind it.
   */
  releaseSeq?: number;
};

/** Refund and forfeiture post identical event shapes — only the event type (and thus the posting rule) differs. */
function makeDepositResolutionHook(eventType: "DEPOSIT_REFUNDED" | "DEPOSIT_FORFEITED", keyPrefix: string) {
  return async (ctx: MutationCtx, args: DepositResolutionHookArgs) =>
    postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: args.sliceHoldId ? "depositVehicleHolds" : "deposits",
      sourceId: (args.sliceHoldId ?? args.depositId).toString(),
      // The first release of a row keeps the original key, so nothing already
      // posted in production changes identity.
      idempotencyKey: args.sliceHoldId
        ? `${keyPrefix}_slice_${args.sliceHoldId}`
        : `${keyPrefix}_${args.depositId}${
            args.releaseSeq && args.releaseSeq > 1 ? `_${args.releaseSeq}` : ""
          }`,
      eventVersion: args.sliceHoldId ? 1 : (args.releaseSeq ?? 1),
      currency: args.currency,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      payload: {
        depositId: args.depositId.toString(),
        amountMinor: args.amountMinor,
        currency: args.currency,
        customerId: args.customerId.toString(),
        paymentMethod: args.paymentMethod,
        bankAccountId: args.bankAccountId?.toString(),
        holdId: args.sliceHoldId?.toString(),
      },
    });
}

export const hookDepositRefunded = makeDepositResolutionHook("DEPOSIT_REFUNDED", "deposit_refunded");

export const hookDepositForfeited = makeDepositResolutionHook("DEPOSIT_FORFEITED", "deposit_forfeited");

/** Reverses a DEPOSIT_APPLIED entry when an applied deposit is reinstated as an active hold (e.g. the sale it was applied to gets voided). */
export const hookDepositApplicationReversed = makeReversalHook<{ depositId: Id<"deposits"> }>({
  eventType: "DEPOSIT_APPLIED",
  sourceType: "deposits",
  sourceId: (a) => a.depositId.toString(),
  reversalKey: (a) => `deposit_applied_reversed_${a.depositId}`,
  pendingPostKey: (a) => `deposit_applied_${a.depositId}`,
});

/**
 * Reverses a DEPOSIT_APPLIED_TO_SETTLEMENT entry. The settlement treatment
 * credits a different account from the ordinary application, so reversing it
 * with `hookDepositApplicationReversed` reverses nothing at all: that hook
 * looks for `DEPOSIT_APPLIED`, finds no such event, and silently no-ops —
 * leaving the deposit reinstated as HELD while the GL still shows its
 * liability extinguished against the supplier receivable.
 */
export const hookDepositSettlementApplicationReversed = makeReversalHook<{ depositId: Id<"deposits"> }>({
  eventType: "DEPOSIT_APPLIED_TO_SETTLEMENT",
  sourceType: "deposits",
  sourceId: (a) => a.depositId.toString(),
  reversalKey: (a) => `deposit_applied_settlement_reversed_${a.depositId}`,
  pendingPostKey: (a) => `deposit_applied_settlement_${a.depositId}`,
});

/**
 * Reverses the DEPOSIT_RECEIVED entry when a HELD deposit is voided as
 * recorded-in-error (as opposed to refunded/forfeited, which post their own
 * dedicated resolution entries). If the original entry never posted (still in
 * the outbox), it is cancelled so the round trip nets to zero.
 */
export const hookDepositVoided = makeReversalHook<{ depositId: Id<"deposits"> }>({
  eventType: "DEPOSIT_RECEIVED",
  sourceType: "deposits",
  sourceId: (a) => a.depositId.toString(),
  reversalKey: (a) => `deposit_voided_${a.depositId}`,
  pendingPostKey: (a) => `deposit_received_${a.depositId}`,
});
