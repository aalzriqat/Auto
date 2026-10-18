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
import { paginationOptsValidator } from "convex/server";
import { query, type MutationCtx } from "./_generated/server";
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
import { availableRetainedCreditMinor } from "./accounting/invoiceReceiptReservation";
import {
  assertCustomerCreditPayoutAllowed,
  assertCustomerCreditPayoutMethodSupported,
  isCustomerCreditPayoutDisabled,
} from "./utils/customerCreditPayoutContainment";

const REASON_MAX = 500;
const REFERENCE_MAX = 120;
const APPROVAL_QUEUE_DEFAULT_PAGE = 25;
const APPROVAL_QUEUE_MAX_PAGE = 100;

const methodValidator = v.union(v.literal("BANK_TRANSFER"), v.literal("CASH"));

function refuse(code: keyof typeof RETAINED_CREDIT_MESSAGES): never {
  return throwAppError(AppErrorCode[code], RETAINED_CREDIT_MESSAGES[code]);
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
    // SCRUM-724 Sol 6 Q1=b / Q7: one payout authority, one switch. Refused before any read or write.
    assertCustomerCreditPayoutAllowed();
    assertPositiveMinor(args.amountMinor);
    const reason = args.reason.trim();
    if (reason.length === 0 || reason.length > REASON_MAX) {
      throwAppError(AppErrorCode.VALIDATION_FAILED, "Give a refund reason of at most 500 characters.");
    }
    const { movement, position } = await loadMovementAndPosition(ctx, args.orgId, args.receiptMovementId);
    await requireReceiptPosted(ctx, movement);
    const { availableMinor } = await availableRetainedCreditMinor(ctx, args.orgId, position);
    if (args.amountMinor > availableMinor) {
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
    // Approval authorizes a payout, so it is refused with the payout switch on.
    // REJECTED authorizes nothing and stays available as an exit.
    if (args.status === "APPROVED") assertCustomerCreditPayoutAllowed();
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
          const { availableMinor } = await availableRetainedCreditMinor(ctx, args.orgId, position, request._id);
          if (request.amountMinor > availableMinor) {
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
    // Refused before the idempotency wrapper, so a stored replay is refused too.
    assertCustomerCreditPayoutAllowed();
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
        // Defence in depth that survives the switch: a CASH payout would leave no
        // collectionPayments row for cashier-day reconciliation (Sol Q5, deferred).
        assertCustomerCreditPayoutMethodSupported(request.method);

        const { movement, position } = await loadMovementAndPosition(ctx, args.orgId, request.receiptMovementId);
        if (position._id !== request.positionId || movement.customerId !== request.customerId) {
          refuse("RETAINED_CREDIT_REFUND_NOT_FOUND");
        }
        await requireReceiptPosted(ctx, movement);
        const { availableMinor } = await availableRetainedCreditMinor(ctx, args.orgId, position, request._id);
        if (request.amountMinor > availableMinor) {
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

/**
 * SCRUM-724 Sol 6 Q3: the audited exit for an open request. Withdraws a PENDING
 * request (the requester included) or cancels an APPROVED one, always with a
 * reason, by any MANAGE_FINANCE user. Deliberately NOT behind the payout switch:
 * it moves no money and is how an operator releases a hold while payout is off.
 *
 * Releasing the hold is the status change itself (`openRefundRequestMinor` counts
 * only PENDING + APPROVED), so release is atomic with the audit fields. EXECUTED
 * (money already paid) and REJECTED are terminal and refused. A retry on an
 * already-CANCELLED request is a no-op that keeps the original audit.
 */
export const cancelRetainedCreditRefund = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("retainedCreditRefundRequests"),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"retainedCreditRefundRequests">> => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const request = await ctx.db.get(args.requestId);
    if (!request || request.orgId !== args.orgId) refuse("RETAINED_CREDIT_REFUND_NOT_FOUND");
    const reason = args.reason.trim();
    if (reason.length === 0 || reason.length > REASON_MAX) {
      refuse("RETAINED_CREDIT_REFUND_CANCEL_REASON_REQUIRED");
    }
    if (request.status === "CANCELLED") return request._id;
    if (request.status !== "PENDING" && request.status !== "APPROVED") {
      refuse("RETAINED_CREDIT_REFUND_NOT_CANCELLABLE");
    }
    const now = Date.now();
    await ctx.db.patch(request._id, {
      status: "CANCELLED",
      cancelledBy: user._id,
      cancelledAt: now,
      cancelReason: reason,
      cancelledFromStatus: request.status,
      updatedAt: now,
    });
    return request._id;
  },
});

/** Refund requests for the approvals / credit screens, newest first. */
export const listRetainedCreditRefundRequests = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.union(
      v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED"), v.literal("EXECUTED"),
      v.literal("CANCELLED")
    )),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
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
        // The backend refuses self-approval; the UI uses this to not offer it.
        requestedByMe: row.requestedBy === user._id,
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : undefined,
        sourceChequeLabel: cheque && cheque.orgId === args.orgId
          ? `${cheque.bank} #${cheque.chequeNumber}` : undefined,
        originatingSaleId: position?.originatingSaleId,
        originatingSaleStatus: sale && sale.orgId === args.orgId ? sale.status : undefined,
      };
    }));
  },
});

