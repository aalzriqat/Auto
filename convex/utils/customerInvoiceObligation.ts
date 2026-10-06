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
 *
 * The posting proof is required exactly when the sale was completed under a
 * general ledger (SCRUM-571 D-48). A Free/Starter organization has no chart, so
 * its SALE_COMPLETED is only queued and can never post; demanding the proof there
 * would hold every paid sale UNKNOWN forever. `glPostingRequired` is the chart
 * state snapshotted AT COMPLETION: `false` waives the proof, `true` and absent
 * (a legacy row) require it. It is never re-derived from the current chart or
 * plan, so a later upgrade cannot flip an old paid no-GL sale to UNKNOWN.
 */
export async function resolveCustomerInvoiceObligation(
  ctx: QueryCtx,
  sale: Doc<"sales"> | null | undefined,
  scope: { orgId: Id<"organizations">; currency: string }
): Promise<ObligationState> {
  return (await resolveCustomerInvoicePosition(ctx, sale, scope)).state;
}

/**
 * The customer-invoice judgement together with what is still owed on it, from the
 * SAME reads, so the state a cockpit gates on and the amount it names cannot
 * diverge. `outstandingMinor` is present only when the state is OPEN or CLOSED
 * (an unproven invoice names no amount).
 */
export async function resolveCustomerInvoicePosition(
  ctx: QueryCtx,
  sale: Doc<"sales"> | null | undefined,
  scope: { orgId: Id<"organizations">; currency: string }
): Promise<CustomerInvoicePosition> {
  const unknown: CustomerInvoicePosition = { state: "UNKNOWN" };
  const receivableId = sale?.canonicalReceivableDocumentId;
  if (!sale || sale.orgId !== scope.orgId || !receivableId) return unknown;
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
    return unknown;
  }
  if (
    sale.glPostingRequired !== false &&
    receivable.originalAmountMinor !== 0 &&
    !(await saleCompletedPostingIsPosted(ctx, sale))
  ) {
    return unknown;
  }
  const outstandingMinor = await getReceivableOutstandingMinor(ctx, receivableId);
  return { state: outstandingMinor > 0 ? "OPEN" : "CLOSED", outstandingMinor: Math.max(0, outstandingMinor) };
}

export type CustomerInvoicePosition = { state: ObligationState; outstandingMinor?: number };

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
