import type { PaginationOptions } from "convex/server";
import type { DataModel, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { createSupplierReadCache, type SupplierReadCache } from "./supplierReadCache";
import { readRow, payableFacts, receivableFacts, recoveryFacts, type ObligationKind, type ObligationRow, type ObligationPage, type UnreadableRow } from "./supplierObligationFacts";

type Table = "vehicleSupplierPayables" | "vehicleSupplierReceivables" | "supplierCostRecoveries";
interface PageArgs {
  orgId: Id<"organizations">;
  kind: ObligationKind;
  nowMs: number;
  supplierId?: Id<"suppliers">;
  paginationOpts: PaginationOptions;
  /** The worker reports data faults before writing any notifications. Other callers fail closed. */
  onUnreadableRow?: (row: UnreadableRow) => void;
}

function scopedIndex(ctx: QueryCtx, table: Table, args: PageArgs) {
  const source = ctx.db.query(table);
  return args.supplierId
    ? source.withIndex("by_org_and_supplierId_and_status", q => q.eq("orgId", args.orgId).eq("supplierId", args.supplierId))
    : source.withIndex("by_org", q => q.eq("orgId", args.orgId));
}

/** Bind each table to its document reader while preserving the schema's document type. */
function family<T extends Table>(source: {
  table: T;
  facts: (ctx: QueryCtx, orgId: Id<"organizations">, row: DataModel[T]["document"], cache?: SupplierReadCache) => ReturnType<typeof payableFacts> | ReturnType<typeof recoveryFacts>;
}) {
  return async (ctx: QueryCtx, args: PageArgs): Promise<ObligationPage> => {
    const cache = args.supplierId ? createSupplierReadCache() : undefined;
    const page = await scopedIndex(ctx, source.table, args).paginate(args.paginationOpts);
    const rows: ObligationRow[] = [];
    for (const document of page.page) {
      // scopedIndex queries source.table; T retains that table/facts pairing across Convex's union index type.
      const doc = document as unknown as DataModel[T]["document"];
      const row = await readRow(args.kind, doc._id, doc.currency, args.nowMs,
        () => source.facts(ctx, args.orgId, doc, cache), args.onUnreadableRow);
      if (row) rows.push(row);
    }
    return { rows, complete: page.isDone, continueCursor: page.continueCursor,
      pageStatus: page.pageStatus ?? null, splitCursor: page.splitCursor ?? null };
  };
}

const FAMILIES = {
  PAYABLE: family({ table: "vehicleSupplierPayables", facts: payableFacts }),
  RECEIVABLE: family({ table: "vehicleSupplierReceivables", facts: receivableFacts }),
  RECOVERY: family({ table: "supplierCostRecoveries", facts: (_ctx, _orgId, row) => recoveryFacts(row) }),
};

/** One native page per invocation; totals belong only to the aging consumer that displays them. */
export async function readObligationPage(ctx: QueryCtx, args: PageArgs): Promise<ObligationPage> {
  return FAMILIES[args.kind](ctx, args);
}
