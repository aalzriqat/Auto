import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isMinorAmount } from "./financingEconomics";

function invalidShowroomReturn(): never {
  throw new ConvexError("Review the payment records and verify the posted dealership refund before applying this correction.");
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

  const [receipt, refunds, events, application, allocation] = await Promise.all([
    ctx.db.get(deposit.canonicalPaymentId),
    ctx.db.query("canonicalPayments")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", "deposit_refund_" + depositId))
      .take(2),
    ctx.db.query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", "deposit_refunded_" + depositId))
      .take(2),
    ctx.db.query("depositApplications").withIndex("by_deposit", (q) => q.eq("depositId", depositId)).first(),
    ctx.db.query("depositVehicleHolds").withIndex("by_deposit", (q) => q.eq("depositId", depositId)).first(),
  ]);
  const [refund] = refunds;
  const [event] = events;
  if (
    application || allocation ||
    !receipt || receipt.orgId !== orgId || receipt.customerId !== customerId ||
    receipt.direction !== "IN" || receipt.payerType !== "CUSTOMER" || receipt.status !== "SETTLED" ||
    receipt.reversalPaymentId !== undefined || receipt.amountMinor !== amountMinor || receipt.currency !== currency ||
    receipt.idempotencyKey !== "deposit_received_" + depositId ||
    receipt.receivedAt === undefined || !Number.isSafeInteger(receipt.receivedAt) || receipt.receivedAt > resolvedAt ||
    refunds.length !== 1 || !refund || refund.customerId !== customerId || refund.direction !== "OUT" ||
    refund.payerType !== "CUSTOMER" || refund.status !== "SETTLED" || refund.method !== "CASH" ||
    refund.amountMinor !== amountMinor || refund.currency !== currency || refund.receivedAt !== resolvedAt ||
    refund.createdBy !== deposit.resolvedBy || refund.reversalPaymentId !== undefined ||
    events.length !== 1 || !event || event.eventType !== "DEPOSIT_REFUNDED" ||
    event.sourceType !== "deposits" || event.sourceId !== depositId || event.eventVersion !== 1 ||
    event.currency !== currency || event.createdBy !== deposit.resolvedBy || event.occurredAt !== resolvedAt ||
    event.status !== "POSTED" || event.reversedByEventId !== undefined || !event.journalEntryId
  ) invalidShowroomReturn();

  const payload: unknown = event.payload;
  if (
    typeof payload !== "object" || payload === null ||
    !("depositId" in payload) || payload.depositId !== depositId ||
    !("customerId" in payload) || payload.customerId !== customerId ||
    !("amountMinor" in payload) || payload.amountMinor !== amountMinor ||
    !("currency" in payload) || payload.currency !== currency ||
    !("paymentMethod" in payload) || payload.paymentMethod !== refund.method
  ) invalidShowroomReturn();

  const journal = await ctx.db.get(event.journalEntryId);
  if (
    !journal || journal.orgId !== orgId || journal.accountingEventId !== event._id ||
    journal.status !== "POSTED" || journal.reversedByJournalEntryId !== undefined
  ) invalidShowroomReturn();

  return { depositId, refundId: refund._id, journalEntryId: journal._id, amountMinor, currency, refundedAt: resolvedAt };
}

type ShowroomRefundProof = Awaited<ReturnType<typeof readIdentityCorrectionShowroomRefund>>;

export function identityCorrectionReceiptStamp(
  payment: Doc<"customerFinanceCompanyPayments">,
  showroomRefund?: ShowroomRefundProof,
): string {
  return JSON.stringify([
    payment._id, payment.status, payment.sourceIdentity, payment.amountMinor, payment.currency,
    payment.paidAt, payment.confirmedAt, payment.firstPayment?.kind, payment.firstPayment?.attribution,
    ...(showroomRefund ? [[showroomRefund.depositId, showroomRefund.refundId, showroomRefund.journalEntryId,
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
