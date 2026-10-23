import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  resolveOpeningSettlementBasis,
  createOpeningSettlementReader,
} from "./openingSettlementBasis";
export async function readOpeningUnallocatedLiabilities(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  cutoff: number,
) {
  const parents = await ctx.db
    .query("openingBalanceDrafts")
    .withIndex("by_org_status", (q) =>
      q.eq("orgId", orgId).eq("status", "POSTED"),
    )
    .take(101);
  if (parents.length > 100) return { status: "UNAVAILABLE" as const, rows: [] };
  const rows = [];
  const reader = createOpeningSettlementReader(ctx, orgId);
  for (const draft of parents) {
    for (const row of draft.allocations ?? []) {
      if (row.kind !== "UNALLOCATED_LIABILITY") continue;
      const basis = await resolveOpeningSettlementBasis(
        ctx,
        orgId,
        { draftId: draft._id, rowKey: row.rowKey },
        row.kind,
        reader,
      );
      if (basis.kind !== "AVAILABLE")
        return { status: "UNAVAILABLE" as const, rows: [] };
      if (basis.asOfDate > cutoff) continue;
      rows.push({
        accountId: basis.accountId,
        currency: basis.currency,
        amountMinor: basis.amountMinor,
        purpose: row.purpose,
        title: row.title,
        draftId: draft._id,
        rowKey: row.rowKey,
      });
    }
  }
  return {
    status: rows.length ? ("UNALLOCATED" as const) : ("NONE" as const),
    rows,
  };
}
