import { ConvexError, v } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { PERMISSIONS } from "./utils/permissions";
import { requireTenantAuth } from "./utils/tenancy";
import { refreshDealerBadges, checkMarketplaceQuota, consumeMarketplaceLead, getOwnProfile } from "./marketplaceDealers";
import { calculateUnifiedMurabaha } from "../lib/financing";

const MAX_NOTE_CHARS = 1000;
const MAX_LISTED_REQUESTS = 100;

const responseKindValidator = v.union(
  v.literal("HAVE_MATCH"),
  v.literal("HAVE_SIMILAR"),
  v.literal("CAN_SOURCE"),
  v.literal("NOT_AVAILABLE")
);

// A positive reply moves an OPEN/MATCHED request to OFFERS_RECEIVED. Buyer
// actions (ACCEPTED/COMPLETED) are downstream and must never be regressed by a
// late dealer reply, so the bump only applies from these two starting states.
const FULFILLING_KINDS = new Set(["HAVE_MATCH", "HAVE_SIMILAR", "CAN_SOURCE"]);
const OFFERABLE_FROM = new Set(["OPEN", "MATCHED"]);

type FinanceOffer = NonNullable<Doc<"marketplaceResponses">["financeOffer"]>;

/**
 * Builds the full offer snapshot from the dealer's chosen finance company +
 * down payment + term, using the same murabaha engine as the rest of the app —
 * the dealer never types a monthly installment. Snapshot semantics: what the
 * buyer was quoted is frozen here, so later rate changes can't rewrite a
 * standing offer.
 */
async function buildFinanceOffer(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  args: { vehiclePrice: number; downPayment: number; termMonths: number; financeCompanyId: Id<"financeCompanies">; expiresAt?: number }
): Promise<FinanceOffer> {
  const company = await ctx.db.get(args.financeCompanyId);
  if (!company || company.orgId !== orgId || !company.isActive) {
    throw new ConvexError("Finance company not found.");
  }
  if (args.termMonths <= 0 || args.termMonths > company.maxTermMonths) {
    throw new ConvexError(`Term must be between 1 and ${company.maxTermMonths} months for this finance company.`);
  }
  if (args.downPayment < 0 || args.downPayment >= args.vehiclePrice) {
    throw new ConvexError("Down payment must be between zero and the vehicle price.");
  }

  const commission = company.commission ?? 0;
  const processingFees = company.adminFees ?? 0;
  const result = calculateUnifiedMurabaha({
    vehiclePrice: args.vehiclePrice,
    downPayment: args.downPayment,
    commission,
    processingFees,
    annualProfitRate: company.profitRate,
    annualInsuranceRate: company.insuranceRate ?? 0,
    termMonths: args.termMonths,
    gracePeriodMonths: company.gracePeriodMonths,
    includesCommissionInDebt: company.includesCommissionInDebt ?? false,
  });

  return {
    vehiclePrice: args.vehiclePrice,
    downPayment: args.downPayment,
    termMonths: args.termMonths,
    monthlyInstallment: Math.round(result.monthlyInstallment),
    totalContractValue: Math.round(result.totalContractValue),
    totalProfit: Math.round(result.totalProfit),
    insuranceAmount: Math.round(result.takafulAmount),
    commission,
    processingFees,
    financeCompanyId: args.financeCompanyId,
    expiresAt: args.expiresAt,
  };
}

