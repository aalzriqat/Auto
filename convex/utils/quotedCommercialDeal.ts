import type { WithoutSystemFields } from "convex/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
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

export async function insertQuoteWithCommercialDeal(ctx: MutationCtx, quote: WithoutSystemFields<Doc<"quotes">>) {
  const quoteId = await ctx.db.insert("quotes", quote);
  await ensureQuotedCommercialDeal(ctx, { _id: quoteId, orgId: quote.orgId, createdBy: quote.createdBy });
  return quoteId;
}

/**
 * Which line of the quote this car is — part of the identity of an application,
 * so an auditor can tie a slice of the deposit back to the line the customer
 * signed for rather than to a bare vehicle id.
 */
export async function quoteLineIndexFor(
  ctx: MutationCtx,
  quoteId: Id<"quotes"> | undefined,
  vehicleId: Id<"vehicles">
): Promise<number | undefined> {
  if (!quoteId) return undefined;
  const quote = await ctx.db.get(quoteId);
  if (!quote) return undefined;
  const items = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
  const index = items.findIndex((item) => item.vehicleId === vehicleId);
  return index >= 0 ? index : undefined;
}

export async function commercialDealForSale(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; actorId: Id<"users"> },
  context: { quote?: Doc<"quotes"> | null; financeApplication?: Doc<"financeApplications"> | null },
  existingDealId?: Id<"commercialDeals">,
): Promise<Id<"commercialDeals">> {
  const application = context.financeApplication;
  const quote = context.quote ?? (application ? await ctx.db.get(application.quoteId) : null);
  if (application && quote?.orgId !== args.orgId) {
    throw new ConvexError("The finance application's quote could not be verified.");
  }
  if (quote) {
    const dealId = await ensureQuotedCommercialDeal(ctx, quote);
    if ((existingDealId !== undefined && existingDealId !== dealId) ||
        (application?.dealId !== undefined && application.dealId !== dealId)) {
      throw new ConvexError("The sale and quote have different deal records. Ask the administrator to review them.");
    }
    if (application && application.dealId === undefined) {
      await ctx.db.patch(application._id, { dealId });
    }
    return dealId;
  }
  if (existingDealId !== undefined) {
    const deal = await ctx.db.get(existingDealId);
    if (deal?.orgId !== args.orgId || deal.quoteId !== undefined) {
      throw new ConvexError("The draft sale's deal could not be verified.");
    }
    return deal._id;
  }
  return await ctx.db.insert("commercialDeals", { orgId: args.orgId, createdBy: args.actorId });
}
