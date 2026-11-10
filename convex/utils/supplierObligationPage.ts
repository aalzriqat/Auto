import type { PaginationOptions, PaginationResult } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { createSupplierReadCache } from "./supplierReadCache";
import { OBLIGATION_PAGE_MAX, readRow, payableFacts, receivableFacts, recoveryFacts, totalsOf, type ObligationKind, type ObligationRow, type ObligationPage, type UnreadableRow } from "./supplierObligationDue";

async function projectPage<D>(page: PaginationResult<D>, read: (doc: D) => Promise<ObligationRow | null>, supplierId: Id<"suppliers"> | undefined) {
  const rows: ObligationRow[] = [];
  for (const doc of page.page) {
    const row = await read(doc);
    if (row) rows.push(row);
  }
  const result = { rows, totals: totalsOf(rows), complete: page.isDone, continueCursor: page.continueCursor };
  if (!supplierId) return result;
  return { ...result, pageStatus: page.pageStatus ?? null, splitCursor: page.splitCursor ?? null };
}

export async function readObligationPage(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    kind: ObligationKind;
    cursor: string | null;
    limit: number;
    nowMs: number;
    /** Supplied by a writer that must decide before it writes anything (the due-alert worker). */
    supplierId?: Id<"suppliers">;
    paginationOpts?: PaginationOptions;
    onUnreadableRow?: (row: UnreadableRow) => void;
  }
): Promise<ObligationPage & { pageStatus?: "SplitRequired" | "SplitRecommended" | null; splitCursor?: string | null }> {
  const { orgId, kind, cursor, nowMs, onUnreadableRow } = args;
  const numItems = Math.min(Math.max(Math.trunc(args.limit), 1), OBLIGATION_PAGE_MAX);
  const cache = args.supplierId ? createSupplierReadCache() : undefined;
  const options = args.paginationOpts ?? { cursor, numItems };

  if (kind === "PAYABLE") {
    const source = ctx.db.query("vehicleSupplierPayables");
    const query = args.supplierId
      ? source.withIndex("by_org_and_supplierId_and_status", q => q.eq("orgId", orgId).eq("supplierId", args.supplierId))
      : source.withIndex("by_org", q => q.eq("orgId", orgId));
    const page = await query.paginate(options);
    return projectPage(page, row => readRow(kind, row._id, row.currency, nowMs, () => payableFacts(ctx, orgId, row, cache), onUnreadableRow), args.supplierId);
  } else if (kind === "RECEIVABLE") {
    const source = ctx.db.query("vehicleSupplierReceivables");
    const query = args.supplierId
      ? source.withIndex("by_org_and_supplierId_and_status", q => q.eq("orgId", orgId).eq("supplierId", args.supplierId))
      : source.withIndex("by_org", q => q.eq("orgId", orgId));
    const page = await query.paginate(options);
    return projectPage(page, row => readRow(kind, row._id, row.currency, nowMs, () => receivableFacts(ctx, orgId, row, cache), onUnreadableRow), args.supplierId);
  } else {
    const source = ctx.db.query("supplierCostRecoveries");
    const query = args.supplierId
      ? source.withIndex("by_org_and_supplierId_and_status", q => q.eq("orgId", orgId).eq("supplierId", args.supplierId))
      : source.withIndex("by_org", q => q.eq("orgId", orgId));
    const page = await query.paginate(options);
    return projectPage(page, row => readRow(kind, row._id, row.currency, nowMs, () => recoveryFacts(row), onUnreadableRow), args.supplierId);
  }

}

