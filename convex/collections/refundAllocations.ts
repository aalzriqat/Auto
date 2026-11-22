import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { allocatePaymentToReceivable, reverseAllocation } from "../utils/subledgerAllocations";
import { assertReceivableNotSaleLinked } from "../utils/saleDebtContainment";
import { ALLOCATION_HISTORY_PROBE_LIMIT, findCanonicalReceivableForLegacy } from "./canonicalReceivables";
import { ConvexError } from "convex/values";

/**
 * SCRUM-571 S1 (D-20) R5: read-only pre-check for the refund approval. When the
 * refund would split an allocation, `reverseAllocationsForRefund` re-allocates
 * the un-refunded remainder to the document - for a sale-linked legacy
 * receivable that is a fresh allocation against a competing debt. Refuse BEFORE
 * the refund payment row, the mirror or any reversal is written. It mirrors the
 * walk below exactly (newest first, break once covered) and writes nothing.
 */
export async function assertRefundDoesNotReallocateToSaleLinkedDoc(
  ctx: MutationCtx,
  receivable: Doc<"receivables">,
  amountMinor: number
) {
  if (!receivable.saleId) return;
  const canonical = await findCanonicalReceivableForLegacy(ctx, receivable);
  if (!canonical) return;
  // Bounded read. A document with more allocations than the limit cannot be
  // walked completely, and an incomplete walk cannot prove the refund will not
  // split an allocation, so it fails CLOSED: this receivable is sale-linked
  // (checked above), hence the refusal.
  const allocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", canonical._id))
    .take(ALLOCATION_HISTORY_PROBE_LIMIT + 1);
  if (allocations.length > ALLOCATION_HISTORY_PROBE_LIMIT) assertReceivableNotSaleLinked(receivable);
  const active = allocations
    .filter((allocation) => allocation.status === "ACTIVE")
    .sort((a, b) => b.createdAt - a.createdAt);
  let remainingMinor = amountMinor;
  for (const allocation of active) {
    if (remainingMinor <= 0) break;
    if (allocation.amountMinor > remainingMinor) assertReceivableNotSaleLinked(receivable);
    remainingMinor -= allocation.amountMinor;
  }
}

/**
 * Unwinds ACTIVE allocations on a canonical receivable to cover a refund,
 * newest first. If the refund splits an allocation, the un-refunded remainder
 * is re-allocated from the same payment so the net reversed amount equals the
 * refund exactly. This is what reopens the canonical receivable's outstanding
 * balance to match the legacy receivable after a refund.
 */
export async function reverseAllocationsForRefund(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableDocumentId: Id<"receivableDocuments">;
    amountMinor: number;
    actorId: Id<"users">;
  }
) {
  // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
  const activeAllocations = (
    await ctx.db
      .query("paymentAllocations")
      .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", args.receivableDocumentId))
      .collect()
  )
    .filter((allocation) => allocation.status === "ACTIVE")
    .sort((a, b) => b.createdAt - a.createdAt);

  let remainingMinor = args.amountMinor;
  let coveredMinor = 0;
  for (const allocation of activeAllocations) {
    if (remainingMinor <= 0) break;
    const reversedMinor = Math.min(allocation.amountMinor, remainingMinor);
    await reverseAllocation(ctx, {
      orgId: args.orgId,
      allocationId: allocation._id,
      actorId: args.actorId,
    });
    if (allocation.amountMinor > remainingMinor) {
      await allocatePaymentToReceivable(ctx, {
        orgId: args.orgId,
        paymentId: allocation.paymentId,
        receivableDocumentId: args.receivableDocumentId,
        amountMinor: allocation.amountMinor - remainingMinor,
        actorId: args.actorId,
      });
      remainingMinor = 0;
    } else {
      remainingMinor -= allocation.amountMinor;
    }
    coveredMinor += reversedMinor;
  }

  if (remainingMinor > 0) {
    throw new ConvexError(
      `Canonical allocations cover only ${coveredMinor} of the requested refund ${args.amountMinor}.`
    );
  }
}
