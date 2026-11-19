import { ConvexError, v } from "convex/values";
import { internalMutation } from "./functions";
import { normalizedPaymentReference } from "./utils/customerFinanceCompanyPayments";

const PAGE_SIZE = 100;

/** Drains the unset-reference index range. Every page commits independently. */
export const runPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ checkedCount: v.number(), isDone: v.boolean(), continueCursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { cursor }) => {
    if (cursor !== null && !/^\d{1,9}$/.test(cursor)) throw new ConvexError("Invalid receipt backfill cursor.");
    const rows = await ctx.db.query("customerFinanceCompanyPayments")
      .withIndex("by_normalized_reference_status", (q) => q.eq("normalizedReference", undefined).eq("status", "CONFIRMED"))
      .take(PAGE_SIZE + 1);
    for (const row of rows.slice(0, PAGE_SIZE)) {
      await ctx.db.patch(row._id, { normalizedReference: normalizedPaymentReference(row.reference) });
    }
    const isDone = rows.length <= PAGE_SIZE;
    return {
      checkedCount: Math.min(rows.length, PAGE_SIZE),
      isDone,
      continueCursor: isDone ? null : String(Number(cursor ?? 0) + 1),
    };
  },
});
