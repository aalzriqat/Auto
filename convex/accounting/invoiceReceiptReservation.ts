import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getReceivableOutstandingMinor } from "../subledger";
import { loadRetainedPosition, MAX_REVOCABLE_APPLICATIONS } from "./receiptMovement";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { RETAINED_CREDIT_MESSAGES } from "../utils/retainedCreditMessages";

/**
 * SCRUM-724 R4 (Codex stack review): the reservation bound IS the reversal bound.
 * A return or cancellation plans at most MAX_REVOCABLE_APPLICATIONS rows, so a
 * receipt or sale may never hold more PENDING claims than one unwind can release.
 */
const MAX_PENDING_APPLICATIONS = MAX_REVOCABLE_APPLICATIONS;

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

const OPEN_REFUND_REQUEST_SCAN = 200;

/**
 * SCRUM-724 Sol 6 Q3: invalidates every OPEN (PENDING + APPROVED) refund request
 * of one movement, with an audited reason, in the caller's transaction. Used when
 * the source cheque is returned: the credit those requests would pay out is about
 * to be retired, and an APPROVED request left behind could never execute nor be
 * cancelled by anyone who does not know it exists. EXECUTED rows are never touched
 * (the caller refuses that case first). Fails closed beyond the bound.
 */
export async function cancelOpenRefundRequestsForMovement(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receiptMovementId: Id<"receiptMovements">;
    actorId: Id<"users">;
    reason: string;
  }
): Promise<number> {
  const now = Date.now();
  let cancelled = 0;
  for (const status of ["PENDING", "APPROVED"] as const) {
    const rows = await ctx.db
      .query("retainedCreditRefundRequests")
      .withIndex("by_org_movement_status", (q) =>
        q.eq("orgId", args.orgId).eq("receiptMovementId", args.receiptMovementId).eq("status", status))
      .take(OPEN_REFUND_REQUEST_SCAN + 1);
    if (rows.length > OPEN_REFUND_REQUEST_SCAN) {
      throwAppError(
        AppErrorCode.RETAINED_CREDIT_REFUND_INSUFFICIENT,
        RETAINED_CREDIT_MESSAGES.RETAINED_CREDIT_REFUND_INSUFFICIENT
      );
    }
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        status: "CANCELLED",
        cancelledBy: args.actorId,
        cancelledAt: now,
        cancelReason: args.reason,
        cancelledFromStatus: status,
        updatedAt: now,
      });
      cancelled += 1;
    }
  }
  return cancelled;
}

/**
 * SCRUM-724: credit already asked back by the customer (PENDING + APPROVED
 * standalone refund requests) for one movement. Reads ONLY open rows through
 * by_org_movement_status (two bounded indexed reads), so closed history never
 * counts against the bound. Fails closed (coded) beyond the bound.
 */
export async function openRefundRequestMinor(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  receiptMovementId: Id<"receiptMovements">,
  excludeRequestId?: Id<"retainedCreditRefundRequests">
): Promise<number> {
  let total = 0;
  for (const status of ["PENDING", "APPROVED"] as const) {
    const rows = await ctx.db
      .query("retainedCreditRefundRequests")
      .withIndex("by_org_movement_status", (q) =>
        q.eq("orgId", orgId).eq("receiptMovementId", receiptMovementId).eq("status", status))
      .take(OPEN_REFUND_REQUEST_SCAN + 1);
    if (rows.length > OPEN_REFUND_REQUEST_SCAN) {
      throwAppError(
        AppErrorCode.RETAINED_CREDIT_REFUND_INSUFFICIENT,
        RETAINED_CREDIT_MESSAGES.RETAINED_CREDIT_REFUND_INSUFFICIENT
      );
    }
    for (const row of rows) if (row._id !== excludeRequestId) total += row.amountMinor;
  }
  return total;
}

/**
 * SCRUM-724: THE one notion of available retained credit:
 *   remaining - reserved for sale invoices - open (PENDING|APPROVED) refund requests.
 * Request, approve, execute, reserve, apply and the credit listing all call this
 * and nothing else computes it. excludeRequestId lets a refund request validate
 * itself without double-counting its own amount.
 */
export async function availableRetainedCreditMinor(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  position: Pick<Doc<"receiptRetainedPositions">, "receiptMovementId" | "remainingUnappliedMinor">,
  excludeRequestId?: Id<"retainedCreditRefundRequests">
): Promise<{ reservedMinor: number; openRefundMinor: number; availableMinor: number }> {
  const [reservedMinor, openRefundMinor] = await Promise.all([
    pendingInvoiceReceiptMinor(ctx, orgId, position.receiptMovementId),
    openRefundRequestMinor(ctx, orgId, position.receiptMovementId, excludeRequestId),
  ]);
  return {
    reservedMinor,
    openRefundMinor,
    availableMinor: position.remainingUnappliedMinor - reservedMinor - openRefundMinor,
  };
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
  const [receiptRows, saleRows, outstandingMinor, credit] = await Promise.all([
    pendingReceiptRows(ctx, args.orgId, movement._id),
    pendingSaleRows(ctx, args.orgId, sale._id),
    getReceivableOutstandingMinor(ctx, invoice._id),
    availableRetainedCreditMinor(ctx, args.orgId, position),
  ]);
  // Keep the next claim inside the bound used by read-back and both exits.
  if (receiptRows.length >= MAX_PENDING_APPLICATIONS || saleRows.length >= MAX_PENDING_APPLICATIONS) {
    throw new ConvexError("This receipt or sale has too many pending applications for another reservation.");
  }
  const pendingForSaleMinor = saleRows.reduce((sum, row) => sum + row.amountMinor, 0);
  // SCRUM-724: credit a customer already asked back is not reservable; coded so
  // the operator sees the reason in EN/AR instead of a raw English string.
  if (args.amountMinor > credit.availableMinor) {
    throwAppError(
      AppErrorCode.RETAINED_CREDIT_UNAVAILABLE,
      RETAINED_CREDIT_MESSAGES.RETAINED_CREDIT_UNAVAILABLE
    );
  }
  if (args.amountMinor > outstandingMinor - pendingForSaleMinor) {
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
