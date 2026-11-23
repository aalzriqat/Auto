import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertSameCurrency, assertValidMinorAmount } from "./money";
import { assertOrgEconomicallyActive } from "./orgLifecycle";

export async function getReceivableOutstandingMinor(
  ctx: QueryCtx | MutationCtx,
  receivableId: Id<"receivableDocuments">
): Promise<number> {
  const doc = await ctx.db.get(receivableId);
  if (!doc) throw new ConvexError("Receivable not found.");
  return await outstandingFromReceivableDoc(ctx, doc);
}

/**
 * The current outstanding balance of a receivable the caller has ALREADY read, so
 * a caller that needs the document for its own checks does not read it twice.
 * `getReceivableOutstandingMinor` delegates here; the semantics are identical.
 */
export async function outstandingFromReceivableDoc(
  ctx: QueryCtx | MutationCtx,
  doc: Doc<"receivableDocuments">
): Promise<number> {
  const receivableId = doc._id;
  // A cancelled receivable's allocations are reversed (see saleCancellation.ts),
  // which would otherwise make originalAmountMinor - 0 read as fully
  // outstanding again — this is a CURRENT-balance helper (unlike
  // accountingReports.ts's asOf-date reports), so "cancelled" always means
  // zero, with no date reasoning needed. Without this, allocatePaymentToReceivable
  // would let a new payment be applied to a dead receivable, and
  // getReceivableBalance would show a cancelled sale as still owing in full.
  if (doc.status === "CANCELLED") return 0;

  // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
  const receivableAllocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableId))
    .collect();
  return receivableOutstandingFromRows(doc, receivableAllocations);
}

/** Same current-balance authority for readers that already loaded allocations. */
export function receivableOutstandingFromRows(doc: Doc<"receivableDocuments">, allocations: Doc<"paymentAllocations">[]): number {
  if (doc.status === "CANCELLED") return 0;
  const allocated = allocations.filter((a) => a.status === "ACTIVE").reduce((sum, a) => sum + a.amountMinor, 0);
  return Math.max(0, doc.originalAmountMinor - allocated);
}

export async function getPaymentUnappliedMinor(
  ctx: QueryCtx | MutationCtx,
  paymentId: Id<"canonicalPayments">
): Promise<number> {
  const payment = await ctx.db.get(paymentId);
  if (!payment) throw new ConvexError("Payment not found.");

  // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
  const paymentAllocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
    .collect();
  const activeAllocations = paymentAllocations.filter((a) => a.status === "ACTIVE");

  const allocated = activeAllocations.reduce((s, a) => s + a.amountMinor, 0);
  return Math.max(0, payment.amountMinor - allocated);
}

