import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { allocatePaymentToReceivable, getReceivableOutstandingMinor, reverseAllocation } from "../subledger";
import { postAccountingEvent } from "./postingEngine";
import { reverseAccountingEvent } from "./reversals";
import { saleCompletedKey } from "./postingRules";
import { pendingInvoiceReceiptMinor, pendingSaleInvoiceReceiptMinor } from "./invoiceReceiptReservation";
import { loadRetainedPosition, MAX_REVOCABLE_APPLICATIONS } from "./receiptMovement";
import { rehydrateReceiptOccurrence } from "./receiptOccurrence";
import { findPostedReceiptOccurrence } from "./workflowHooks";

export type InvoiceReceiptProofReason =
  | "CLAIM_CHANGED" | "RECEIPT_UNSETTLED" | "RECEIPT_UNPOSTED"
  | "SALE_UNPOSTED" | "BALANCE_CHANGED";

export class InvoiceReceiptProofError extends ConvexError<string> {
  constructor(readonly reason: InvoiceReceiptProofReason, message: string) {
    super(message);
  }
}

/** Verify the persisted claim and its two posting origins before any activation writes. */
export async function requirePostedInvoiceReceiptOrigins(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"invoiceReceiptApplications">
) {
  const application = await ctx.db.get(applicationId);
  if (!application || application.orgId !== orgId || application.status !== "PENDING") {
    throw new InvoiceReceiptProofError("CLAIM_CHANGED", "Pending invoice receipt application not found in this organization.");
  }
  const [movement, sale, invoice] = await Promise.all([
    ctx.db.get(application.receiptMovementId),
    ctx.db.get(application.saleId),
    ctx.db.get(application.receivableDocumentId),
  ]);
  if (
    !movement || movement.orgId !== orgId ||
    !sale || sale.orgId !== orgId || sale.status !== "COMPLETED" ||
    !invoice || invoice.orgId !== orgId ||
    sale.canonicalReceivableDocumentId !== invoice._id ||
    invoice.documentType !== "INVOICE" || invoice.payerType !== "CUSTOMER" ||
    invoice.sourceType !== "sales" || invoice.sourceId !== String(sale._id) ||
    (invoice.status !== "OPEN" && invoice.status !== "PARTIALLY_PAID") ||
    application.customerId !== sale.customerId ||
    movement.customerId !== sale.customerId || invoice.customerId !== sale.customerId ||
    application.currency.toUpperCase() !== movement.currency.toUpperCase() ||
    invoice.currency.toUpperCase() !== movement.currency.toUpperCase() ||
    movement.liabilityTreatment !== "UNAPPLIED_CUSTOMER_RECEIPTS" ||
    !Number.isSafeInteger(application.amountMinor) || application.amountMinor <= 0 ||
    application.allocationId !== undefined
  ) {
    throw new InvoiceReceiptProofError("CLAIM_CHANGED", "Pending application no longer matches this organization's completed sale invoice and receipt.");
  }

  const [collection, canonical] = await Promise.all([
    ctx.db.get(movement.collectionPaymentId),
    ctx.db.get(movement.canonicalPaymentId),
  ]);
  if (
    !collection || collection.orgId !== orgId || collection.status !== "POSTED" ||
    collection.direction !== "IN" || collection.canonicalPaymentId !== canonical?._id ||
    collection.customerId !== application.customerId ||
    !canonical || canonical.orgId !== orgId || canonical.direction !== "IN" ||
    canonical.status !== "SETTLED" || canonical.customerId !== application.customerId ||
    canonical.currency.toUpperCase() !== application.currency.toUpperCase()
  ) {
    throw new InvoiceReceiptProofError("RECEIPT_UNSETTLED", "The retained receipt is no longer a settled inbound collection.");
  }

  const receiptIdentity = rehydrateReceiptOccurrence({ orgId, snapshot: movement.occurrence });
  const receiptEvent = await findPostedReceiptOccurrence(ctx, receiptIdentity);
  const receiptJournal = receiptEvent?.journalEntryId ? await ctx.db.get(receiptEvent.journalEntryId) : null;
  if (
    !receiptEvent || receiptEvent.currency.toUpperCase() !== invoice.currency.toUpperCase() ||
    !receiptJournal || receiptJournal.orgId !== orgId ||
    receiptJournal.status !== "POSTED" || receiptJournal.accountingEventId !== receiptEvent._id ||
    receiptJournal.sourceType !== receiptEvent.sourceType || receiptJournal.sourceId !== receiptEvent.sourceId ||
    receiptJournal.currency?.toUpperCase() !== invoice.currency.toUpperCase()
  ) {
    throw new InvoiceReceiptProofError("RECEIPT_UNPOSTED", "The receipt and its journal must be posted before invoice activation.");
  }

  const saleEvent = await ctx.db.query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", saleCompletedKey(sale._id)))
    .unique();
  const saleJournal = saleEvent?.journalEntryId ? await ctx.db.get(saleEvent.journalEntryId) : null;
  if (
    !saleEvent || saleEvent.status !== "POSTED" ||
    saleEvent.eventType !== "SALE_COMPLETED" || saleEvent.eventVersion !== 1 ||
    saleEvent.sourceType !== "sales" ||
    saleEvent.sourceId !== String(sale._id) ||
    saleEvent.currency.toUpperCase() !== invoice.currency.toUpperCase() ||
    !saleJournal || saleJournal.orgId !== orgId || saleJournal.status !== "POSTED" ||
    saleJournal.accountingEventId !== saleEvent._id ||
    saleJournal.sourceType !== saleEvent.sourceType || saleJournal.sourceId !== saleEvent.sourceId ||
    saleJournal.currency?.toUpperCase() !== invoice.currency.toUpperCase()
  ) {
    throw new InvoiceReceiptProofError("SALE_UNPOSTED", "The sale invoice's exact sale-completion journal must be posted before activation.");
  }
  return { application, movement, sale, invoice };
}

