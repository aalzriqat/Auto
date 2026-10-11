/**
 * SCRUM-724 owner ruling (Q-DA06): paying retained 2110 customer credit back to
 * the customer is a standalone refund that needs approval.
 *
 *   request  (MANAGE_FINANCE)  ->  decide  (APPROVE_REQUESTS, a DIFFERENT actor)
 *                              ->  execute (MANAGE_FINANCE; exactly one payout)
 *
 * The request is keyed to the retained position / movement, never to a
 * receivable: credit left by a cancelled sale has no receivable and none is
 * fabricated. One approved request authorizes exactly ONE payout - EXECUTED is
 * terminal, so a retry under any key or a duplicate approval cannot pay twice.
 *
 * Execution is one Convex mutation: the position decrement, the canonical
 * payment, the RETAINED_CREDIT_REFUNDED journal (DR 2110 / CR Bank|Cash) and the
 * request transition commit together or not at all. Nothing in here may catch a
 * refusal, because a caught exception would commit the writes before it.
 */
import { v } from "convex/values";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { assertDifferentActors } from "./utils/financialGuards";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { RETAINED_CREDIT_MESSAGES } from "./utils/retainedCreditMessages";
import { createCanonicalPayment } from "./subledger";
import { postAccountingEvent } from "./accounting/postingEngine";
import { loadRetainedPosition, requirePostedReceiptForMovement } from "./accounting/receiptMovement";
import { pendingInvoiceReceiptMinor } from "./accounting/invoiceReceiptReservation";

const REASON_MAX = 500;
const REFERENCE_MAX = 120;
const OPEN_REQUEST_SCAN = 200;

const methodValidator = v.union(v.literal("BANK_TRANSFER"), v.literal("CASH"));

function refuse(code: keyof typeof RETAINED_CREDIT_MESSAGES): never {
  return throwAppError(AppErrorCode[code], RETAINED_CREDIT_MESSAGES[code]);
}

/** Money requested but not yet paid out (PENDING + APPROVED) for one movement. */
async function openRequestMinor(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  receiptMovementId: Id<"receiptMovements">,
  excludeRequestId?: Id<"retainedCreditRefundRequests">
): Promise<number> {
  const rows = await ctx.db
    .query("retainedCreditRefundRequests")
    .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", receiptMovementId))
    .take(OPEN_REQUEST_SCAN + 1);
  if (rows.length > OPEN_REQUEST_SCAN) refuse("RETAINED_CREDIT_REFUND_INSUFFICIENT");
  return rows
    .filter((row) => (row.status === "PENDING" || row.status === "APPROVED") && row._id !== excludeRequestId)
    .reduce((sum, row) => sum + row.amountMinor, 0);
}

async function loadMovementAndPosition(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  receiptMovementId: Id<"receiptMovements">
): Promise<{ movement: Doc<"receiptMovements">; position: Doc<"receiptRetainedPositions"> }> {
  const movement = await ctx.db.get(receiptMovementId);
  if (!movement || movement.orgId !== orgId || movement.liabilityTreatment !== "UNAPPLIED_CUSTOMER_RECEIPTS") {
    refuse("RETAINED_CREDIT_REFUND_NOT_FOUND");
  }
  let position: Doc<"receiptRetainedPositions">;
  try {
    position = await loadRetainedPosition(ctx, orgId, movement._id);
  } catch {
    // Nothing has been written yet, so translating the refusal is safe.
    return refuse("RETAINED_CREDIT_REFUND_NOT_FOUND");
  }
  if (position.customerId !== movement.customerId ||
      position.currency.toUpperCase() !== movement.currency.toUpperCase()) {
    refuse("RETAINED_CREDIT_REFUND_NOT_FOUND");
  }
  return { movement, position };
}

async function requireReceiptPosted(ctx: MutationCtx, movement: Doc<"receiptMovements">): Promise<void> {
  try {
    await requirePostedReceiptForMovement(ctx, movement);
  } catch {
    // Read-only proof; no write precedes it in any caller.
    refuse("RETAINED_CREDIT_REFUND_RECEIPT_UNPOSTED");
  }
}

function assertPositiveMinor(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) refuse("RETAINED_CREDIT_REFUND_INVALID_AMOUNT");
}