/** Dashboard: requests matched to this org, each with the org's own most recent response (if any). */
export const listForOrg = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MARKETPLACE_RESPOND]);

    const matches = await ctx.db
      .query("marketplaceRequestMatches")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(MAX_LISTED_REQUESTS);

    const responses = await ctx.db
      .query("marketplaceResponses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const responsesByRequest = new Map<Id<"marketplaceRequests">, Doc<"marketplaceResponses">[]>();
    for (const response of responses) {
      const list = responsesByRequest.get(response.requestId);
      if (list) list.push(response);
      else responsesByRequest.set(response.requestId, [response]);
    }

    const rows = await Promise.all(
      matches.map(async (match) => {
        const request = await ctx.db.get(match.requestId);
        if (!request) return null;

        const ownResponses = (responsesByRequest.get(match.requestId) ?? [])
          .sort((a, b) => b.createdAt - a.createdAt);

        return {
          requestId: request._id,
          status: request.status,
          buyerFirstName: request.buyerFirstName,
          buyerCity: request.buyerCity,
          make: request.make,
          model: request.model,
          yearMin: request.yearMin,
          yearMax: request.yearMax,
          priceMin: request.priceMin,
          priceMax: request.priceMax,
          paymentType: request.paymentType,
          monthlyBudget: request.monthlyBudget,
          buyerTimeframe: request.buyerTimeframe,
          buyerIntent: request.buyerIntent,
          matchedAt: match.matchedAt,
          latestResponse: ownResponses[0]
            ? { kind: ownResponses[0].kind, createdAt: ownResponses[0].createdAt }
            : null,
        };
      })
    );

    return rows.filter((row): row is NonNullable<typeof row> => row !== null);
  },
});

/**
 * Dashboard: dealer replies to a matched request with an AutoFlow-computed
 * offer. A reply no longer creates a lead — the buyer's phone stays private
 * until they consent (see marketplaceBuyerActions). The reply only records the
 * offer and moves the request to OFFERS_RECEIVED.
 */
