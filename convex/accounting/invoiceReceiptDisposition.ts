import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { createCanonicalPayment } from "../subledger";
import { postAccountingEvent } from "./postingEngine";
import { loadRetainedPosition } from "./receiptMovement";
import {
  assertCustomerCreditPayoutAllowed,
  assertCustomerCreditPayoutMethodSupported,
} from "../utils/customerCreditPayoutContainment";
import {
  reverseActiveInvoiceReceiptApplications,
  type ActiveInvoiceUnwind,
} from "./invoiceReceiptActivation";

type CustomerPayout = {
  amountMinor: number;
  method: "BANK_TRANSFER" | "CASH";
  reference: string;
  paidAt: number;
};

/**
 * Move a sale's proven ACTIVE invoice credit back out of AR. Each application
 * ends either in the existing 2110 position or in a separately evidenced
 * customer payout. A partial refund leaves the rest as spendable credit.
 * Every refusal escapes the caller's single Convex mutation.
 */
export async function disposeActiveSaleInvoiceReceipts(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applications: readonly ActiveInvoiceUnwind[];
    disposition: "REFUND" | "RETAIN_CREDIT";
    payout?: CustomerPayout;
    actorId: Id<"users">;
    reason: string;
    now: number;
  }
): Promise<{
  refundedMinor: number;
  retainedMinor: number;
  paymentIds: Id<"canonicalPayments">[];
  eventIds: Id<"accountingEvents">[];
}> {
  const totalMinor = args.applications.reduce((sum, row) => sum + row.application.amountMinor, 0);
  if (!Number.isSafeInteger(totalMinor)) throw new ConvexError("Active customer receipt total is invalid.");
  const payout = args.payout;
  // SCRUM-724 / SCRUM-795 c22479 + Sol Q7: the shared payout boundary. Every door
  // that can pay a customer out funnels here, so the pilot refusal lives here as
  // well as at each public door. It runs before any write.
  if ((args.disposition === "REFUND" && totalMinor > 0) || payout !== undefined) {
    assertCustomerCreditPayoutAllowed();
  }
  if (payout !== undefined) assertCustomerCreditPayoutMethodSupported(payout.method);
  if (args.disposition === "REFUND" && totalMinor > 0) {
    if (!payout || !Number.isSafeInteger(payout.amountMinor) || payout.amountMinor <= 0 ||
        payout.amountMinor > totalMinor ||
        (payout.method !== "BANK_TRANSFER" && payout.method !== "CASH") ||
        payout.reference.trim() === "" || payout.paidAt > args.now) {
      throw new ConvexError("Customer refund amount, method, date and reference are required.");
    }
  } else if (payout !== undefined) {
    throw new ConvexError("Customer payout details require an active refund.");
  }

  await reverseActiveInvoiceReceiptApplications(ctx, {
    orgId: args.orgId,
    applications: args.applications,
    actorId: args.actorId,
    reason: args.reason,
    reversalDate: args.now,
  });

  let refundRemaining = payout?.amountMinor ?? 0;
  let retainedMinor = 0;
  const paymentIds: Id<"canonicalPayments">[] = [];
  const eventIds: Id<"accountingEvents">[] = [];
  const rows = [...args.applications].sort((a, b) =>
    a.application._creationTime - b.application._creationTime ||
    String(a.application._id).localeCompare(String(b.application._id))
  );
  for (const { application, movement } of rows) {
    const refundMinor = Math.min(application.amountMinor, refundRemaining);
    const retainMinor = application.amountMinor - refundMinor;
    refundRemaining -= refundMinor;
    retainedMinor += retainMinor;
    if (retainMinor > 0) {
      const position = await loadRetainedPosition(ctx, args.orgId, movement._id);
      const nextMinor = position.remainingUnappliedMinor + retainMinor;
      if (!Number.isSafeInteger(nextMinor) || nextMinor > movement.initialUnappliedMinor) {
        throw new ConvexError("Restored customer credit exceeds its original receipt.");
      }
      await ctx.db.patch(position._id, { remainingUnappliedMinor: nextMinor, updatedAt: args.now });
    }
    if (refundMinor === 0 || !payout) continue;

    const paymentId = await createCanonicalPayment(ctx, {
      orgId: args.orgId,
      direction: "OUT",
      payerType: "CUSTOMER",
      customerId: application.customerId,
      method: payout.method,
      amountMinor: refundMinor,
      currency: application.currency,
      idempotencyKey: `invoice_receipt_refund_${application._id}`,
      actorId: args.actorId,
      status: "SETTLED",
      externalReference: payout.reference,
      receivedAt: payout.paidAt,
    });
    const payment = await ctx.db.get(paymentId);
    if (!payment || payment.orgId !== args.orgId || payment.status !== "SETTLED" ||
        payment.direction !== "OUT" || payment.payerType !== "CUSTOMER" ||
        payment.customerId !== application.customerId ||
        payment.amountMinor !== refundMinor || payment.method !== payout.method ||
        payment.currency.toUpperCase() !== application.currency.toUpperCase() ||
        payment.externalReference !== payout.reference || payment.receivedAt !== payout.paidAt) {
      throw new ConvexError("Customer refund payment identity is already held by different money.");
    }
    const posted = await postAccountingEvent(ctx, {
      orgId: args.orgId,
      eventType: "RETAINED_CREDIT_REFUNDED",
      sourceType: "invoiceReceiptApplications",
      sourceId: `${application._id}:refund`,
      eventVersion: 1,
      accountingDate: args.now,
      occurredAt: payout.paidAt,
      currency: application.currency,
      idempotencyKey: `retained_credit_refunded_${application._id}`,
      payload: {
        applicationId: String(application._id), paymentId: String(paymentId),
        amountMinor: refundMinor, currency: application.currency,
        customerId: String(application.customerId), paymentMethod: payout.method,
      },
      actorId: args.actorId,
    });
    if (posted.alreadyPosted || !posted.eventId || !posted.journalEntryId) {
      throw new ConvexError("Customer refund did not post its own journal.");
    }
    const [event, journal] = await Promise.all([
      ctx.db.get(posted.eventId), ctx.db.get(posted.journalEntryId),
    ]);
    if (!event || event.orgId !== args.orgId || event.status !== "POSTED" ||
        event.eventType !== "RETAINED_CREDIT_REFUNDED" ||
        event.sourceType !== "invoiceReceiptApplications" ||
        event.sourceId !== `${application._id}:refund` ||
        !journal || journal.orgId !== args.orgId || journal.status !== "POSTED" ||
        journal.accountingEventId !== event._id) {
      throw new ConvexError("Customer refund journal is not posted.");
    }
    await ctx.db.patch(paymentId, { accountingEventId: posted.eventId });
    paymentIds.push(paymentId);
    eventIds.push(posted.eventId);
  }
  if (refundRemaining !== 0) throw new ConvexError("Customer refund could not be fully assigned.");
  return { refundedMinor: payout?.amountMinor ?? 0, retainedMinor, paymentIds, eventIds };
}