export const requestRetainedCreditRefund = mutation({
  args: {
    orgId: v.id("organizations"),
    receiptMovementId: v.id("receiptMovements"),
    amountMinor: v.number(),
    method: methodValidator,
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"retainedCreditRefundRequests">> => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    assertPositiveMinor(args.amountMinor);
    const reason = args.reason.trim();
    if (reason.length === 0 || reason.length > REASON_MAX) {
      throwAppError(AppErrorCode.VALIDATION_FAILED, "Give a refund reason of at most 500 characters.");
    }
    const { movement, position } = await loadMovementAndPosition(ctx, args.orgId, args.receiptMovementId);
    await requireReceiptPosted(ctx, movement);
    const [reservedMinor, openMinor] = await Promise.all([
      pendingInvoiceReceiptMinor(ctx, args.orgId, movement._id),
      openRequestMinor(ctx, args.orgId, movement._id),
    ]);
    if (args.amountMinor > position.remainingUnappliedMinor - reservedMinor - openMinor) {
      refuse("RETAINED_CREDIT_REFUND_INSUFFICIENT");
    }
    const now = Date.now();
    return await ctx.db.insert("retainedCreditRefundRequests", {
      orgId: args.orgId,
      receiptMovementId: movement._id,
      positionId: position._id,
      customerId: movement.customerId,
      currency: movement.currency,
      amountMinor: args.amountMinor,
      method: args.method,
      reason,
      status: "PENDING",
      requestedBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const respondToRetainedCreditRefund = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("retainedCreditRefundRequests"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
    decisionNotes: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"retainedCreditRefundRequests">> => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "retainedCreditRefunds.respond",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ requestId: args.requestId, status: args.status }),
      },
      async () => {
        const request = await ctx.db.get(args.requestId);
        if (!request || request.orgId !== args.orgId) refuse("RETAINED_CREDIT_REFUND_NOT_FOUND");
        if (request.status !== "PENDING") refuse("RETAINED_CREDIT_REFUND_NOT_PENDING");
        assertDifferentActors(
          user._id,
          request.requestedBy,
          "Requester cannot approve or reject their own retained credit refund request."
        );
        if (args.status === "APPROVED") {
          const { movement, position } = await loadMovementAndPosition(ctx, args.orgId, request.receiptMovementId);
          await requireReceiptPosted(ctx, movement);
          const [reservedMinor, otherOpenMinor] = await Promise.all([
            pendingInvoiceReceiptMinor(ctx, args.orgId, movement._id),
            openRequestMinor(ctx, args.orgId, movement._id, request._id),
          ]);
          if (request.amountMinor > position.remainingUnappliedMinor - reservedMinor - otherOpenMinor) {
            refuse("RETAINED_CREDIT_REFUND_INSUFFICIENT");
          }
        }
        const now = Date.now();
        await ctx.db.patch(request._id, {
          status: args.status,
          decidedBy: user._id,
          decidedAt: now,
          decisionNotes: args.decisionNotes?.trim() || undefined,
          responseIdempotencyKey: args.idempotencyKey,
          updatedAt: now,
        });
        return request._id;
      }
    );
  },
});

