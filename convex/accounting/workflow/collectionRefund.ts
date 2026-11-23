import { type Id } from "../../_generated/dataModel";
import { type MutationCtx } from "../../_generated/server";
import { assertLegacyCollectionRefundAllowed } from "../../utils/legacyCollectionRefundContainment";
import { postDomainEvent } from "./posting";

type CollectionHookArgs = {
  orgId: Id<"organizations">;
  paymentId: Id<"collectionPayments">;
  customerId: Id<"customers">;
  amountMinor: number;
  currency: string;
  paymentMethod: string;
  bankAccountId?: Id<"bankAccounts">;
  actorId: Id<"users">;
  occurredAt: number;
};

/**
 * Forward-posting factory for the collection event families.
 *
 * ⚠️ `COLLECTION_PAYMENT` IS DELIBERATELY ABSENT FROM THIS UNION, AND ITS
 * ABSENCE IS THE MECHANISM (SCRUM-236; owner-proxy c17538 mechanism B, c17641
 * requirement 5). The receipt occurrence
 * `COLLECTION_PAYMENT / collectionPayments / <collectionPaymentId>` now has
 * exactly ONE forward producer — `postReceiptOccurrence`, called from
 * `recordPayment` and `clearCheque` in `collections.ts` — and this factory must
 * not be able to mint a second one addressing the same identity.
 *
 * Deleting the `hookCollectionPayment` INSTANCE alone would have left
 * `makeCollectionHook("COLLECTION_PAYMENT", "collection_payment")` compiling, so
 * the retirement would have been a convention rather than a boundary — and a
 * safety property stated in prose is not enforced. Narrowing the parameter makes
 * reintroducing that writer a COMPILE ERROR. That is the entire reason the
 * parameter survives with a single member: the parameter IS the constraint.
 *
 * The shared body is otherwise untouched and `COLLECTION_REFUND` keeps posting
 * exactly as before. A refund is a real economic movement against a different
 * occurrence identity (`COLLECTION_REFUND / collectionPayments / <id>`), which
 * is why the retirement happens in this signature and not inside the body —
 * owner-proxy c17538 rejected the latter as Option C precisely because it was
 * the one mechanism that would have silently disabled refunds.
 */
function makeCollectionHook(eventType: "COLLECTION_REFUND", keyPrefix: string) {
  return async (ctx: MutationCtx, args: CollectionHookArgs) => {
    // SCRUM-760 ruling 11: no NEW collection refund posting or enqueue. The one caller,
    // `collections.respondToApproval`, is already refused; this keeps a future caller from
    // starting one. It runs in the same transaction as the payout, so no payout can exist whose
    // hook this refuses. Rows already queued are untouched: the outbox worker does not call here.
    assertLegacyCollectionRefundAllowed();
    return postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: "collectionPayments",
      sourceId: args.paymentId.toString(),
      idempotencyKey: `${keyPrefix}_${args.paymentId}`,
      currency: args.currency,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      payload: {
        paymentId: args.paymentId.toString(),
        amountMinor: args.amountMinor,
        currency: args.currency,
        customerId: args.customerId.toString(),
        paymentMethod: args.paymentMethod,
        ...(args.bankAccountId ? { bankAccountId: args.bankAccountId.toString() } : {}),
      },
    });
  };
}

/*
 * `hookCollectionPayment` USED TO BE INSTANTIATED HERE AND IS RETIRED, NOT
 * MISSING (SCRUM-236).
 *
 * It was `makeCollectionHook("COLLECTION_PAYMENT", "collection_payment")`, and
 * `recordPayment` / `clearCheque` called it synchronously to post the legacy
 * gross receipt journal. Both now go through `postReceiptOccurrence` above,
 * which derives the whole occurrence — event type, source type, source id,
 * occurrence version and idempotency key — from ONE `directCollectionReceipt`
 * identity instead of assembling them independently at each call site.
 *
 * The stored key bytes did not change: `occurrenceIdempotencyKey` returns
 * `collection_payment_<paymentId>` for occurrence 1, exactly what this hook
 * wrote, so already-POSTED production rows still match their own replay check
 * and the `cancelPendingPostByKey` call in `returnCheque` still finds the entry
 * it is meant to cancel.
 *
 * Do not reintroduce this line. It no longer compiles — see the factory above.
 */

/**
 * Posts the cash-out + AR-reopening entry for an approved collection refund:
 * DR Accounts Receivable — Customers / CR Cash. The refund's operational side
 * (OUT collectionPayment + canonical payment + allocation reversal) is handled
 * by the caller; this hook only records the GL impact.
 */
export const hookCollectionRefund = makeCollectionHook("COLLECTION_REFUND", "collection_refund");