export const respond = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("marketplaceRequests"),
    kind: responseKindValidator,
    vehicleId: v.optional(v.id("vehicles")),
    offerPriceJod: v.optional(v.number()),
    // Finance terms the dealer selects — AutoFlow computes the installment.
    financeCompanyId: v.optional(v.id("financeCompanies")),
    downPayment: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    offerExpiresAt: v.optional(v.number()),
    // CAN_SOURCE carries an honest range + ETA instead of a concrete vehicle.
    sourcingRange: v.optional(
      v.object({ minJod: v.number(), maxJod: v.number(), etaDays: v.number() })
    ),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MARKETPLACE_RESPOND]);

    const request = await ctx.db.get(args.requestId);
    if (!request) throw new ConvexError("Request not found.");
    if (request.status === "SPAM" || request.status === "EXPIRED") {
      throw new ConvexError("This request is no longer open.");
    }

    // A dealer may only respond to requests actually routed to them — never
    // the full request pool. See master plan A9.
    const match = await ctx.db
      .query("marketplaceRequestMatches")
      .withIndex("by_request", (q) => q.eq("requestId", args.requestId))
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .unique();
    if (!match) throw new ConvexError("This request was not routed to your dealership.");

    if (args.offerPriceJod !== undefined && args.offerPriceJod < 0) {
      throw new ConvexError("Offer price must be non-negative.");
    }

    // Kind-specific shape: a concrete match needs a real vehicle; a sourcing
    // reply needs an honest range, not a pretend vehicle.
    if (args.kind === "HAVE_MATCH" && !args.vehicleId) {
      throw new ConvexError("Pick the vehicle you're matching before sending the offer.");
    }
    if (args.kind === "CAN_SOURCE" && !args.sourcingRange) {
      throw new ConvexError("A sourcing reply needs a price range and ETA.");
    }

    if (args.vehicleId) {
      const vehicle = await ctx.db.get(args.vehicleId);
      if (!vehicle || vehicle.orgId !== args.orgId || vehicle.isDeleted) {
        throw new ConvexError("Vehicle not found.");
      }
    }

    if (args.sourcingRange && args.sourcingRange.minJod > args.sourcingRange.maxJod) {
      throw new ConvexError("Sourcing range minimum can't exceed its maximum.");
    }

    // Compute the finance offer when the dealer supplied finance terms. Needs a
    // price base to compute on — offerPriceJod is the dealer's cash price.
    let financeOffer: FinanceOffer | undefined;
    if (args.financeCompanyId !== undefined) {
      if (args.offerPriceJod === undefined || args.downPayment === undefined || args.termMonths === undefined) {
        throw new ConvexError("A finance offer needs a price, down payment, and term.");
      }
      financeOffer = await buildFinanceOffer(ctx, args.orgId, {
        vehiclePrice: args.offerPriceJod,
        downPayment: args.downPayment,
        termMonths: args.termMonths,
        financeCompanyId: args.financeCompanyId,
        expiresAt: args.offerExpiresAt,
      });
    }

    const now = Date.now();

    // Phase 63 monetization gate — a FREE_FOUNDING dealer past their window,
    // or a LEAD_PACKAGE dealer who's exhausted this period's quota, can't
    // send another response until they upgrade. FEATURED is unlimited. A
    // profile could theoretically be missing if it was hard-deleted after the
    // request was matched — same lenient fallback as updateResponseScore
    // below, since that's an admin-data edge case, not a dealer-facing one.
    const profile = await getOwnProfile(ctx, args.orgId);
    if (profile) {
      const quotaCheck = checkMarketplaceQuota(profile, now);
      if (!quotaCheck.allowed) {
        throw new ConvexError(
          quotaCheck.reason === "FOUNDING_WINDOW_EXPIRED"
            ? "Upgrade required: your Founding Dealer window has ended. Upgrade your AutoFlow plan to keep receiving marketplace leads."
            : "Upgrade required: you've used all the marketplace leads in your current package this period. Upgrade your AutoFlow plan for more."
        );
      }
    }

    const note = args.note?.trim().slice(0, MAX_NOTE_CHARS) || undefined;

    const responseId = await ctx.db.insert("marketplaceResponses", {
      requestId: args.requestId,
      orgId: args.orgId,
      respondingUserId: user._id,
      kind: args.kind,
      vehicleId: args.vehicleId,
      offerPriceJod: args.offerPriceJod,
      financeOffer,
      sourcingRange: args.sourcingRange,
      note,
      createdAt: now,
    });

    if (FULFILLING_KINDS.has(args.kind) && OFFERABLE_FROM.has(request.status)) {
      await ctx.db.patch(args.requestId, { status: "OFFERS_RECEIVED" });
    }

    await ctx.db.insert("marketplaceEvents", {
      requestId: args.requestId,
      orgId: args.orgId,
      event: "response.sent",
      meta: { kind: args.kind },
      createdAt: now,
    });

    // Ping the buyer's device the moment a real offer lands (no-ops if they
    // never enabled notifications). NOT_AVAILABLE isn't an offer, so it's silent.
    // Legacy requests predating the publicId token simply don't get a push.
    if (FULFILLING_KINDS.has(args.kind) && request.publicId) {
      await ctx.scheduler.runAfter(0, internal.marketplaceBuyerPush.sendBuyerOfferPush, {
        publicId: request.publicId,
      });
    }

    if (profile) {
      if (profile.tier === "LEAD_PACKAGE") await consumeMarketplaceLead(ctx, profile, now);
      await updateResponseScore(ctx, profile, match, now);
    }

    return { responseId };
  },
});

async function updateResponseScore(
  ctx: MutationCtx,
  profile: Doc<"marketplaceDealerProfiles">,
  match: Doc<"marketplaceRequestMatches">,
  respondedAt: number
) {
  const responseMinutes = Math.max(0, (respondedAt - (match.notifiedAt ?? match.matchedAt)) / 60000);
  const previousTotal = profile.totalResponses;
  const previousAvg = profile.avgResponseMinutes ?? responseMinutes;
  const newAvg = (previousAvg * previousTotal + responseMinutes) / (previousTotal + 1);

  await ctx.db.patch(profile._id, {
    avgResponseMinutes: newAvg,
    totalResponses: previousTotal + 1,
    updatedAt: Date.now(),
  });

  await refreshDealerBadges(ctx, { ...profile, avgResponseMinutes: newAvg, totalResponses: previousTotal + 1 });
}
