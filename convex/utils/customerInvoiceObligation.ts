import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { saleCompletedKey } from "../accounting/postingRules";
import { outstandingFromReceivableDoc, receivableOutstandingFromRows } from "../subledger";
import type { ObligationState } from "./financingEconomics";

/**
 * The customer-invoice judgement together with what is still owed on it, from the
 * SAME reads, so the state a cockpit gates on and the amount it names cannot
 * diverge. `outstandingMinor` is a number only when the state is OPEN or CLOSED;
 * an unproven (UNKNOWN) or not-yet-existing (NONE) invoice names no amount, so it
 * is `null`.
 */
export type CustomerInvoicePosition = { state: ObligationState; outstandingMinor: number | null };

/**
 * The cockpit's `customerInvoice` shape, shared by the financed and the cash
 * cockpit so the two cannot spell it differently. The amount is `null` unless the
 * invoice is proven (OPEN or CLOSED).
 */
export function toCockpitCustomerInvoice(
  position: CustomerInvoicePosition,
  currency: string
): { state: ObligationState; outstandingMinor: number | null; currency: string } {
  return { state: position.state, outstandingMinor: position.outstandingMinor, currency };
}

/**
 * Is this sale's canonical customer invoice paid? The ONE judgement the financed
 * cockpit and the cash cockpit share (SCRUM-571 D-43), so no reader can call a
 * sale settled while its customer still owes on it. It returns the state together
 * with what is still owed, from the same reads.
 *
 * Fails closed: UNKNOWN, never CLOSED, unless the sale is this organization's,
 * names a canonical invoice that exists in the same organization and currency,
 * is an INVOICE owed by the CUSTOMER and sourced from THIS sale, and the sale's
 * SALE_COMPLETED event and journal are POSTED. A zero balance on a receivable
 * that was never (or is no longer) on the books proves nothing about the money.
 *
 * A zero-value invoice is exempt from the posting proof: it recognised nothing,
 * so a zero-margin sale posts no event at all.
 *
 * The posting proof is required exactly when the sale was completed under a
 * general ledger (SCRUM-571 D-48). A Free/Starter organization has no chart, so
 * its SALE_COMPLETED is only queued and can never post; demanding the proof there
 * would hold every paid sale UNKNOWN forever. `glPostingRequired` is the chart
 * state snapshotted AT COMPLETION: `false` waives the proof, `true` and absent
 * (a legacy row) require it. It is never re-derived from the current chart or
 * plan, so a later upgrade cannot flip an old paid no-GL sale to UNKNOWN.
 */
export async function resolveCustomerInvoicePosition(
  ctx: QueryCtx,
  sale: Doc<"sales"> | null | undefined,
  scope: { orgId: Id<"organizations">; currency: string }
): Promise<CustomerInvoicePosition> {
  const unknown: CustomerInvoicePosition = { state: "UNKNOWN", outstandingMinor: null };
  const receivableId = sale?.canonicalReceivableDocumentId;
  if (!sale || sale.orgId !== scope.orgId || !receivableId) return unknown;
  const receivable = await ctx.db.get(receivableId);
  if (!invoiceBelongsToSale(sale, scope, receivable)) {
    return unknown;
  }
  // The posting proof and the allocations are independent reads off the same
  // receivable, so they run together. The proof is still enforced before the
  // balance is trusted: a failed proof returns UNKNOWN whatever the balance is.
  const postingRequired = invoiceRequiresPosting(sale, receivable);
  const [postingProven, outstandingMinor] = await Promise.all([
    postingRequired ? saleCompletedPostingIsPosted(ctx, sale) : Promise.resolve(true),
    outstandingFromReceivableDoc(ctx, receivable),
  ]);
  if (!postingProven) return unknown;
  return positionForBalance(outstandingMinor);
}

function invoiceBelongsToSale(sale: Doc<"sales">, scope: { orgId: Id<"organizations">; currency: string },
  receivable: Doc<"receivableDocuments"> | null): receivable is Doc<"receivableDocuments"> {
  return receivable !== null && sale.orgId === scope.orgId && sale.canonicalReceivableDocumentId === receivable._id &&
    receivable.orgId === scope.orgId && receivable.currency === scope.currency && receivable.documentType === "INVOICE" &&
    receivable.payerType === "CUSTOMER" && receivable.sourceType === "sales" && receivable.sourceId === sale._id.toString();
}

function positionForBalance(outstandingMinor: number): CustomerInvoicePosition {
  return { state: outstandingMinor > 0 ? "OPEN" : "CLOSED", outstandingMinor: Math.max(0, outstandingMinor) };
}

function invoiceRequiresPosting(sale: Doc<"sales">, receivable: Doc<"receivableDocuments">): boolean {
  return sale.glPostingRequired !== false && receivable.originalAmountMinor !== 0;
}

/** The sale's own SALE_COMPLETED event stands POSTED, with a POSTED journal of this organization. */
async function saleCompletedPostingIsPosted(ctx: QueryCtx, sale: Doc<"sales">): Promise<boolean> {
  const event = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", sale.orgId).eq("idempotencyKey", saleCompletedKey(sale._id)))
    .first();
  const journal = event?.journalEntryId ? await ctx.db.get(event.journalEntryId) : null;
  return salePostingEvidenceIsPosted(sale, event, journal);
}

function salePostingEvidenceIsPosted(sale: Doc<"sales">, event: Doc<"accountingEvents"> | null, journal: Doc<"journalEntries"> | null): boolean {
  return (
    event?.status === "POSTED" &&
    event.eventType === "SALE_COMPLETED" &&
    event.sourceType === "sales" &&
    event.sourceId === sale._id.toString() &&
    journal?.orgId === sale.orgId &&
    journal.status === "POSTED" &&
    journal.accountingEventId === event._id
  );
}

/** Pure projection of the same canonical invoice and posting proof for a batch reader. */
export function customerInvoicePositionFromRows(args: {
  sale: Doc<"sales">;
  scope: { orgId: Id<"organizations">; currency: string };
  receivable: Doc<"receivableDocuments"> | null;
  event: Doc<"accountingEvents"> | null;
  journal: Doc<"journalEntries"> | null;
  allocations: Doc<"paymentAllocations">[];
}): CustomerInvoicePosition {
  const { sale, scope, receivable, event, journal, allocations } = args;
  if (!invoiceBelongsToSale(sale, scope, receivable) ||
    (invoiceRequiresPosting(sale, receivable) && !salePostingEvidenceIsPosted(sale, event, journal))) {
    return { state: "UNKNOWN", outstandingMinor: null };
  }
  const outstandingMinor = receivableOutstandingFromRows(receivable, allocations);
  return positionForBalance(outstandingMinor);
}
