import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { allocatePaymentToReceivable } from "../utils/subledgerAllocations";
import { createCanonicalPayment } from "../utils/canonicalPaymentWriter";
import { ensureReceivableDocument } from "../utils/receivableDocumentWriter";
import { toMinorUnits } from "../utils/money";

type CanonicalPaymentMethod = Parameters<typeof createCanonicalPayment>[1]["method"];

type ReceivableDocumentType = Parameters<typeof ensureReceivableDocument>[1]["documentType"];

function receivableDocumentType(sourceType: Doc<"receivables">["sourceType"]): ReceivableDocumentType {
  return sourceType === "INTERNAL_INSTALLMENT" ? "INSTALLMENT" : "INVOICE";
}

function canonicalPaymentMethod(method: Doc<"collectionPayments">["method"]): CanonicalPaymentMethod {
  switch (method) {
    case "CASH":
    case "BANK_TRANSFER":
    case "CHEQUE":
    case "PAYMENT_LINK":
    case "CARD":
    case "OTHER":
      return method;
    case "DEPOSIT_APPLIED":
    case "REFUND":
      return "OTHER";
  }
}

/**
 * ⚠️ This trusts `receivable.canonicalReceivableDocumentId` without checking
 * that the document it names is actually sourced from THIS receivable, and the
 * REFUND and RESCHEDULE approval branches reach it without passing through the
 * cancellation gate's stricter `findCanonicalReceivableForLegacy`.
 *
 * Link writers must store the document resolved from this receivable's own
 * `legacy_receivable/<id>` source key. This helper and the atomic opening
 * allocation materializer both use ensureReceivableDocument for that resolution.
 * Opening correction/refund/reschedule approvals are separately refused before
 * reaching this helper. This is a writer convention, not a schema constraint.
 *
 * Any additional writer or independent REFUND/RESCHEDULE resolution must preserve
 * the source-key check; same-organization ownership alone does not prove the link.
 */
export async function ensureCanonicalReceivableForLegacy(
  ctx: MutationCtx,
  receivable: Doc<"receivables">,
  actorId: Id<"users">,
  currency: string
) {
  if (receivable.canonicalReceivableDocumentId) {
    const existing = await ctx.db.get(receivable.canonicalReceivableDocumentId);
    if (existing && existing.orgId === receivable.orgId) return existing._id;
  }

  const canonicalReceivableDocumentId = await ensureReceivableDocument(ctx, {
    orgId: receivable.orgId,
    branchId: receivable.branchId,
    documentType: receivableDocumentType(receivable.sourceType),
    payerType: "CUSTOMER",
    customerId: receivable.customerId,
    sourceType: "legacy_receivable",
    sourceId: receivable._id,
    originalAmountMinor: toMinorUnits(receivable.originalAmount, currency),
    currency,
    issueDate: receivable.createdAt,
    dueDate: receivable.dueDate,
    actorId,
  });

  await ctx.db.patch(receivable._id, { canonicalReceivableDocumentId });
  return canonicalReceivableDocumentId;
}

/**
 * SCRUM-121A-PRE §5.1 — the canonical allocation gate.
 *
 * Cancelling a receivable while money is still applied to it produces
 * `CANCELLED` + `ACTIVE`: the GL is reversed and zeroed while the subledger
 * still holds the allocation, so the two disagree permanently and no reader can
 * tell which is right. Both cancellation writers must prove the absence of an
 * ACTIVE allocation before they write, and this is the single proof they share
 * — a second implementation would be a second opinion.
 *
 * ## Why the read is bounded and unfiltered
 *
 * `by_receivable` carries no `status`, so a filtered `.first()` bounds what is
 * RETURNED, not what is SCANNED: a document with a long history of REVERSED
 * allocations would walk that whole history and could exhaust the transaction's
 * read allowance, making a legitimate cancellation permanently unavailable.
 *
 * So this reads at most `LIMIT + 1` rows unfiltered and refuses explicitly when
 * more history exists than it can prove over. That refusal is a real operational
 * cost and it is the deliberate choice: the gate never permits a cancellation it
 * could not prove. The durable fix is a compound
 * `by_receivable_and_status` index, which reads only the ACTIVE range — that
 * needs `schema.ts`, which this stage is not authorized to touch, and is
 * required before the accounting backend deploys.
 *
 * ## Why it throws rather than returning a verdict
 *
 * The refusal must be an UNCAUGHT throw. Both callers run inside
 * `runWithIdempotency`, which inserts its `STARTED` row before the callback, and
 * a caught exception in Convex COMMITS everything already written. Only an
 * uncaught one rolls the whole transaction back — including that row — which is
 * what makes the refusal a true zero-delta.
 */
export const ALLOCATION_HISTORY_PROBE_LIMIT = 200;

export async function assertAllocationsInactive(
  ctx: QueryCtx | MutationCtx,
  receivableDocumentId: Id<"receivableDocuments">,
  // SCRUM-693 PR-B F2: the unwind status preview runs this BEFORE the closing step reverses its own
  // allocations. `reversing` names those: they are not counted as active, and each will add one
  // reversal row to the history the real probe then sees. Empty for every writing caller.
  reversing: ReadonlyArray<Id<"paymentAllocations">> = []
) {
  const history = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableDocumentId))
    .take(ALLOCATION_HISTORY_PROBE_LIMIT + 1);

  if (history.length + reversing.length > ALLOCATION_HISTORY_PROBE_LIMIT) {
    // The advice is deliberately state-agnostic. The likeliest way to reach
    // this bound is a long, entirely REVERSED correction history — in which case
    // "reverse the remaining allocations" names an action the operator cannot
    // take, because there is nothing left to reverse.
    throw new ConvexError(
      "This debt has too long an allocation history to verify in one step, so it cannot be cancelled safely from here. " +
      "It needs a manual reconciliation before it can be closed."
    );
  }
  if (history.some((allocation) => allocation.status === "ACTIVE" && !reversing.includes(allocation._id))) {
    throw new ConvexError(
      "This debt still has payments applied to it and cannot be cancelled. Reverse the allocations first."
    );
  }
}

