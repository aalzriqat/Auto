import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { saleCompletedKey } from "../accounting/postingRules";

/** Convex allows 4,096 index-range reads (db.get and db.query calls) per function (docs.convex.dev/production/state/limits). */
export const MAX_FUNCTION_DB_CALLS = 4096;
/**
 * Calls the report cannot count from here: the rate-limiter component's own reads and any helper a caller adds later.
 * Whether component reads count toward the host function's limit is not stated in the docs, so they are covered here.
 */
export const QUERY_CALL_RESERVE = 32;

type ChunkedRead = <I, D>(ids: I[], read: (id: I) => Promise<D>) => Promise<D[]>;

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export type SettlementEvidenceArgs = {
  orgId: Id<"organizations">;
  invoiceIds: Id<"receivableDocuments">[];
  /** Sales whose canonical invoice is read: only these can use their SALE_COMPLETED event. */
  saleIds: Id<"sales">[];
  /**
   * Every db.get and db.query call the WHOLE query function makes apart from the per-key evidence reads: the caller's
   * own, and this loader's vehicles, applications, child ranges, invoices, journals and quotes.
   */
  callsBeforeEvidence: number;
  remainingRows: () => number;
  accept: <T>(rows: T[]) => T[];
  readInChunks: ChunkedRead;
};

/**
 * The deal page reads, per sale, the FIRST event under its exact SALE_COMPLETED key and, per invoice, every
 * `by_receivable` allocation of that invoice. Do the same, so the cost follows this report's pending rows and not the
 * organization's lifetime sale history or other tenants' allocations.
 *
 * Per-key reads cost one index range each; a report with so many pending rows that they would pass the per-function
 * limit falls back to one range per table, which is bounded by the shared row budget instead.
 */
export async function readSettlementEvidence(ctx: QueryCtx, args: SettlementEvidenceArgs): Promise<{
  allocationsByInvoice: Map<Id<"receivableDocuments">, Doc<"paymentAllocations">[]>;
  firstEvents: Map<string, Doc<"accountingEvents">>;
  strategy: "PER_KEY" | "RANGE" | "NONE";
}> {
  const { orgId, invoiceIds, saleIds, remainingRows, accept, readInChunks } = args;
  const allocationsByInvoice = new Map<Id<"receivableDocuments">, Doc<"paymentAllocations">[]>();
  const firstEvents = new Map<string, Doc<"accountingEvents">>();
  const addAllocations = (rows: Doc<"paymentAllocations">[]) => {
    for (const row of rows) {
      const group = allocationsByInvoice.get(row.receivableDocumentId) ?? [];
      group.push(row);
      allocationsByInvoice.set(row.receivableDocumentId, group);
    }
  };
  if (invoiceIds.length === 0) return { allocationsByInvoice, firstEvents, strategy: "NONE" };
  const perKeyCalls = invoiceIds.length + saleIds.length;
  if (args.callsBeforeEvidence + perKeyCalls + QUERY_CALL_RESERVE <= MAX_FUNCTION_DB_CALLS) {
    const events = await readInChunks(saleIds, (saleId) => ctx.db.query("accountingEvents").withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", saleCompletedKey(saleId))).take(1));
    for (const event of accept(events.flat())) firstEvents.set(event.idempotencyKey, event);
    const perInvoice = await readInChunks(invoiceIds, (id) => ctx.db.query("paymentAllocations").withIndex("by_receivable", (q) =>
      q.eq("receivableDocumentId", id)).take(remainingRows() + 1));
    for (const rows of perInvoice) addAllocations(accept(rows));
    return { allocationsByInvoice, firstEvents, strategy: "PER_KEY" };
  }
  const sortedInvoiceIds = [...invoiceIds].sort(compareIds);
  const lastInvoiceId = sortedInvoiceIds[sortedInvoiceIds.length - 1];
  addAllocations(accept(await ctx.db.query("paymentAllocations").withIndex("by_receivable", (q) =>
    q.gte("receivableDocumentId", sortedInvoiceIds[0]).lte("receivableDocumentId", lastInvoiceId)).take(remainingRows() + 1)));
  const events = accept(await ctx.db.query("accountingEvents").withIndex("by_org_idempotency", (q) =>
    q.eq("orgId", orgId).gte("idempotencyKey", "sale_completed_").lt("idempotencyKey", "sale_completed_￿")).take(remainingRows() + 1));
  for (const event of events) if (!firstEvents.has(event.idempotencyKey)) firstEvents.set(event.idempotencyKey, event);
  return { allocationsByInvoice, firstEvents, strategy: "RANGE" };
}
