import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

/**
 * Shared seeds for the SCRUM-571 D-43 suites (a sale must never read as settled
 * while its customer invoice has a balance, or while that balance or its posted
 * origin cannot be proven).
 *
 * `status` names the posting the sale's SALE_COMPLETED event and journal are in:
 *   - POSTED         event POSTED, journal POSTED and linked (the proven shape);
 *   - PENDING        the event is only queued (no journal);
 *   - JOURNAL_DRAFT  event POSTED, but its journal is still a DRAFT;
 *   - NO_JOURNAL     event POSTED with no journal behind it;
 *   - MISSING        nothing at all.
 */
export type SaleCompletedPostingStatus = "POSTED" | "PENDING" | "JOURNAL_DRAFT" | "NO_JOURNAL" | "MISSING";

export async function seedSaleCompletedPosting(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; saleId: Id<"sales">; userId: Id<"users">; status?: SaleCompletedPostingStatus }
): Promise<void> {
  const status = args.status ?? "POSTED";
  if (status === "MISSING") return;
  const now = Date.now();
  const eventId = await ctx.db.insert("accountingEvents", {
    orgId: args.orgId, eventType: "SALE_COMPLETED", sourceType: "sales", sourceId: args.saleId, eventVersion: 1,
    idempotencyKey: `sale_completed_${args.saleId}`, occurredAt: now, accountingDate: now,
    currency: "JOD", payload: {}, status: status === "PENDING" ? "PENDING" : "POSTED",
    createdBy: args.userId, createdAt: now,
  });
  if (status === "PENDING" || status === "NO_JOURNAL") return;
  const journalId = await ctx.db.insert("journalEntries", {
    orgId: args.orgId, accountingEventId: eventId, journalNumber: `JE-${args.saleId}`, accountingDate: now,
    sourceType: "sales", sourceId: args.saleId, category: "SYSTEM", memo: "sale", currency: "JOD",
    status: status === "JOURNAL_DRAFT" ? "DRAFT" : "POSTED", postedBy: args.userId, postedAt: now, createdAt: now,
  });
  await ctx.db.patch(eventId, { journalEntryId: journalId });
}

/**
 * The sale's canonical customer INVOICE, with `openMinor` still outstanding (0 pays it in full), the
 * `canonicalReceivableDocumentId` pointer set, and optionally a SALE_COMPLETED posting in `posting`
 * (omit it to seed no posting at all). Returns the receivable id.
 */
export async function seedSaleInvoice(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    userId: Id<"users">;
    customerId: Id<"customers">;
    /** Invoice face value, default 10,500 JOD. */
    originalMinor?: number;
    openMinor?: number;
    posting?: SaleCompletedPostingStatus;
  }
): Promise<Id<"receivableDocuments">> {
  const originalMinor = args.originalMinor ?? 10_500_000;
  const openMinor = args.openMinor ?? 0;
  const now = Date.now();
  const receivableId = await ctx.db.insert("receivableDocuments", {
    orgId: args.orgId, documentType: "INVOICE", documentNumber: `INV-${args.saleId}`, payerType: "CUSTOMER",
    customerId: args.customerId, sourceType: "sales", sourceId: args.saleId, originalAmountMinor: originalMinor,
    currency: "JOD", scale: 3, issueDate: now, dueDate: now, status: openMinor === 0 ? "PAID" : "OPEN",
    createdAt: now, createdBy: args.userId,
  });
  if (originalMinor - openMinor > 0) {
    await payInvoice(ctx, {
      orgId: args.orgId, userId: args.userId, customerId: args.customerId, receivableId,
      amountMinor: originalMinor - openMinor,
    });
  }
  await ctx.db.patch(args.saleId, { canonicalReceivableDocumentId: receivableId });
  if (args.posting) {
    await seedSaleCompletedPosting(ctx, { orgId: args.orgId, saleId: args.saleId, userId: args.userId, status: args.posting });
  }
  return receivableId;
}

/** A SETTLED customer payment allocated to `receivableId` (JOD, 3 decimals). */
export async function payInvoice(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    userId: Id<"users">;
    receivableId: Id<"receivableDocuments">;
    amountMinor: number;
    customerId?: Id<"customers">;
  }
): Promise<void> {
  const now = Date.now();
  const paymentId = await ctx.db.insert("canonicalPayments", {
    orgId: args.orgId, direction: "IN", payerType: "CUSTOMER",
    ...(args.customerId ? { customerId: args.customerId } : {}),
    method: "CASH", amountMinor: args.amountMinor, currency: "JOD", scale: 3, status: "SETTLED",
    idempotencyKey: `paid-${args.receivableId}-${crypto.randomUUID()}`, createdBy: args.userId, createdAt: now,
  });
  await ctx.db.insert("paymentAllocations", {
    orgId: args.orgId, paymentId, receivableDocumentId: args.receivableId, amountMinor: args.amountMinor,
    currency: "JOD", scale: 3, allocationDate: now, status: "ACTIVE", createdBy: args.userId, createdAt: now,
  });
}
