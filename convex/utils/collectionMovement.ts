import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

/**
 * SCRUM-56 — the applied-movement authority for Collections.
 *
 * Contract approved by Lane 5 (AF-30) on SCRUM-56 c12405/c12410, axis corrected
 * in c12440.
 *
 * ⚠️ THE AXIS IS "every path that MOVES Collections money" — NOT "every path
 * that writes both a canonical allocation and a legacy mirror." An earlier
 * revision of this docblock said the latter, and that sentence was false in a
 * way that cost a round: it silently excused every path writing only ONE side.
 * A payment intent that allocates and skips the mirror, and an application
 * cheque that creates a canonical receipt with no mirror at all, were both
 * outside the enumeration and both diverged. Writing one side is not an
 * exemption from this contract — it is the divergence the contract exists to
 * prevent. See the route inventory below.
 *
 * The defects in this subsystem have all been one movement described by two
 * numbers that nothing forced to agree:
 *
 *   - the payment-link path clamped the allocation against the sale invoice and
 *     then clamped the legacy mirror against the row's own stored balance, so a
 *     real allocation carried a $0 audit record and a sibling row was stranded;
 *   - `returnClearedCheque` reopened the cheque's frozen face value, so a row
 *     already reopened by a partial refund reopened again and claimed more than
 *     the row was ever for.
 *
 * The rules this module exists to make unavoidable:
 *
 *   R1  one computed `appliedMinor` drives the canonical allocation AND the
 *       legacy mirror; neither recomputes it
 *   R2  clamp ONCE against the canonical debt, then distribute — never clamp
 *       again against `receivables.outstandingAmount`. Each clamp is defensible
 *       alone, which is exactly why this is a shared helper and not a review note
 *   R3  anything that reopens or unwinds uses the LIVE figure, never an amount
 *       frozen earlier
 *   R4  `canonicalPaymentId` is the immutable anchor; `paymentAllocationId` is a
 *       moving pointer and is never identity
 *   R7  nothing applied means nothing recorded
 *
 * Deliberately reads only records that already exist. `subledger.ts` and the
 * schema are out of scope and were proven unnecessary: `paymentAllocations`
 * already indexes `by_payment`, which is the whole of R4's requirement.
 *
 * ROUTE INVENTORY — every Collections money-moving path, and whether it
 * consumes this authority. Inventoried on the corrected axis; keep it current,
 * because the last enumeration's omissions were the entire failure.
 *
 *   MONEY IN
 *   collections.recordPayment          YES — normalizes once here, one value
 *                                      drives cap, row, mirror and ledger
 *   collections.clearCheque            YES — same bound, same target resolution
 *   paymentIntents settlement          YES — one plan drives allocation and
 *                                      mirror; resolves the sale invoice via
 *                                      the legacy row OR intent.saleId
 *
 *   MONEY OUT / REVERSAL
 *   respondToApproval REFUND           YES — reverses only allocations reached
 *                                      through this row's canonical payments
 *   returnClearedCheque                YES — selects via the anchor, reopens the
 *                                      still-active amount, FAILS CLOSED when
 *                                      the cleared payment cannot be traced
 *   CANCEL_RECEIVABLE                  N/A monetary — retires only the row's own
 *                                      verified twin; blocked once paid
 *   utils/saleCancellation             N/A by refusal — refuses while customer
 *                                      money is applied, so it never unwinds
 *                                      allocations behind this authority's back
 *
 *   ADJACENT, DELIBERATELY NOT ROUTED THROUGH HERE
 *   applications confirmDisbursement   finance-company disbursement; payerType
 *                                      FINANCE_COMPANY, creates a canonical
 *                                      receipt and NO Collections mirror. It is
 *                                      not customer collection money. It is
 *                                      listed because its cheque is returnable
 *                                      through returnClearedCheque, which now
 *                                      refuses rather than half-unwinding it.
 *   utils/saleCompletion               raises the invoice; moves no collection
 *                                      money
 *   deposits                           applied at completion, not collected here
 */

/** What one movement actually did, computed once and consumed by every writer. */
export type ApplicationPlan = {
  /** What the operator or workflow asked to move. */
  requestedMinor: number;
  /** What may actually be applied to the canonical debt. */
  appliedMinor: number;
  /** requested − applied. Stays unapplied on the canonical payment. */
  unappliedMinor: number;
};

/**
 * R1 + R2 — the single clamp.
 *
 * The canonical debt is the only ceiling. Callers distribute `appliedMinor` to
 * the allocation, the legacy mirror and the row balance; none of them may clamp
 * a second time against a different number.
 */
export function planApplication(requestedMinor: number, canonicalOutstandingMinor: number): ApplicationPlan {
  const ceiling = Math.max(0, canonicalOutstandingMinor);
  const appliedMinor = Math.max(0, Math.min(requestedMinor, ceiling));
  return { requestedMinor, appliedMinor, unappliedMinor: requestedMinor - appliedMinor };
}

/**
 * The sale invoice a hand-keyed legacy row stands for, or null when the row is
 * money in its own right.
 *
 * Read-only and creates nothing, so any path may ask. Lives here rather than in
 * `collections.ts` so `paymentIntents.ts` can reach it without importing the
 * whole Collections module.
 */
export async function saleInvoiceForLegacyRow(
  ctx: QueryCtx | MutationCtx,
  receivable: Doc<"receivables">
): Promise<Id<"receivableDocuments"> | null> {
  if (!receivable.saleId) return null;
  const sale = await ctx.db.get(receivable.saleId);
  if (sale && sale.orgId === receivable.orgId && sale.canonicalReceivableDocumentId) {
    return sale.canonicalReceivableDocumentId;
  }
  return null;
}

/**
 * R3 + R4 — the allocations of one canonical payment that are STILL ACTIVE on
 * one canonical document, reached through the immutable anchor.
 *
 * This is the only sanctioned way to ask "what of this payment is still applied".
 * Following `collectionPayments.paymentAllocationId` instead answers a different
 * question: a partial refund reverses an allocation and re-allocates the
 * remainder under a NEW id, so the pointer names a REVERSED row until something
 * rewrites it — and a pointer that was never set, or was set to another
 * document's allocation, cannot be distinguished from a correct one.
 */
export async function activeAllocationsForPayment(
  ctx: QueryCtx | MutationCtx,
  args: {
    canonicalPaymentId: Id<"canonicalPayments">;
    targetDocumentId: Id<"receivableDocuments">;
  }
): Promise<Doc<"paymentAllocations">[]> {
  const allocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_payment", (q) => q.eq("paymentId", args.canonicalPaymentId))
    .collect();
  return allocations.filter(
    (allocation) =>
      allocation.status === "ACTIVE" && allocation.receivableDocumentId === args.targetDocumentId
  );
}

/** R3 — the live applied figure for one payment against one document. */
export async function activeAppliedMinorForPayment(
  ctx: QueryCtx | MutationCtx,
  args: {
    canonicalPaymentId: Id<"canonicalPayments">;
    targetDocumentId: Id<"receivableDocuments">;
  }
): Promise<number> {
  const allocations = await activeAllocationsForPayment(ctx, args);
  return allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
}