/**
 * SCRUM-831: the manager's retained-credit refund approval queue. A default MANAGER
 * holds `approve:requests` but not `view:finance`, so the finance listing above is
 * closed to the person who has to decide. This is a separate, narrow read: PENDING
 * requests only, and only what a decider needs to judge them (no position,
 * movement, payment or user ids, no decision, idempotency or audit fields).
 * Deciding stays `respondToRetainedCreditRefund` (different actor enforced there);
 * execute and cancel stay with MANAGE_FINANCE. `payoutAvailable` rides on every row
 * (the paginated client hook keeps only the rows) because approval is refused while
 * the pilot payout switch is on.
 *
 * Cursor-paginated, newest first, so every PENDING request is reachable: a fixed
 * `take(100)` silently hid the 101st and later. `numItems` is capped because each
 * row costs several point reads; the cap bounds the first page a caller requests.
 * It makes no claim about a loaded-page replay, which Convex re-runs with the
 * page's own end cursor.
 */
export const listRetainedCreditRefundApprovalQueue = query({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const requested = Number.isNaN(args.paginationOpts.numItems)
      ? APPROVAL_QUEUE_DEFAULT_PAGE
      : Math.floor(args.paginationOpts.numItems);
    const numItems = Math.min(Math.max(1, requested), APPROVAL_QUEUE_MAX_PAGE);
    const result = await ctx.db.query("retainedCreditRefundRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .order("desc")
      .paginate({ ...args.paginationOpts, numItems });
    const payoutAvailable = !isCustomerCreditPayoutDisabled();
    const page = await Promise.all(result.page.map(async (row) => {
      const [position, customer, requester] = await Promise.all([
        ctx.db.get(row.positionId),
        ctx.db.get(row.customerId),
        ctx.db.get(row.requestedBy),
      ]);
      const cheque = position?.sourceChequeId ? await ctx.db.get(position.sourceChequeId) : null;
      const sale = position?.originatingSaleId ? await ctx.db.get(position.originatingSaleId) : null;
      return {
        _id: row._id,
        amountMinor: row.amountMinor,
        currency: row.currency,
        method: row.method,
        reason: row.reason,
        createdAt: row.createdAt,
        payoutAvailable,
        requestedByMe: row.requestedBy === user._id,
        requestedByName: requester?.name,
        customerName: customer && customer.orgId === args.orgId
          ? `${customer.firstName} ${customer.lastName}`.trim() : undefined,
        sourceChequeLabel: cheque && cheque.orgId === args.orgId
          ? `${cheque.bank} #${cheque.chequeNumber}` : undefined,
        originatingSaleStatus: sale && sale.orgId === args.orgId ? sale.status : undefined,
      };
    }));
    return { ...result, page };
  },
});
