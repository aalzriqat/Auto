import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getReceivableOutstandingMinor } from "../subledger";
import { loadRetainedPosition } from "./receiptMovement";

const MAX_PENDING_APPLICATIONS = 500;

async function pendingReceiptRows(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  receiptMovementId: Id<"receiptMovements">
): Promise<Doc<"invoiceReceiptApplications">[]> {
  const rows = await ctx.db
    .query("invoiceReceiptApplications")
    .withIndex("by_org_movement_status", (q) =>
      q.eq("orgId", orgId).eq("receiptMovementId", receiptMovementId).eq("status", "PENDING")
    )
    .take(MAX_PENDING_APPLICATIONS + 1);
  if (rows.length > MAX_PENDING_APPLICATIONS) {
    throw new ConvexError("This receipt has too many pending applications for a safe balance check.");
  }
  return rows;
}

/** Reserved credit is still a 2110 liability; it has not paid an invoice. */
export async function pendingInvoiceReceiptMinor(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  receiptMovementId: Id<"receiptMovements">
): Promise<number> {
  const rows = await pendingReceiptRows(ctx, orgId, receiptMovementId);
  return rows.reduce((sum, row) => sum + row.amountMinor, 0);
}

async function pendingSaleRows(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<Doc<"invoiceReceiptApplications">[]> {
  const rows = await ctx.db
    .query("invoiceReceiptApplications")
    .withIndex("by_org_sale_status", (q) =>
      q.eq("orgId", orgId).eq("saleId", saleId).eq("status", "PENDING")
    )
    .take(MAX_PENDING_APPLICATIONS + 1);
  if (rows.length > MAX_PENDING_APPLICATIONS) {
    throw new ConvexError("This sale has too many pending applications for a safe balance check.");
  }
  return rows;
}

/** Includes every PENDING claim, so activation can refuse a stale over-reservation. */
export async function pendingSaleInvoiceReceiptMinor(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<number> {
  const rows = await pendingSaleRows(ctx, orgId, saleId);
  return rows.reduce((sum, row) => sum + row.amountMinor, 0);
}

/**
 * SCRUM-722 dark slice: reserve an existing retained receipt against one sale
 * invoice. No allocation or journal is created here. A later, separately
 * reviewed activation must prove both original postings and provide the exits.
 * This helper has no public API caller while SCRUM-723/724 remain open.
 */
export async function reservePendingInvoiceReceipt(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receiptMovementId: Id<"receiptMovements">;
    saleId: Id<"sales">;
    amountMinor: number;
    actorId: Id<"users">;
  }
): Promise<Id<"invoiceReceiptApplications">> {
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new ConvexError("A pending application must reserve a positive minor-unit amount.");
  }
  const [movement, sale] = await Promise.all([
    ctx.db.get(args.receiptMovementId),
    ctx.db.get(args.saleId),
  ]);
  if (!movement || movement.orgId !== args.orgId || !sale || sale.orgId !== args.orgId) {
    throw new ConvexError("Receipt or sale not found in this organization.");
  }
  if (sale.status !== "COMPLETED" || !sale.canonicalReceivableDocumentId) {
    throw new ConvexError("This sale has no completed customer invoice.");
  }
  const invoice = await ctx.db.get(sale.canonicalReceivableDocumentId);
  if (
    !invoice || invoice.orgId !== args.orgId ||
    (invoice.status !== "OPEN" && invoice.status !== "PARTIALLY_PAID") ||
    invoice.documentType !== "INVOICE" || invoice.payerType !== "CUSTOMER" ||
    invoice.sourceType !== "sales" || invoice.sourceId !== String(sale._id) ||
    invoice.customerId !== sale.customerId || movement.customerId !== sale.customerId ||
    invoice.currency.toUpperCase() !== movement.currency.toUpperCase() ||
    movement.liabilityTreatment !== "UNAPPLIED_CUSTOMER_RECEIPTS"
  ) {
    throw new ConvexError("Receipt and sale invoice do not describe the same customer credit.");
  }
  const position = await loadRetainedPosition(ctx, args.orgId, movement._id);
  if (
    position.customerId !== movement.customerId ||
    position.currency.toUpperCase() !== movement.currency.toUpperCase()
  ) {
    throw new ConvexError("Retained credit position does not match its receipt.");
  }
  const [receiptRows, saleRows, outstandingMinor] = await Promise.all([
    pendingReceiptRows(ctx, args.orgId, movement._id),
    pendingSaleRows(ctx, args.orgId, sale._id),
    getReceivableOutstandingMinor(ctx, invoice._id),
  ]);
  // Keep the next claim inside the bound used by read-back and both exits.
  if (receiptRows.length >= MAX_PENDING_APPLICATIONS || saleRows.length >= MAX_PENDING_APPLICATIONS) {
    throw new ConvexError("This receipt or sale has too many pending applications for another reservation.");
  }
  const reservedMinor = receiptRows.reduce((sum, row) => sum + row.amountMinor, 0);
  const pendingForSaleMinor = saleRows.reduce((sum, row) => sum + row.amountMinor, 0);
  if (
    args.amountMinor > position.remainingUnappliedMinor - reservedMinor ||
    args.amountMinor > outstandingMinor - pendingForSaleMinor
  ) {
    throw new ConvexError("The retained credit or sale invoice has insufficient unreserved balance.");
  }
  const now = Date.now();
  const applicationId = await ctx.db.insert("invoiceReceiptApplications", {
    orgId: args.orgId,
    receiptMovementId: movement._id,
    saleId: sale._id,
    receivableDocumentId: invoice._id,
    customerId: sale.customerId,
    currency: movement.currency,
    amountMinor: args.amountMinor,
    status: "PENDING",
    createdBy: args.actorId,
    createdAt: now,
  });
  // Contend on the same row as applyRetainedCredit under Convex OCC. The child
  // and this patch commit together; neither is a standalone money movement.
  await ctx.db.patch(position._id, { updatedAt: now });
  return applicationId;
}

export async function cancelPendingInvoiceReceipt(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"invoiceReceiptApplications">
): Promise<void> {
  const application = await ctx.db.get(applicationId);
  if (!application || application.orgId !== orgId || (application.status !== "PENDING" && application.status !== "CANCELLED")) {
    throw new ConvexError("Pending application not found in this organization.");
  }
  if (application.status === "CANCELLED") return;
  const position = await loadRetainedPosition(ctx, orgId, application.receiptMovementId);
  const now = Date.now();
  await ctx.db.patch(application._id, { status: "CANCELLED", cancelledAt: now });
  await ctx.db.patch(position._id, { updatedAt: now });
}

/** Sale cancellation releases every unactivated claim while retaining the 2110 credit. */
export async function cancelPendingInvoiceReceiptsForSale(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<void> {
  const rows = await pendingSaleRows(ctx, orgId, saleId);
  for (const row of rows) {
    await cancelPendingInvoiceReceipt(ctx, orgId, row._id);
  }
}

/** A returned cheque voids its pending claims before the retained position is retired. */
export async function cancelPendingInvoiceReceiptsForMovement(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  receiptMovementId: Id<"receiptMovements">
): Promise<void> {
  const rows = await pendingReceiptRows(ctx, orgId, receiptMovementId);
  for (const row of rows) {
    await cancelPendingInvoiceReceipt(ctx, orgId, row._id);
  }
}
