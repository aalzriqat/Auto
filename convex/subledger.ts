import { createCanonicalPayment } from "./utils/canonicalPaymentWriter";
import { v, ConvexError } from "convex/values";
import { query, type MutationCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import type { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { assertSourceIsNotSaleDebt } from "./utils/saleDebtContainment";
import { assertLegacyCollectionRefundAllowed } from "./utils/legacyCollectionRefundContainment";
import {
  allocatePaymentToReceivable,
  getPaymentUnappliedMinor,
  getReceivableOutstandingMinor,
  reverseAllocation,
} from "./utils/subledgerAllocations";
import { createReceivableDocument } from "./utils/receivableDocumentWriter";

export {
  allocatePaymentToReceivable,
  getReceivableOutstandingMinor,
  outstandingFromReceivableDoc,
  receivableOutstandingFromRows,
  reverseAllocation,
} from "./utils/subledgerAllocations";
export { createReceivableDocument, ensureReceivableDocument } from "./utils/receivableDocumentWriter";

export { createCanonicalPayment } from "./utils/canonicalPaymentWriter";

/**
 * Marks a canonical payment VOIDED (recorded in error — no money actually
 * moved, unlike a refund which pays money back out). Refuses to void a payment
 * that still has ACTIVE allocations; callers must reverse those first so
 * receivable balances stay consistent.
 */
/**
 * ⚠️ SCRUM-302, deliberately NOT lifecycle-gated — recorded as a decision so it
 * is not read later as an omission. This inserts nothing: it patches one
 * payment to VOIDED and refuses outright if any allocation is still active. It
 * therefore creates no new economic footprint, and it is a corrective action.
 * Refusing it for a blocked organization would remove a way to WITHDRAW effect
 * without preventing any effect from being created. `reverseAllocation` below
 * is the opposite case and IS gated: it inserts a new `paymentAllocations` row.
 */
export async function voidCanonicalPayment(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    paymentId: Id<"canonicalPayments">;
    actorId: Id<"users">;
  }
): Promise<void> {
  const payment = await ctx.db.get(args.paymentId);
  if (!payment || payment.orgId !== args.orgId) throw new ConvexError("Payment not found.");
  if (payment.status === "VOIDED") return;

  // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
  const paymentAllocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_payment", (q) => q.eq("paymentId", args.paymentId))
    .collect();
  const activeAllocations = paymentAllocations.filter((a) => a.status === "ACTIVE");
  if (activeAllocations.length > 0) {
    throw new ConvexError("Cannot void a payment with active allocations — reverse them first.");
  }

  await ctx.db.patch(args.paymentId, { status: "VOIDED" });
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const listReceivables = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.optional(v.id("customers")),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    await requireFeature(ctx, args.orgId, "accounting");
    const limit = Math.min(args.limit ?? 50, 200);

    if (args.customerId) {
      return ctx.db
        .query("receivableDocuments")
        .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
        .take(limit);
    }
    if (args.status) {
      return ctx.db
        .query("receivableDocuments")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status as "OPEN" | "PARTIALLY_PAID" | "PAID" | "WRITTEN_OFF" | "CANCELLED" | "REVERSED"))
        .take(limit);
    }
    return ctx.db.query("receivableDocuments").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(limit);
  },
});

export const getReceivableBalance = query({
  args: { orgId: v.id("organizations"), receivableDocumentId: v.id("receivableDocuments") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    await requireFeature(ctx, args.orgId, "accounting");
    const doc = await ctx.db.get(args.receivableDocumentId);
    if (!doc || doc.orgId !== args.orgId) return null;
    const outstandingMinor = await getReceivableOutstandingMinor(ctx, args.receivableDocumentId);
    return { doc, outstandingMinor };
  },
});

export const getPaymentBalance = query({
  args: { orgId: v.id("organizations"), paymentId: v.id("canonicalPayments") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    await requireFeature(ctx, args.orgId, "accounting");
    const payment = await ctx.db.get(args.paymentId);
    if (!payment || payment.orgId !== args.orgId) return null;
    const unappliedMinor = await getPaymentUnappliedMinor(ctx, args.paymentId);
    return { payment, unappliedMinor };
  },
});

