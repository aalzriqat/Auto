import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Resolve the deal for an already-authorized quote, including older quotes. */
export async function ensureQuotedCommercialDeal(
  ctx: MutationCtx,
  quote: Pick<Doc<"quotes">, "_id" | "orgId" | "createdBy">,
) {
  const matching = await ctx.db.query("commercialDeals")
    .withIndex("by_org_quote", (q) => q.eq("orgId", quote.orgId).eq("quoteId", quote._id))
    .take(2);
  if (matching.length > 1) throw new ConvexError("This quote has conflicting deal records. Ask the administrator to review it.");
  if (matching.length === 1) return matching[0]._id;
  return await ctx.db.insert("commercialDeals", {
    orgId: quote.orgId,
    quoteId: quote._id,
    createdBy: quote.createdBy,
  });
}
