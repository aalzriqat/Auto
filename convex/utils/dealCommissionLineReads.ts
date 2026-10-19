import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { MAX_DEAL_COMMISSION_LINES } from "./dealCommissionLines";

/**
 * Most rows (removed ones included) one sale may hold. `addLine` refuses past
 * it, so every per-sale read can take ALL rows and a safety check never misses
 * a late line.
 */
export const MAX_DEAL_COMMISSION_LINE_ROWS = MAX_DEAL_COMMISSION_LINES * 5;

/**
 * Every line row of one sale, removed ones included. One read for the
 * teardown, paid-line and limit checks so they cannot disagree. Bounded by the
 * row cap `addLine` enforces; one extra row is read so an over-cap sale throws
 * instead of being silently truncated.
 */
export async function allLinesForSale(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<Doc<"dealCommissionLines">[]> {
  const rows = await ctx.db
    .query("dealCommissionLines")
    .withIndex("by_org_sale", (q) => q.eq("orgId", orgId).eq("saleId", saleId))
    .take(MAX_DEAL_COMMISSION_LINE_ROWS + 1);
  if (rows.length > MAX_DEAL_COMMISSION_LINE_ROWS) {
    throw new Error("This sale has more commission line rows than the system allows; accounting must review it.");
  }
  return rows;
}