type ActivationResult = {
  applicationId: Id<"invoiceReceiptApplications">;
  allocationId: Id<"paymentAllocations">;
  remainderApplicationId?: Id<"invoiceReceiptApplications">;
};

export type ActiveInvoiceUnwind = {
  application: Doc<"invoiceReceiptApplications">;
  movement: Doc<"receiptMovements">;
  allocationId: Id<"paymentAllocations">;
  eventId: Id<"accountingEvents">;
};

async function validateActiveInvoiceUnwind(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  movement: Doc<"receiptMovements">,
  application: Doc<"invoiceReceiptApplications">
): Promise<ActiveInvoiceUnwind> {
  const [allocation, event, invoice, sale, collection, payment] = await Promise.all([
    application.allocationId ? ctx.db.get(application.allocationId) : Promise.resolve(null),
    application.activationEventId ? ctx.db.get(application.activationEventId) : Promise.resolve(null),
    ctx.db.get(application.receivableDocumentId),
    ctx.db.get(application.saleId),
    ctx.db.get(movement.collectionPaymentId),
    ctx.db.get(movement.canonicalPaymentId),
  ]);
  const journal = event?.journalEntryId ? await ctx.db.get(event.journalEntryId) : null;
  if (
    movement.orgId !== orgId || application.orgId !== orgId || application.status !== "ACTIVE" ||
    application.receiptMovementId !== movement._id ||
    application.customerId !== movement.customerId ||
    application.currency.toUpperCase() !== movement.currency.toUpperCase() ||
    movement.liabilityTreatment !== "UNAPPLIED_CUSTOMER_RECEIPTS" ||
    !Number.isSafeInteger(application.amountMinor) || application.amountMinor <= 0 ||
    !sale || sale.orgId !== orgId || sale.customerId !== application.customerId ||
    sale.canonicalReceivableDocumentId !== application.receivableDocumentId ||
    !allocation || allocation.orgId !== orgId || allocation.status !== "ACTIVE" ||
    allocation.paymentId !== movement.canonicalPaymentId ||
    allocation.receivableDocumentId !== application.receivableDocumentId ||
    allocation.amountMinor !== application.amountMinor ||
    !invoice || invoice.orgId !== orgId || invoice.customerId !== application.customerId ||
    invoice.documentType !== "INVOICE" || invoice.payerType !== "CUSTOMER" ||
    invoice.currency.toUpperCase() !== application.currency.toUpperCase() ||
    invoice.sourceType !== "sales" || invoice.sourceId !== String(sale._id) ||
    !collection || collection.orgId !== orgId || collection.status !== "POSTED" ||
    collection.direction !== "IN" || collection.customerId !== application.customerId ||
    collection.canonicalPaymentId !== movement.canonicalPaymentId ||
    !payment || payment.orgId !== orgId || payment.status !== "SETTLED" ||
    payment.direction !== "IN" || payment.payerType !== "CUSTOMER" ||
    payment.customerId !== application.customerId ||
    payment.currency.toUpperCase() !== application.currency.toUpperCase() ||
    !event || event.orgId !== orgId || event.status !== "POSTED" ||
    event.eventType !== "RECEIPT_CREDIT_APPLIED" || event.eventVersion !== 1 ||
    event.sourceType !== "invoiceReceiptApplications" || event.sourceId !== String(application._id) ||
    !journal || journal.orgId !== orgId || journal.status !== "POSTED" ||
    journal.accountingEventId !== event._id || journal.sourceType !== event.sourceType ||
    journal.sourceId !== event.sourceId ||
    journal.currency?.toUpperCase() !== application.currency.toUpperCase()
  ) {
    throw new ConvexError("An active invoice receipt has incomplete return lineage.");
  }
  return { application, movement, allocationId: allocation._id, eventId: event._id };
}

