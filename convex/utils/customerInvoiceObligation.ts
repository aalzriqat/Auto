import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { saleCompletedKey } from "../accounting/postingRules";
import { getReceivableOutstandingMinor } from "../subledger";
import type { ObligationState } from "./financingEconomics";

/**
 * Is this sale's canonical customer invoice paid? The ONE judgement the financed
 * cockpit and the cash cockpit share (SCRUM-571 D-43), so no reader can call a
 * sale settled while its customer still owes on it.
 *
 * Fails closed: UNKNOWN, never CLOSED, unless the sale is this organization's,
 * names a canonical invoice that exists in the same organization and currency,
 * is an INVOICE owed by the CUSTOMER and sourced from THIS sale, and the sale's
 * SALE_COMPLETED event and journal are POSTED. A zero balance on a receivable
 * that was never (or is no longer) on the books proves nothing about the money.
 *
 * A zero-value invoice is exempt from the posting proof: it recognised nothing,
 * so a zero-margin sale posts no event at all.
 */
export async function resolveCustomerInvoiceObligation(
  ctx: QueryCtx,
  sale: Doc<"sales"> | null | undefined,
  scope: { orgId: Id<"organizations">; currency: string }
): Promise<ObligationState> {
  const receivableId = sale?.canonicalReceivableDocumentId;
  if (!sale || sale.orgId !== scope.orgId || !receivableId) return "UNKNOWN";
  const receivable = await ctx.db.get(receivableId);
  if (
    !receivable ||
    receivable.orgId !== scope.orgId ||
    receivable.currency !== scope.currency ||
    receivable.documentType !== "INVOICE" ||
    receivable.payerType !== "CUSTOMER" ||
    receivable.sourceType !== "sales" ||
    receivable.sourceId !== sale._id.toString()
  ) {
    return "UNKNOWN";
  }
  if (receivable.originalAmountMinor !== 0 && !(await saleCompletedPostingIsPosted(ctx, sale))) {
    return "UNKNOWN";
  }
  const outstandingMinor = await getReceivableOutstandingMinor(ctx, receivableId);
  return outstandingMinor > 0 ? "OPEN" : "CLOSED";
}

/** The sale's own SALE_COMPLETED event stands POSTED, with a POSTED journal of this organization. */
async function saleCompletedPostingIsPosted(ctx: QueryCtx, sale: Doc<"sales">): Promise<boolean> {
  const event = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", sale.orgId).eq("idempotencyKey", saleCompletedKey(sale._id)))
    .first();
  const journal = event?.journalEntryId ? await ctx.db.get(event.journalEntryId) : null;
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