export const executeRetainedCreditRefund = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("retainedCreditRefundRequests"),
    reference: v.string(),
    paidAt: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ paymentId: Id<"canonicalPayments">; eventId: Id<"accountingEvents">; amountMinor: number }> => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const reference = args.reference.trim();
    const now = Date.now();
    if (reference.length === 0 || reference.length > REFERENCE_MAX ||
        !Number.isSafeInteger(args.paidAt) || args.paidAt < 0 || args.paidAt > now) {
      refuse("RETAINED_CREDIT_REFUND_PAYOUT_INVALID");
    }
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "retainedCreditRefunds.execute",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ requestId: args.requestId, reference, paidAt: args.paidAt }),
      },
      async () => {
        const request = await ctx.db.get(args.requestId);
        if (!request || request.orgId !== args.orgId) refuse("RETAINED_CREDIT_REFUND_NOT_FOUND");
        // EXECUTED is terminal: a second execution under any key stops here.
        if (request.status !== "APPROVED") refuse("RETAINED_CREDIT_REFUND_NOT_APPROVED");

        const { movement, position } = await loadMovementAndPosition(ctx, args.orgId, request.receiptMovementId);
        if (position._id !== request.positionId || movement.customerId !== request.customerId) {
          refuse("RETAINED_CREDIT_REFUND_NOT_FOUND");
        }
        await requireReceiptPosted(ctx, movement);
        const reservedMinor = await pendingInvoiceReceiptMinor(ctx, args.orgId, movement._id);
        if (request.amountMinor > position.remainingUnappliedMinor - reservedMinor) {
          refuse("RETAINED_CREDIT_REFUND_INSUFFICIENT");
        }

        // The position is the contended row: the decrement and the payout commit together.
        await ctx.db.patch(position._id, {
          remainingUnappliedMinor: position.remainingUnappliedMinor - request.amountMinor,
          updatedAt: now,
        });

        const paymentId = await createCanonicalPayment(ctx, {
          orgId: args.orgId,
          direction: "OUT",
          payerType: "CUSTOMER",
          customerId: request.customerId,
          method: request.method,
          amountMinor: request.amountMinor,
          currency: request.currency,
          idempotencyKey: `retained_credit_refund_${request._id}`,
          actorId: user._id,
          status: "SETTLED",
          externalReference: reference,
          receivedAt: args.paidAt,
        });
        const payment = await ctx.db.get(paymentId);
        if (!payment || payment.orgId !== args.orgId || payment.status !== "SETTLED" ||
            payment.direction !== "OUT" || payment.payerType !== "CUSTOMER" ||
            payment.customerId !== request.customerId ||
            payment.amountMinor !== request.amountMinor || payment.method !== request.method ||
            payment.currency.toUpperCase() !== request.currency.toUpperCase() ||
            payment.externalReference !== reference || payment.receivedAt !== args.paidAt) {
          throwAppError(
            AppErrorCode.RETAINED_CREDIT_REFUND_POSTING_FAILED,
            RETAINED_CREDIT_MESSAGES.RETAINED_CREDIT_REFUND_POSTING_FAILED
          );
        }

        const sourceId = `${position._id}:refund:${request._id}`;
        const posted = await postAccountingEvent(ctx, {
          orgId: args.orgId,
          eventType: "RETAINED_CREDIT_REFUNDED",
          sourceType: "receiptRetainedPositions",
          sourceId,
          eventVersion: 1,
          accountingDate: now,
          occurredAt: args.paidAt,
          currency: request.currency,
          idempotencyKey: `retained_credit_refunded_${request._id}`,
          payload: {
            positionId: String(position._id),
            refundRequestId: String(request._id),
            paymentId: String(paymentId),
            amountMinor: request.amountMinor,
            currency: request.currency,
            customerId: String(request.customerId),
            paymentMethod: request.method,
          },
          actorId: user._id,
        });
        if (posted.alreadyPosted || !posted.eventId || !posted.journalEntryId) {
          throwAppError(
            AppErrorCode.RETAINED_CREDIT_REFUND_POSTING_FAILED,
            RETAINED_CREDIT_MESSAGES.RETAINED_CREDIT_REFUND_POSTING_FAILED
          );
        }
        const [event, journal] = await Promise.all([
          ctx.db.get(posted.eventId), ctx.db.get(posted.journalEntryId),
        ]);
        if (!event || event.orgId !== args.orgId || event.status !== "POSTED" ||
            event.eventType !== "RETAINED_CREDIT_REFUNDED" ||
            event.sourceType !== "receiptRetainedPositions" || event.sourceId !== sourceId ||
            !journal || journal.orgId !== args.orgId || journal.status !== "POSTED" ||
            journal.accountingEventId !== event._id) {
          throwAppError(
            AppErrorCode.RETAINED_CREDIT_REFUND_POSTING_FAILED,
            RETAINED_CREDIT_MESSAGES.RETAINED_CREDIT_REFUND_POSTING_FAILED
          );
        }
        await ctx.db.patch(paymentId, { accountingEventId: posted.eventId });
        await ctx.db.patch(request._id, {
          status: "EXECUTED",
          executedBy: user._id,
          executedAt: now,
          canonicalPaymentId: paymentId,
          accountingEventId: posted.eventId,
          updatedAt: now,
        });
        return { paymentId, eventId: posted.eventId, amountMinor: request.amountMinor };
      }
    );
  },
});

/** Refund requests for the approvals / credit screens, newest first. */
export const listRetainedCreditRefundRequests = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.union(
      v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED"), v.literal("EXECUTED")
    )),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const status = args.status;
    const rows = status
      ? await ctx.db.query("retainedCreditRefundRequests")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
          .order("desc").take(100)
      : await ctx.db.query("retainedCreditRefundRequests")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .order("desc").take(100);
    return await Promise.all(rows.map(async (row) => {
      const [position, customer] = await Promise.all([
        ctx.db.get(row.positionId),
        ctx.db.get(row.customerId),
      ]);
      const cheque = position?.sourceChequeId ? await ctx.db.get(position.sourceChequeId) : null;
      const sale = position?.originatingSaleId ? await ctx.db.get(position.originatingSaleId) : null;
      return {
        ...row,
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : undefined,
        sourceChequeLabel: cheque && cheque.orgId === args.orgId
          ? `${cheque.bank} #${cheque.chequeNumber}` : undefined,
        originatingSaleId: position?.originatingSaleId,
        originatingSaleStatus: sale && sale.orgId === args.orgId ? sale.status : undefined,
      };
    }));
  },
});