/** Prove the complete ACTIVE invoice lineage before a returned cheque writes anything. */
export async function planActiveInvoiceReceiptReversal(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  movement: Doc<"receiptMovements">
): Promise<{ applications: ActiveInvoiceUnwind[]; totalMinor: number }> {
  if (movement.orgId !== orgId) {
    throw new ConvexError("Receipt movement does not belong to this organization.");
  }
  // A sale unwind may already have paid part of this receipt back to the
  // customer. Returning its original cheque without recovering that payout
  // would reverse the receipt twice in cash terms. Keep the return closed
  // until a dedicated recovery workflow can prove that money came back.
  const reversedRows = await ctx.db.query("invoiceReceiptApplications")
    .withIndex("by_org_movement_status", (q) => q.eq("orgId", orgId)
      .eq("receiptMovementId", movement._id).eq("status", "REVERSED"))
    .take(MAX_REVOCABLE_APPLICATIONS + 1);
  if (reversedRows.length > MAX_REVOCABLE_APPLICATIONS) {
    throw new ConvexError("This receipt has too many prior invoice reversals to return safely.");
  }
  for (const row of reversedRows) {
    const refund = await ctx.db.query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId)
        .eq("idempotencyKey", `retained_credit_refunded_${row._id}`))
      .unique();
    if (refund) {
      throw new ConvexError("This receipt has a customer payout. Recover and reconcile it before returning the original cheque.");
    }
  }
  const rows = await ctx.db.query("invoiceReceiptApplications")
    .withIndex("by_org_movement_status", (q) => q.eq("orgId", orgId)
      .eq("receiptMovementId", movement._id).eq("status", "ACTIVE"))
    .take(MAX_REVOCABLE_APPLICATIONS + 1);
  if (rows.length > MAX_REVOCABLE_APPLICATIONS) {
    throw new ConvexError("This receipt has too many active invoice applications to return in one transaction.");
  }

  const applications: ActiveInvoiceUnwind[] = [];
  let totalMinor = 0;
  for (const application of rows) {
    applications.push(await validateActiveInvoiceUnwind(ctx, orgId, movement, application));
    totalMinor += application.amountMinor;
  }
  if (!Number.isSafeInteger(totalMinor) || totalMinor > movement.initialUnappliedMinor) {
    throw new ConvexError("Active invoice credit exceeds the receipt's retained amount.");
  }
  return { applications, totalMinor };
}