/**
 * Resolve the canonical document for a legacy receivable WITHOUT creating one.
 *
 * `ensureCanonicalReceivableForLegacy` writes, so the gate cannot use it. The
 * source key is checked as well as the stored link: a document that exists but
 * whose back-link is missing would otherwise let the gate read nothing and
 * conclude "no allocations" about a document it never looked at.
 */
export async function findCanonicalReceivableForLegacy(
  ctx: MutationCtx,
  receivable: Doc<"receivables">
) {
  if (receivable.canonicalReceivableDocumentId) {
    const linked = await ctx.db.get(receivable.canonicalReceivableDocumentId);
    if (linked && linked.orgId === receivable.orgId) {
      // FAIL CLOSED on a link that does not identify THIS receivable.
      //
      // Neither this resolver nor `ensureCanonicalReceivableForLegacy` checks
      // the source key, so a stale link would send BOTH the gate and the
      // cancellation to the same wrong document — they would agree with each
      // other while the receivable's real document stayed open with live
      // allocations against it.
      //
      // Validating the link and silently falling through to the source key
      // would be worse than either: the gate would then prove the absence of
      // allocations on document A while the cancellation patched document B.
      // A gate that proves something about a different row than the one being
      // written is not a gate. So this refuses instead.
      //
      // No production writer can create this state — `receivables`'
      // `canonicalReceivableDocumentId` has exactly one writer, the patch in
      // `ensureCanonicalReceivableForLegacy`, which always stores the document
      // it resolved from this receivable's own source key. This is a forward
      // guard, exercised by a constructed fixture.
      if (linked.sourceType !== "legacy_receivable" || linked.sourceId !== receivable._id) {
        throw new ConvexError(
          "This receivable's accounting document cannot be identified, so it cannot be cancelled safely."
        );
      }
      return linked;
    }
  }
  return await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", receivable.orgId).eq("sourceType", "legacy_receivable").eq("sourceId", receivable._id)
    )
    .unique();
}

export async function mirrorCollectionPaymentToCanonical(
  ctx: MutationCtx,
  args: {
    paymentId: Id<"collectionPayments">;
    payment: Doc<"collectionPayments">;
    receivable?: Doc<"receivables"> | null;
    actorId: Id<"users">;
    currency: string;
  }
): Promise<{
  canonicalPaymentId: Id<"canonicalPayments">;
  /** Absent exactly when this receipt discharged no receivable (SCRUM-218-C). */
  paymentAllocationId?: Id<"paymentAllocations">;
}> {
  const amountMinor = toMinorUnits(args.payment.amount, args.currency);
  const canonicalPaymentId = await createCanonicalPayment(ctx, {
    orgId: args.payment.orgId,
    branchId: args.payment.branchId,
    direction: args.payment.direction,
    payerType: "CUSTOMER",
    customerId: args.payment.customerId,
    method: canonicalPaymentMethod(args.payment.method),
    amountMinor,
    currency: args.currency,
    idempotencyKey: `collection_payment_${args.paymentId}`,
    actorId: args.actorId,
    status: "SETTLED",
    externalReference: args.payment.reference,
    receivedAt: args.payment.paymentDate,
  });

  const patch: Partial<Pick<Doc<"collectionPayments">, "canonicalPaymentId" | "paymentAllocationId">> = {
    canonicalPaymentId,
  };

  if (args.receivable && args.payment.direction === "IN") {
    const canonicalReceivableDocumentId = await ensureCanonicalReceivableForLegacy(
      ctx,
      args.receivable,
      args.actorId,
      args.currency
    );
    patch.paymentAllocationId = await allocatePaymentToReceivable(ctx, {
      orgId: args.payment.orgId,
      paymentId: canonicalPaymentId,
      receivableDocumentId: canonicalReceivableDocumentId,
      amountMinor,
      actorId: args.actorId,
    });
  }

  await ctx.db.patch(args.paymentId, patch);
  // Returned as an exact, non-optional canonical id plus the allocation this
  // call actually created. SCRUM-218-C seals that allocation id as the receipt
  // movement's lineage; recovering it later by set-difference is impossible,
  // because every write in one Convex transaction can share a `_creationTime`.
  return { canonicalPaymentId, paymentAllocationId: patch.paymentAllocationId };
}

export async function insertLedgerTransaction(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    direction: "IN" | "OUT";
    amount: number;
    date: number;
    description: string;
    vehicleId?: Id<"vehicles">;
    userId?: Id<"users">;
    category: "COLLECTION_PAYMENT" | "REFUND";
    idempotencyKey?: string;
  }
) {
  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: args.direction,
    amount: args.amount,
    date: args.date,
    category: args.category,
    description: args.description,
    vehicleId: args.vehicleId,
    userId: args.userId,
    idempotencyKey: args.idempotencyKey,
  });
}