export async function allocatePaymentToReceivable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    paymentId: Id<"canonicalPayments">;
    receivableDocumentId: Id<"receivableDocuments">;
    amountMinor: number;
    actorId: Id<"users">;
  }
): Promise<Id<"paymentAllocations">> {
  await assertOrgEconomicallyActive(ctx, args.orgId);
  const payment = await ctx.db.get(args.paymentId);
  if (!payment || payment.orgId !== args.orgId) throw new ConvexError("Payment not found.");

  const receivable = await ctx.db.get(args.receivableDocumentId);
  if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");

  // Only money actually received and settled can pay down a receivable — an
  // OUT payment (e.g. a deposit refund) or a DRAFT/unsettled one must never be
  // allocatable, or the receivable would show as paid with no funds received.
  if (payment.direction !== "IN") {
    throw new ConvexError("Only inbound payments can be allocated to a receivable.");
  }
  if (payment.status !== "SETTLED") {
    throw new ConvexError("Only settled payments can be allocated to a receivable.");
  }
  // Both sides carry payer identity only when known at creation time — only
  // compare when both are set, so unattributed cash collections (no payer
  // captured yet) can still be allocated by staff judgment; a genuine mismatch
  // between two known identities is always rejected.
  if (payment.payerType && receivable.payerType && payment.payerType !== receivable.payerType) {
    throw new ConvexError("Payment payer type does not match the receivable's payer type.");
  }
  if (payment.customerId && receivable.customerId && payment.customerId !== receivable.customerId) {
    throw new ConvexError("Payment customer does not match the receivable's customer.");
  }
  if (
    payment.financeCompanyId &&
    receivable.financeCompanyId &&
    payment.financeCompanyId !== receivable.financeCompanyId
  ) {
    throw new ConvexError("Payment finance company does not match the receivable's finance company.");
  }

  if (
    payment.payerNameSnapshot &&
    receivable.payerNameSnapshot &&
    payment.payerNameSnapshot !== receivable.payerNameSnapshot
  ) {
    throw new ConvexError("Payment finance company does not match the receivable's finance company.");
  }

  assertSameCurrency(payment.currency, receivable.currency, "payment allocation");
  assertValidMinorAmount(args.amountMinor, "allocation amount");

  if (args.amountMinor <= 0) throw new ConvexError("Allocation amount must be positive.");

  const unapplied = await getPaymentUnappliedMinor(ctx, args.paymentId);
  if (args.amountMinor > unapplied) {
    throw new ConvexError(
      `Allocation amount ${args.amountMinor} exceeds unapplied payment balance ${unapplied}.`
    );
  }

  const outstanding = await getReceivableOutstandingMinor(ctx, args.receivableDocumentId);
  if (args.amountMinor > outstanding) {
    throw new ConvexError(
      `Allocation amount ${args.amountMinor} exceeds receivable outstanding balance ${outstanding}.`
    );
  }

  const now = Date.now();
  const allocationId = await ctx.db.insert("paymentAllocations", {
    orgId: args.orgId,
    paymentId: args.paymentId,
    receivableDocumentId: args.receivableDocumentId,
    amountMinor: args.amountMinor,
    currency: payment.currency,
    scale: payment.scale,
    allocationDate: now,
    status: "ACTIVE",
    createdBy: args.actorId,
    createdAt: now,
  });

  // Update receivable status
  const newOutstanding = outstanding - args.amountMinor;
  await ctx.db.patch(args.receivableDocumentId, {
    status: newOutstanding === 0 ? "PAID" : "PARTIALLY_PAID",
  });

  return allocationId;
}

export async function reverseAllocation(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    allocationId: Id<"paymentAllocations">;
    actorId: Id<"users">;
  }
): Promise<Id<"paymentAllocations">> {
  await assertOrgEconomicallyActive(ctx, args.orgId);
  const allocation = await ctx.db.get(args.allocationId);
  if (!allocation || allocation.orgId !== args.orgId) throw new ConvexError("Allocation not found.");
  if (allocation.status === "REVERSED") throw new ConvexError("Allocation is already reversed.");

  const now = Date.now();
  const reversalId = await ctx.db.insert("paymentAllocations", {
    orgId: args.orgId,
    paymentId: allocation.paymentId,
    receivableDocumentId: allocation.receivableDocumentId,
    amountMinor: allocation.amountMinor,
    currency: allocation.currency,
    scale: allocation.scale,
    allocationDate: now,
    status: "REVERSED",
    reversalOfAllocationId: args.allocationId,
    createdBy: args.actorId,
    createdAt: now,
  });
  await ctx.db.patch(args.allocationId, { status: "REVERSED", reversedByAllocationId: reversalId });

  // Recompute receivable status
  const outstanding = await getReceivableOutstandingMinor(ctx, allocation.receivableDocumentId);
  const receivable = await ctx.db.get(allocation.receivableDocumentId);
  if (receivable) {
    await ctx.db.patch(allocation.receivableDocumentId, {
      status: outstanding >= receivable.originalAmountMinor ? "OPEN" : outstanding > 0 ? "PARTIALLY_PAID" : "PAID",
    });
  }

  return reversalId;
}