/** Read-only sale plan shared by the unwind preview and its money mutation. */
export async function planSaleInvoiceReceiptReversal(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  sale: Doc<"sales">
): Promise<{ applications: ActiveInvoiceUnwind[]; totalMinor: number }> {
  if (sale.orgId !== orgId) throw new ConvexError("Sale does not belong to this organization.");
  const rows = await ctx.db.query("invoiceReceiptApplications")
    .withIndex("by_org_sale_status", (q) => q.eq("orgId", orgId)
      .eq("saleId", sale._id).eq("status", "ACTIVE"))
    .take(MAX_REVOCABLE_APPLICATIONS + 1);
  if (rows.length > MAX_REVOCABLE_APPLICATIONS) {
    throw new ConvexError("This sale has too many active invoice applications to unwind in one transaction.");
  }
  const applications: ActiveInvoiceUnwind[] = [];
  let totalMinor = 0;
  let currency: string | undefined;
  const movementTotals = new Map<string, number>();
  for (const row of rows) {
    const movement = await ctx.db.get(row.receiptMovementId);
    if (!movement || movement.orgId !== orgId || row.receivableDocumentId !== sale.canonicalReceivableDocumentId) {
      throw new ConvexError("An active invoice receipt has incomplete sale lineage.");
    }
    applications.push(await validateActiveInvoiceUnwind(ctx, orgId, movement, row));
    totalMinor += row.amountMinor;
    const rowCurrency = row.currency.toUpperCase();
    if (currency !== undefined && currency !== rowCurrency) {
      throw new ConvexError("A sale's active customer receipt applications use different currencies.");
    }
    currency = rowCurrency;
    const movementTotal = (movementTotals.get(String(movement._id)) ?? 0) + row.amountMinor;
    if (!Number.isSafeInteger(movementTotal) || movementTotal > movement.initialUnappliedMinor) {
      throw new ConvexError("Active invoice credit exceeds its original receipt.");
    }
    movementTotals.set(String(movement._id), movementTotal);
  }
  if (!Number.isSafeInteger(totalMinor)) throw new ConvexError("Active invoice amount is invalid.");
  return { applications, totalMinor };
}

/** Reverse each proven 2110-to-AR journal and its canonical allocation together. */
export async function reverseActiveInvoiceReceiptApplications(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applications: readonly ActiveInvoiceUnwind[];
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
): Promise<void> {
  for (const unwind of args.applications) {
    await reverseAccountingEvent(ctx, {
      orgId: args.orgId,
      originalEventId: unwind.eventId,
      reversalDate: args.reversalDate,
      reason: args.reason,
      actorId: args.actorId,
      idempotencyKey: `reversed_invoice_receipt_applied_${unwind.application._id}`,
    });
    await reverseAllocation(ctx, {
      orgId: args.orgId,
      allocationId: unwind.allocationId,
      actorId: args.actorId,
    });
    await ctx.db.patch(unwind.application._id, { status: "REVERSED" });
  }
}

