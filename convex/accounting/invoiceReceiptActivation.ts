import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { saleCompletedKey } from "./postingRules";
import { rehydrateReceiptOccurrence } from "./receiptOccurrence";
import { findPostedReceiptOccurrence } from "./workflowHooks";

/** Verify the persisted claim and its two posting origins before any activation writes. */
export async function requirePostedInvoiceReceiptOrigins(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"invoiceReceiptApplications">
) {
  const application = await ctx.db.get(applicationId);
  if (!application || application.orgId !== orgId || application.status !== "PENDING") {
    throw new ConvexError("Pending invoice receipt application not found in this organization.");
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
    invoice.status === "CANCELLED" ||
    application.customerId !== sale.customerId ||
    movement.customerId !== sale.customerId || invoice.customerId !== sale.customerId ||
    application.currency.toUpperCase() !== movement.currency.toUpperCase() ||
    invoice.currency.toUpperCase() !== movement.currency.toUpperCase() ||
    movement.liabilityTreatment !== "UNAPPLIED_CUSTOMER_RECEIPTS" ||
    !Number.isSafeInteger(application.amountMinor) || application.amountMinor <= 0 ||
    application.allocationId !== undefined
  ) {
    throw new ConvexError("Pending application no longer matches this organization's completed sale invoice and receipt.");
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
    throw new ConvexError("The retained receipt is no longer a settled inbound collection.");
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
    throw new ConvexError("The receipt and its journal must be posted before invoice activation.");
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
    throw new ConvexError("The sale invoice's exact sale-completion journal must be posted before activation.");
  }
  return { application, movement, sale, invoice };
}
