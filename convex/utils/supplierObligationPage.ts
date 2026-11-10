import type { IndexRangeBuilder, PaginationOptions, PaginationResult } from "convex/server";
import type { DataModel, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { createSupplierReadCache, type SupplierReadCache } from "./supplierReadCache";
import { readRow, payableFacts, receivableFacts, recoveryFacts, type ObligationKind, type ObligationRow, type ObligationPage, type UnreadableRow } from "./supplierObligationFacts";

type Table = "vehicleSupplierPayables" | "vehicleSupplierReceivables" | "supplierCostRecoveries";
type ScopeRange<I extends "by_org" | "by_org_and_supplierId_and_status"> = {
  [T in Table]: IndexRangeBuilder<DataModel[T]["document"], DataModel[T]["indexes"][I]>;
}[Table];
interface PageArgs {
  orgId: Id<"organizations">;
  kind: ObligationKind;
  nowMs: number;
  supplierId?: Id<"suppliers">;
  paginationOpts: PaginationOptions;
  /** The worker reports data faults before writing any notifications. Other callers fail closed. */
  onUnreadableRow?: (row: UnreadableRow) => void;
}

function scopeRanges(args: PageArgs) {
  return {
    supplier: (q: ScopeRange<"by_org_and_supplierId_and_status">) =>
      q.eq("orgId", args.orgId).eq("supplierId", args.supplierId),
    org: (q: ScopeRange<"by_org">) => q.eq("orgId", args.orgId),
  };
}

/** Bind each table to its document reader while preserving the schema's document type. */
function family<T extends Table>(source: {
  readPage: (ctx: QueryCtx, args: PageArgs) => Promise<PaginationResult<DataModel[T]["document"]>>;
  facts: (ctx: QueryCtx, orgId: Id<"organizations">, row: DataModel[T]["document"], cache?: SupplierReadCache) => ReturnType<typeof payableFacts> | ReturnType<typeof recoveryFacts>;
}) {
  return async (ctx: QueryCtx, args: PageArgs): Promise<ObligationPage> => {
    const cache = args.supplierId ? createSupplierReadCache() : undefined;
    const page = await source.readPage(ctx, args);
    const rows: ObligationRow[] = [];
    for (const doc of page.page) {
      const row = await readRow(args.kind, doc._id, doc.currency, args.nowMs,
        () => source.facts(ctx, args.orgId, doc, cache), args.onUnreadableRow);
      if (row) rows.push(row);
    }
    return { rows, complete: page.isDone, continueCursor: page.continueCursor,
      pageStatus: page.pageStatus ?? null, splitCursor: page.splitCursor ?? null };
  };
}

const FAMILIES = {
  PAYABLE: family<"vehicleSupplierPayables">({
    readPage: (ctx, args) => {
      const source = ctx.db.query("vehicleSupplierPayables");
      const range = scopeRanges(args);
      return (args.supplierId
        ? source.withIndex("by_org_and_supplierId_and_status", range.supplier)
        : source.withIndex("by_org", range.org)).paginate(args.paginationOpts);
    },
    facts: payableFacts,
  }),
  RECEIVABLE: family<"vehicleSupplierReceivables">({
    readPage: (ctx, args) => {
      const source = ctx.db.query("vehicleSupplierReceivables");
      const range = scopeRanges(args);
      return (args.supplierId
        ? source.withIndex("by_org_and_supplierId_and_status", range.supplier)
        : source.withIndex("by_org", range.org)).paginate(args.paginationOpts);
    },
    facts: receivableFacts,
  }),
  RECOVERY: family<"supplierCostRecoveries">({
    readPage: (ctx, args) => {
      const source = ctx.db.query("supplierCostRecoveries");
      const range = scopeRanges(args);
      return (args.supplierId
        ? source.withIndex("by_org_and_supplierId_and_status", range.supplier)
        : source.withIndex("by_org", range.org)).paginate(args.paginationOpts);
    },
    facts: (_ctx, _orgId, row) => recoveryFacts(row),
  }),
};

/** One native page per invocation; totals belong only to the aging consumer that displays them. */
export async function readObligationPage(ctx: QueryCtx, args: PageArgs): Promise<ObligationPage> {
  return FAMILIES[args.kind](ctx, args);
}