async function readActiveReplay(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  application: Doc<"invoiceReceiptApplications">,
  amountMinor: number
): Promise<ActivationResult> {
  const [allocation, event] = await Promise.all([
    application.allocationId ? ctx.db.get(application.allocationId) : Promise.resolve(null),
    application.activationEventId ? ctx.db.get(application.activationEventId) : Promise.resolve(null),
  ]);
  const journal = event?.journalEntryId ? await ctx.db.get(event.journalEntryId) : null;
  if (
    application.amountMinor !== amountMinor || !allocation || allocation.orgId !== orgId ||
    allocation.status !== "ACTIVE" || allocation.receivableDocumentId !== application.receivableDocumentId ||
    allocation.amountMinor !== application.amountMinor || !event || event.orgId !== orgId ||
    event.status !== "POSTED" || event.eventType !== "RECEIPT_CREDIT_APPLIED" ||
    event.sourceType !== "invoiceReceiptApplications" || event.sourceId !== String(application._id) ||
    !journal || journal.orgId !== orgId || journal.status !== "POSTED" ||
    journal.accountingEventId !== event._id ||
    journal.sourceType !== event.sourceType || journal.sourceId !== event.sourceId ||
    journal.currency?.toUpperCase() !== application.currency.toUpperCase()
  ) {
    throw new ConvexError("This invoice receipt application cannot be replayed safely.");
  }
  return {
    applicationId: application._id,
    allocationId: allocation._id,
    remainderApplicationId: application.splitRemainderId,
  };
}

async function requireLiveActivationBalance(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    application: Doc<"invoiceReceiptApplications">;
    movement: Doc<"receiptMovements">;
    invoice: Doc<"receivableDocuments">;
    amountMinor: number;
  }
): Promise<Doc<"receiptRetainedPositions">> {
  const position = await loadRetainedPosition(ctx, args.orgId, args.movement._id);
  const [receiptReservedMinor, saleReservedMinor, outstandingMinor] = await Promise.all([
    pendingInvoiceReceiptMinor(ctx, args.orgId, args.movement._id),
    pendingSaleInvoiceReceiptMinor(ctx, args.orgId, args.application.saleId),
    getReceivableOutstandingMinor(ctx, args.invoice._id),
  ]);
  if (
    position.customerId !== args.application.customerId ||
    position.currency.toUpperCase() !== args.application.currency.toUpperCase() ||
    !Number.isSafeInteger(position.remainingUnappliedMinor) ||
    receiptReservedMinor > position.remainingUnappliedMinor ||
    saleReservedMinor > outstandingMinor ||
    args.amountMinor > outstandingMinor
  ) {
    throw new InvoiceReceiptProofError("BALANCE_CHANGED", "The retained credit or invoice balance no longer covers its pending claims.");
  }
  return position;
}

/** The operator preview uses the exact read-only guards the writer uses. */
export async function verifyPendingInvoiceReceiptActivation(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"invoiceReceiptApplications">
): Promise<boolean> {
  const { application, movement, invoice } = await requirePostedInvoiceReceiptOrigins(
    ctx, orgId, applicationId
  );
  await requireLiveActivationBalance(ctx, {
    orgId, application, movement, invoice, amountMinor: application.amountMinor,
  });
  return true;
}

async function postInvoiceReceiptApplication(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    application: Doc<"invoiceReceiptApplications">;
    movement: Doc<"receiptMovements">;
    invoice: Doc<"receivableDocuments">;
    amountMinor: number;
    actorId: Id<"users">;
    now: number;
  }
): Promise<Id<"accountingEvents">> {
  const posted = await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "RECEIPT_CREDIT_APPLIED",
    sourceType: "invoiceReceiptApplications",
    sourceId: String(args.application._id),
    eventVersion: 1,
    accountingDate: args.now,
    occurredAt: args.now,
    currency: args.application.currency,
    idempotencyKey: `invoice_receipt_applied_${args.application._id}`,
    payload: {
      receiptMovementId: String(args.movement._id),
      applicationId: String(args.application._id),
      sequence: 1,
      amountMinor: args.amountMinor,
      currency: args.application.currency,
      customerId: String(args.application.customerId),
      receivableDocumentId: String(args.invoice._id),
    },
    actorId: args.actorId,
  });
  if (posted.alreadyPosted || !posted.eventId || !posted.journalEntryId) {
    throw new ConvexError("The invoice receipt application could not post its own journal.");
  }
  const [event, journal] = await Promise.all([
    ctx.db.get(posted.eventId),
    ctx.db.get(posted.journalEntryId),
  ]);
  if (
    !event || event.orgId !== args.orgId || event.status !== "POSTED" ||
    event.eventType !== "RECEIPT_CREDIT_APPLIED" ||
    event.sourceType !== "invoiceReceiptApplications" || event.sourceId !== String(args.application._id) ||
    !journal || journal.orgId !== args.orgId || journal.status !== "POSTED" ||
    journal.accountingEventId !== event._id ||
    journal.sourceType !== event.sourceType || journal.sourceId !== event.sourceId ||
    journal.currency?.toUpperCase() !== args.application.currency.toUpperCase()
  ) {
    throw new ConvexError("The invoice receipt journal did not reach POSTED state.");
  }
  return event._id;
}

