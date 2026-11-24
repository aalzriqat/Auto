import { ConvexError } from "convex/values";
import { z } from "zod";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isMinorAmount } from "./financingEconomics";

function invalidShowroomReturn(): never {
  throw new ConvexError("Review the payment records and verify the posted dealership refund before applying this correction.");
}

const cashDepositPostingPayload = z.object({
  depositId: z.string(),
  customerId: z.string(),
  amountMinor: z.number(),
  currency: z.string(),
  paymentMethod: z.literal("CASH"),
  bankAccountId: z.never().optional(),
  holdId: z.never().optional(),
});

async function readCashDepositPosting(
  ctx: QueryCtx,
  events: Doc<"accountingEvents">[],
  eventType: "DEPOSIT_RECEIVED" | "DEPOSIT_REFUNDED",
  deposit: Doc<"deposits">,
  payment: Doc<"canonicalPayments">,
) {
  const [event] = events;
  if (
    events.length !== 1 || !event || event.eventType !== eventType ||
    event.sourceType !== "deposits" || event.sourceId !== deposit._id || event.eventVersion !== 1 ||
    event.currency !== deposit.currency || event.createdBy !== payment.createdBy ||
    event.occurredAt !== payment.receivedAt || event.status !== "POSTED" ||
    event.reversedByEventId !== undefined || event.reversalOfEventId !== undefined || !event.journalEntryId
  ) invalidShowroomReturn();

  const payload = cashDepositPostingPayload.safeParse(event.payload);
  if (
    !payload.success ||
    payload.data.depositId !== deposit._id ||
    payload.data.customerId !== deposit.customerId ||
    payload.data.amountMinor !== deposit.amountMinor ||
    payload.data.currency !== deposit.currency
  ) invalidShowroomReturn();

  const journal = await ctx.db.get(event.journalEntryId);
  if (
    !journal || journal.orgId !== deposit.orgId || journal.accountingEventId !== event._id ||
    journal.status !== "POSTED" || journal.reversedByJournalEntryId !== undefined ||
    journal.reversalOfJournalEntryId !== undefined
  ) invalidShowroomReturn();

  return { eventId: event._id, journalEntryId: journal._id };
}

export async function readIdentityCorrectionShowroomRefund(
  ctx: QueryCtx,
  quote: Doc<"quotes">,
  deposit: Doc<"deposits">,
) {
  const { orgId, customerId } = quote;
  const { _id: depositId, amountMinor, currency, resolvedAt } = deposit;
  if (
    deposit.orgId !== orgId ||
    deposit.quoteId !== quote._id ||
    deposit.customerId !== customerId ||
    deposit.vehicleId !== quote.vehicleId ||
    deposit.method !== "CASH" ||
    deposit.status !== "REFUNDED" ||
    deposit.holdActive ||
    deposit.isDeleted ||
    deposit.reservationId !== undefined ||
    deposit.resolutionSaleId !== undefined ||
    deposit.releaseCount !== 1 ||
    amountMinor === undefined || !isMinorAmount(amountMinor) || amountMinor === 0 ||
    deposit.releasedAmountMinor !== amountMinor ||
    deposit.refundedAmountMinor !== amountMinor ||
    (deposit.forfeitedAmountMinor ?? 0) !== 0 ||
    !currency ||
    !deposit.canonicalPaymentId ||
    !deposit.resolvedBy || deposit.resolvedBy === deposit.createdBy ||
    resolvedAt === undefined || !Number.isSafeInteger(resolvedAt) ||
    resolvedAt < deposit.createdAt || resolvedAt > Date.now()
  ) invalidShowroomReturn();

  const receiptKey = "deposit_received_" + depositId;
  const [receipt, refunds, receiptEvents, refundEvents, application, allocation] = await Promise.all([
    ctx.db.get(deposit.canonicalPaymentId),
    ctx.db.query("canonicalPayments")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", "deposit_refund_" + depositId))
      .take(2),
    ctx.db.query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", receiptKey))
      .take(2),
    ctx.db.query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", "deposit_refunded_" + depositId))
      .take(2),
    ctx.db.query("depositApplications").withIndex("by_deposit", (q) => q.eq("depositId", depositId)).first(),
    ctx.db.query("depositVehicleHolds").withIndex("by_deposit", (q) => q.eq("depositId", depositId)).first(),
  ]);
  const [refund] = refunds;
  if (
    application || allocation ||
    !receipt || receipt.orgId !== orgId || receipt.customerId !== customerId ||
    receipt.direction !== "IN" || receipt.payerType !== "CUSTOMER" || receipt.status !== "SETTLED" ||
    receipt.method !== "CASH" || receipt.createdBy !== deposit.createdBy ||
    receipt.reversalPaymentId !== undefined || receipt.amountMinor !== amountMinor || receipt.currency !== currency ||
    receipt.idempotencyKey !== receiptKey ||
    receipt.receivedAt === undefined || !Number.isSafeInteger(receipt.receivedAt) || receipt.receivedAt > resolvedAt ||
    refunds.length !== 1 || !refund || refund.customerId !== customerId || refund.direction !== "OUT" ||
    refund.payerType !== "CUSTOMER" || refund.status !== "SETTLED" || refund.method !== "CASH" ||
    refund.amountMinor !== amountMinor || refund.currency !== currency || refund.receivedAt !== resolvedAt ||
    refund.createdBy !== deposit.resolvedBy || refund.reversalPaymentId !== undefined
  ) invalidShowroomReturn();

  const [receiptPosting, refundPosting] = await Promise.all([
    readCashDepositPosting(ctx, receiptEvents, "DEPOSIT_RECEIVED", deposit, receipt),
    readCashDepositPosting(ctx, refundEvents, "DEPOSIT_REFUNDED", deposit, refund),
  ]);

  return { depositId, refundId: refund._id, receiptPosting, refundPosting, amountMinor, currency, refundedAt: resolvedAt };
}

type ShowroomRefundProof = Awaited<ReturnType<typeof readIdentityCorrectionShowroomRefund>>;

export function identityCorrectionReceiptStamp(
  payment: Doc<"customerFinanceCompanyPayments">,
  showroomRefund?: ShowroomRefundProof,
): string {
  return JSON.stringify([
    payment._id, payment.status, payment.sourceIdentity, payment.amountMinor, payment.currency,
    payment.paidAt, payment.confirmedAt, payment.firstPayment?.kind, payment.firstPayment?.attribution,
    ...(showroomRefund ? [[showroomRefund.depositId, showroomRefund.refundId,
      showroomRefund.receiptPosting.eventId, showroomRefund.receiptPosting.journalEntryId,
      showroomRefund.refundPosting.eventId, showroomRefund.refundPosting.journalEntryId,
      showroomRefund.amountMinor, showroomRefund.currency, showroomRefund.refundedAt]] : []),
  ]);
}

export function summarizeIdentityLenderReturn(
  payment: Doc<"customerFinanceCompanyPayments">,
  showroomRefund?: ShowroomRefundProof,
) {
  const { _id: paymentId, amountMinor, currency, paidAt, reference } = payment;
  return {
    originalReceipt: { paymentId, amountMinor, currency, paidAt, reference,
      receiptStamp: identityCorrectionReceiptStamp(payment, showroomRefund) },
    ...(showroomRefund ? { showroomRefund: { amountMinor: showroomRefund.amountMinor, refundedAt: showroomRefund.refundedAt } } : {}),
  };
}