export const listAllocations = query({
  args: {
    orgId: v.id("organizations"),
    receivableDocumentId: v.optional(v.id("receivableDocuments")),
    paymentId: v.optional(v.id("canonicalPayments")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    await requireFeature(ctx, args.orgId, "accounting");
    // SCRUM-261: authorising args.orgId says nothing about the parent id the
    // caller supplied. Prove the parent is this org's before reading a single
    // child, and let only children stamped with this org leave. A foreign or
    // missing parent reads exactly like one with no allocations, as in
    // getReceivableBalance / getPaymentBalance.
    if (args.receivableDocumentId) {
      const receivable = await ctx.db.get(args.receivableDocumentId);
      if (!receivable || receivable.orgId !== args.orgId) return [];
      const rows = await ctx.db.query("paymentAllocations").withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivable._id)).collect();
      return rows.filter((row) => row.orgId === args.orgId);
    }
    if (args.paymentId) {
      const payment = await ctx.db.get(args.paymentId);
      if (!payment || payment.orgId !== args.orgId) return [];
      const rows = await ctx.db.query("paymentAllocations").withIndex("by_payment", (q) => q.eq("paymentId", payment._id)).collect();
      return rows.filter((row) => row.orgId === args.orgId);
    }
    return [];
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────
//
// These four are internalMutation, not mutation: every production flow already
// calls the underlying createReceivableDocument/createCanonicalPayment/
// allocatePaymentToReceivable/reverseAllocation helpers directly, paired with a
// workflowHooks.ts GL-posting call in the same transaction (saleCompletion.ts,
// claims.ts, deposits.ts, paymentIntents.ts, collections.ts, applications.ts).
// If these were public, any MANAGE_FINANCE user could call them straight from
// the client and write subledger state with no corresponding GL entry, since
// none of these handlers post to the ledger themselves — desyncing the GL from
// the subledger with no trace. Keep them internal-only; a genuine ad-hoc/
// back-office use case should get its own hookXxx-calling wrapper, not expose
// these raw building blocks.

export const createReceivable = internalMutation({
  args: {
    orgId: v.id("organizations"),
    documentType: v.union(
      v.literal("INVOICE"), v.literal("INSTALLMENT"), v.literal("DEBIT_ADJUSTMENT"),
      v.literal("CREDIT_ADJUSTMENT"), v.literal("WRITE_OFF"), v.literal("REFUND_PAYABLE"),
    ),
    payerType: v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY")),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    sourceType: v.string(),
    sourceId: v.string(),
    originalAmountMinor: v.number(),
    currency: v.string(),
    issueDate: v.number(),
    dueDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    // SCRUM-571 S1 (D-20): no second debt for a sale. Before the only write.
    await assertSourceIsNotSaleDebt(ctx, args.orgId, args);
    return createReceivableDocument(ctx, { ...args, actorId: user._id });
  },
});

export const recordPayment = internalMutation({
  args: {
    orgId: v.id("organizations"),
    direction: v.union(v.literal("IN"), v.literal("OUT")),
    customerId: v.optional(v.id("customers")),
    method: v.union(
      v.literal("CASH"), v.literal("BANK_TRANSFER"), v.literal("CARD"),
      v.literal("PAYMENT_LINK"), v.literal("CHEQUE"), v.literal("INTERNAL_TRANSFER"), v.literal("OTHER"),
    ),
    amountMinor: v.number(),
    currency: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    // SCRUM-760 ruling 11: an OUT payment to a customer is a refund payout. Refused before the only
    // write. An IN payment, or an OUT payment that names no customer, is not refund-shaped.
    if (args.direction === "OUT" && args.customerId !== undefined) assertLegacyCollectionRefundAllowed();
    return createCanonicalPayment(ctx, { ...args, actorId: user._id });
  },
});

export const allocate = internalMutation({
  args: {
    orgId: v.id("organizations"),
    paymentId: v.id("canonicalPayments"),
    receivableDocumentId: v.id("receivableDocuments"),
    amountMinor: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    // SCRUM-571 S1 (D-20): no allocation to a sale invoice or its legacy mirror.
    const target = await ctx.db.get(args.receivableDocumentId);
    if (target && target.orgId === args.orgId) await assertSourceIsNotSaleDebt(ctx, args.orgId, target);
    return allocatePaymentToReceivable(ctx, { ...args, actorId: user._id });
  },
});

export const reverseAllocationMutation = internalMutation({
  args: {
    orgId: v.id("organizations"),
    allocationId: v.id("paymentAllocations"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    // SCRUM-760 ruling 11: reversing an allocation is the receivable-reopening half of a collection
    // refund, and a call here cannot be told apart from one. No production code calls this operator
    // door: cancel, unwind and cheque return call the `reverseAllocation` helper directly, which is
    // not gated. Refused before the only write.
    assertLegacyCollectionRefundAllowed();
    return reverseAllocation(ctx, { ...args, actorId: user._id });
  },
});