/**
 * Dark SCRUM-722 writer. No registered mutation calls this until SCRUM-723's
 * ACTIVE reversal exits and SCRUM-724's operator flow are in the same cutover.
 * Every refusal escapes: in Convex a caught exception would commit earlier writes.
 */
export async function activatePendingInvoiceReceipt(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"invoiceReceiptApplications">;
    amountMinor: number;
    actorId: Id<"users">;
  }
): Promise<ActivationResult> {
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new ConvexError("An invoice receipt activation must use a positive minor-unit amount.");
  }
  const row = await ctx.db.get(args.applicationId);
  if (!row || row.orgId !== args.orgId) {
    throw new ConvexError("Invoice receipt application not found in this organization.");
  }
  if (row.status === "ACTIVE") {
    return readActiveReplay(ctx, args.orgId, row, args.amountMinor);
  }
  const { application, movement, invoice } = await requirePostedInvoiceReceiptOrigins(
    ctx, args.orgId, args.applicationId
  );
  if (args.amountMinor > application.amountMinor) {
    throw new ConvexError("Activation exceeds the reserved receipt amount.");
  }
  const position = await requireLiveActivationBalance(ctx, {
    orgId: args.orgId, application, movement, invoice, amountMinor: args.amountMinor,
  });

  const allocationId = await allocatePaymentToReceivable(ctx, {
    orgId: args.orgId,
    paymentId: movement.canonicalPaymentId,
    receivableDocumentId: invoice._id,
    amountMinor: args.amountMinor,
    actorId: args.actorId,
  });
  const now = Date.now();
  const activationEventId = await postInvoiceReceiptApplication(ctx, {
    orgId: args.orgId, application, movement, invoice,
    amountMinor: args.amountMinor, actorId: args.actorId, now,
  });

  let remainderApplicationId: Id<"invoiceReceiptApplications"> | undefined;
  const remainderMinor = application.amountMinor - args.amountMinor;
  if (remainderMinor > 0) {
    remainderApplicationId = await ctx.db.insert("invoiceReceiptApplications", {
      orgId: args.orgId,
      receiptMovementId: movement._id,
      saleId: application.saleId,
      receivableDocumentId: invoice._id,
      customerId: application.customerId,
      currency: application.currency,
      amountMinor: remainderMinor,
      status: "PENDING",
      splitFromApplicationId: application._id,
      createdBy: args.actorId,
      createdAt: now,
    });
  }
  await ctx.db.patch(position._id, {
    remainingUnappliedMinor: position.remainingUnappliedMinor - args.amountMinor,
    updatedAt: now,
  });
  await ctx.db.patch(application._id, {
    amountMinor: args.amountMinor,
    status: "ACTIVE",
    allocationId,
    activationEventId,
    activatedAt: now,
    splitRemainderId: remainderApplicationId,
  });
  return { applicationId: application._id, allocationId, remainderApplicationId };
}
