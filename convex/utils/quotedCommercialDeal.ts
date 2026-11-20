import type { WithoutSystemFields } from "convex/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { allocateDealNumber } from "./dealNumber";
import { isValidDealNumber } from "./dealNumberFormat";
import { requireCommercialVehicle } from "./vehicleLiveness";

type QuotedIdentity = Pick<Doc<"quotes">, "_id" | "orgId" | "createdBy" | "supersededAt">;

export function assertCurrentQuote(quote: Pick<Doc<"quotes">, "supersededAt">) {
  if (quote.supersededAt !== undefined) {
    throw new ConvexError("This is a replaced quote. Open the current deal instead.");
  }
}

export async function quoteVehicleForStatusChange(
  ctx: QueryCtx,
  quote: Doc<"quotes">,
  status: Doc<"quotes">["status"],
): Promise<Doc<"vehicles"> | undefined> {
  // Offering, accepting or reviving a quote reopens it. Expiry stays open for historical cars.
  if (status !== "SHARED" && status !== "ACCEPTED" && (status !== "DRAFT" || quote.status !== "EXPIRED")) {
    return undefined;
  }
  const vehicleIds = new Set([quote.vehicleId, ...(quote.vehicleItems ?? []).map((item) => item.vehicleId)]);
  let primaryVehicle: Doc<"vehicles"> | undefined;
  for (const id of vehicleIds) {
    const vehicle = requireCommercialVehicle(await ctx.db.get(id), quote.orgId);
    if (id === quote.vehicleId) primaryVehicle = vehicle;
  }
  return primaryVehicle;
}

async function readQuotedDealId(ctx: QueryCtx, quote: QuotedIdentity) {
  const matching = await ctx.db.query("commercialDeals")
    .withIndex("by_org_quote", q => q.eq("orgId", quote.orgId).eq("quoteId", quote._id)).take(2);
  if (matching.length > 1) {
    throw new ConvexError("This quote has conflicting deal records. Ask the administrator to review it.");
  }
  return matching[0]?._id;
}

function createQuotedDeal(ctx: MutationCtx, quote: QuotedIdentity) {
  return ctx.db.insert("commercialDeals", { kind: "QUOTED", orgId: quote.orgId, quoteId: quote._id, createdBy: quote.createdBy });
}

/** Resolve the deal for an already-authorized quote, including older quotes. */
export async function ensureQuotedCommercialDeal(ctx: MutationCtx, quote: QuotedIdentity) {
  assertCurrentQuote(quote);
  return (await readQuotedDealId(ctx, quote)) ?? await createQuotedDeal(ctx, quote);
}

export async function allocateQuotedApplicationIdentity(
  ctx: MutationCtx,
  quote: QuotedIdentity,
) {
  const dealId = await ensureQuotedCommercialDeal(ctx, quote);
  const dealNumber = await allocateDealNumber(ctx, quote.orgId);
  return { dealId, dealNumber };
}

export async function adoptReplacementCommercialQuote(
  ctx: MutationCtx,
  application: Doc<"financeApplications">,
  original: Doc<"quotes">,
  replacement: Doc<"quotes">,
  now: number,
) {
  assertCurrentQuote(original);
  assertCurrentQuote(replacement);
  if (original.orgId !== application.orgId || replacement.orgId !== application.orgId ||
      original._id !== application.quoteId || original._id === replacement._id || !application.dealId) {
    throw new ConvexError("The replacement quote does not belong to this deal.");
  }
  const [currentDealId, replacementDealId] = await Promise.all([
    readQuotedDealId(ctx, original),
    readQuotedDealId(ctx, replacement),
  ]);
  const unbookedDeal = replacementDealId && await ctx.db.get(replacementDealId);
  if (currentDealId !== application.dealId || !unbookedDeal ||
      unbookedDeal.orgId !== application.orgId || unbookedDeal.kind !== "QUOTED" ||
      unbookedDeal.quoteId !== replacement._id || unbookedDeal._id === currentDealId) {
    throw new ConvexError("The records for these quotes do not support the correction.");
  }
  const replacementSale = await ctx.db.query("sales")
    .withIndex("by_quote", (q) => q.eq("quoteId", replacement._id)).first();
  if (replacementSale) throw new ConvexError("The replacement quote is already used by a sale.");

  await ctx.db.replace(unbookedDeal._id, {
    kind: "DETACHED", orgId: unbookedDeal.orgId, createdBy: unbookedDeal.createdBy,
  });
  await ctx.db.patch(currentDealId, { quoteId: replacement._id });
  await ctx.db.patch(original._id, { supersededAt: now });
}

/** Return false when another batch must detach more quote links before deletion. */
export async function detachQuoteDealBatch(ctx: MutationCtx, orgId: Id<"organizations">, quoteId: Id<"quotes">) {
  const batch = await ctx.db.query("commercialDeals")
    .withIndex("by_org_quote", q => q.eq("orgId", orgId).eq("quoteId", quoteId))
    .take(2);
  await Promise.all(batch.map(deal => ctx.db.replace(deal._id, {
    kind: "DETACHED", orgId: deal.orgId, createdBy: deal.createdBy,
  })));
  return batch.length < 2;
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
  return quotedVehicleLine(quote, vehicleId);
}

function quotedVehicleLine(quote: Pick<Doc<"quotes">, "vehicleItems" | "vehicleId">, vehicleId: Id<"vehicles">) {
  const items = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
  const index = items.findIndex((item) => item.vehicleId === vehicleId);
  return index >= 0 ? index : undefined;
}

type QuoteSaleIdentity = { customerId: Id<"customers">; vehicleId: Id<"vehicles"> };

export function assertQuoteMatchesSale(quote: Doc<"quotes">, sale: QuoteSaleIdentity) {
  if (quote.customerId !== sale.customerId || quotedVehicleLine(quote, sale.vehicleId) === undefined) {
    throw new ConvexError("Quote does not match the sale customer and vehicle.");
  }
}

type SaleDealIdentity = QuoteSaleIdentity & { orgId: Id<"organizations"> };
type SaleDealContext = { quote?: Doc<"quotes"> | null; financeApplication?: Doc<"financeApplications"> | null };
type SaleDealLink = { dealId?: Id<"commercialDeals">; dealNumber?: number };

async function dealQuoteFor(ctx: QueryCtx, args: SaleDealIdentity, context: SaleDealContext) {
  const application = context.financeApplication;
  if (!application) return context.quote ?? null;
  const quote = context.quote ?? await ctx.db.get(application.quoteId);
  if (quote?.orgId !== args.orgId || quote._id !== application.quoteId) {
    throw new ConvexError("The finance application's quote could not be verified.");
  }
  if (!context.quote) assertQuoteMatchesSale(quote, args);
  return quote;
}

async function readSaleDealIdentity(
  ctx: QueryCtx,
  args: SaleDealIdentity,
  context: SaleDealContext,
  link: SaleDealLink,
) {
  const quote = await dealQuoteFor(ctx, args, context);
  const existingDealId = link.dealId;
  if (quote) {
    assertCurrentQuote(quote);
    const dealId = await readQuotedDealId(ctx, quote);
    const appDealId = context.financeApplication?.dealId;
    if ((existingDealId !== undefined && existingDealId !== dealId) ||
        (appDealId !== undefined && appDealId !== dealId)) {
      throw new ConvexError("The sale and quote have different deal records. Ask the administrator to review them.");
    }
    return { dealId, quote };
  }
  if (existingDealId !== undefined) {
    const deal = await ctx.db.get(existingDealId);
    if (deal?.orgId !== args.orgId || deal.kind !== "WALK_IN" ||
        !isValidDealNumber(link.dealNumber) || deal.walkInSaleNumber !== link.dealNumber) {
      throw new ConvexError("The draft sale's deal could not be verified.");
    }
  }
  return { dealId: existingDealId, quote: null };
}

/** Reject corrupt persisted links before the draft completion creates its command claim. */
export async function assertStoredDraftDealIdentity(ctx: QueryCtx, draft: Doc<"sales"> | null, orgId: Id<"organizations">) {
  if (draft?.orgId !== orgId || draft.isDeleted || draft.status !== "PENDING") return;
  const quote = draft.quoteId ? await ctx.db.get(draft.quoteId) : null;
  const financeApplication = draft.applicationId ? await ctx.db.get(draft.applicationId) : null;
  // The existing completion preflight owns missing/foreign source refusals and their public error codes.
  if (draft.quoteId && quote?.orgId !== orgId) return;
  if (draft.applicationId && financeApplication?.orgId !== orgId) return;
  await readSaleDealIdentity(ctx, draft, { quote, financeApplication }, draft);
}

export async function commercialDealForSale(
  ctx: MutationCtx,
  args: SaleDealIdentity & { actorId: Id<"users"> },
  context: SaleDealContext,
  link: SaleDealLink,
): Promise<Id<"commercialDeals">> {
  const plan = await readSaleDealIdentity(ctx, args, context, link);
  const dealId = plan.dealId ?? (plan.quote
    ? await createQuotedDeal(ctx, plan.quote)
    : await createWalkInCommercialDeal(ctx, args, link.dealNumber));
  const application = context.financeApplication;
  if (application && application.dealId === undefined) await ctx.db.patch(application._id, { dealId });
  return dealId;
}

function createWalkInCommercialDeal(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; actorId: Id<"users"> },
  dealNumber: number | undefined,
) {
  if (!isValidDealNumber(dealNumber)) throw new ConvexError("The sale's deal number could not be verified.");
  return ctx.db.insert("commercialDeals", {
    kind: "WALK_IN", orgId: args.orgId, createdBy: args.actorId, walkInSaleNumber: dealNumber,
  });
}
