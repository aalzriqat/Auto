import { ConvexError, v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { verifyTurnstileToken, normalizeText, normalizeRequiredText } from "./websites";
import { enforceMarketplaceSubmissionRateLimit } from "./rateLimit";
import { notifyByPermission } from "./utils/notifications";
import { PERMISSIONS } from "./utils/permissions";
import { compareDealerRank, listOptedInDealerProfiles } from "./marketplaceDealers";

const MAX_MATCHED_DEALERS = 5;
const REQUEST_EXPIRES_AFTER_DAYS = 14;

const MAX_NAME_CHARS = 80;
const MAX_PHONE_CHARS = 24;
const MAX_CITY_CHARS = 60;
const MAX_MAKE_MODEL_CHARS = 60;
const MAX_FINGERPRINT_CHARS = 256;
const MAX_IP_HASH_CHARS = 128;

export function normalizePhone(value: string, field: string): string {
  const text = normalizeRequiredText(value, field, MAX_PHONE_CHARS);
  const normalized = text.replace(/[^\d+]/g, "");
  if (!/^\+?\d{7,20}$/.test(normalized)) {
    throw new ConvexError(`${field} is invalid.`);
  }
  return normalized;
}

const buyerTimeframeValidator = v.union(
  v.literal("ASAP"),
  v.literal("THIS_WEEK"),
  v.literal("THIS_MONTH"),
  v.literal("JUST_LOOKING")
);

const paymentTypeValidator = v.union(v.literal("CASH"), v.literal("FINANCE"), v.literal("EITHER"));

type BuyerTimeframe = "ASAP" | "THIS_WEEK" | "THIS_MONTH" | "JUST_LOOKING";
type BuyerIntent = "COLD" | "WARM" | "HOT";

/** Rule-based, not inferred — see master plan Phase 57. Exported for direct unit testing. */
export function computeBuyerIntent(args: {
  buyerTimeframe: BuyerTimeframe;
  monthlyBudget?: number;
  priceMin?: number;
  priceMax?: number;
}): BuyerIntent {
  const hasBudgetSignal = args.monthlyBudget !== undefined || args.priceMin !== undefined || args.priceMax !== undefined;
  const isUrgentTimeframe = args.buyerTimeframe === "ASAP" || args.buyerTimeframe === "THIS_WEEK";
  if (isUrgentTimeframe && hasBudgetSignal) return "HOT";
  if (isUrgentTimeframe || hasBudgetSignal) return "WARM";
  return "COLD";
}

/** Pure predicate: does this dealer's opt-in criteria match the buyer's request? Empty list = no restriction. Exported for direct unit testing. */
export function dealerMatchesRequest(
  profile: { areas: string[]; brandsCarried: string[] },
  request: { buyerCity: string; make?: string }
): boolean {
  const areaMatch =
    profile.areas.length === 0 ||
    profile.areas.some((area) => area.trim().toLowerCase() === request.buyerCity.trim().toLowerCase());
  const brandMatch =
    !request.make ||
    profile.brandsCarried.length === 0 ||
    profile.brandsCarried.some((brand) => brand.trim().toLowerCase() === request.make!.trim().toLowerCase());
  return areaMatch && brandMatch;
}

const submitRequestBaseArgs = {
  buyerFirstName: v.string(),
  buyerPhone: v.string(),
  buyerWhatsApp: v.optional(v.string()),
  buyerCity: v.string(),
  make: v.optional(v.string()),
  model: v.optional(v.string()),
  yearMin: v.optional(v.number()),
  yearMax: v.optional(v.number()),
  priceMin: v.optional(v.number()),
  priceMax: v.optional(v.number()),
  paymentType: paymentTypeValidator,
  monthlyBudget: v.optional(v.number()),
  buyerTimeframe: buyerTimeframeValidator,
  consentAccepted: v.boolean(),
  clientFingerprint: v.string(),
  clientIpHash: v.optional(v.string()),
};

/** Public: buyer-facing "Request a Car" submission. Turnstile + rate-limited, per master plan A4/A10. */
export const submitRequest = action({
  args: {
    ...submitRequestBaseArgs,
    turnstileToken: v.string(),
  },
  handler: async (ctx, args): Promise<{ requestId: Id<"marketplaceRequests">; matchedCount: number }> => {
    const clientFingerprint = normalizeRequiredText(args.clientFingerprint, "Client fingerprint", MAX_FINGERPRINT_CHARS);
    await verifyTurnstileToken(args.turnstileToken);
    await enforceMarketplaceSubmissionRateLimit(ctx, "marketplaceRequestFingerprint", clientFingerprint);

    const normalizedPhone = normalizePhone(args.buyerPhone, "Phone");
    await enforceMarketplaceSubmissionRateLimit(ctx, "marketplaceRequestContact", normalizedPhone);

    const { turnstileToken: _turnstileToken, ...requestArgs } = args;
    return await ctx.runMutation(internal.marketplaceRequests.createRequest, {
      ...requestArgs,
      clientFingerprint,
    });
  },
});

export const createRequest = internalMutation({
  args: submitRequestBaseArgs,
  handler: async (ctx, args): Promise<{ requestId: Id<"marketplaceRequests">; matchedCount: number }> => {
    if (!args.consentAccepted) {
      throw new ConvexError("Please accept the consent notice to submit a request.");
    }

    const buyerFirstName = normalizeRequiredText(args.buyerFirstName, "Name", MAX_NAME_CHARS);
    const buyerPhone = normalizePhone(args.buyerPhone, "Phone");
    const buyerWhatsApp = args.buyerWhatsApp ? normalizePhone(args.buyerWhatsApp, "WhatsApp") : undefined;
    const buyerCity = normalizeRequiredText(args.buyerCity, "City", MAX_CITY_CHARS);
    const make = normalizeText(args.make, "Make", MAX_MAKE_MODEL_CHARS);
    const model = normalizeText(args.model, "Model", MAX_MAKE_MODEL_CHARS);
    const clientIpHash = args.clientIpHash ? normalizeText(args.clientIpHash, "Client IP hash", MAX_IP_HASH_CHARS) : undefined;

    const buyerIntent = computeBuyerIntent({
      buyerTimeframe: args.buyerTimeframe,
      monthlyBudget: args.monthlyBudget,
      priceMin: args.priceMin,
      priceMax: args.priceMax,
    });

    const now = Date.now();
    const requestId = await ctx.db.insert("marketplaceRequests", {
      status: "OPEN",
      buyerFirstName,
      buyerPhone,
      buyerWhatsApp,
      buyerCity,
      make,
      model,
      yearMin: args.yearMin,
      yearMax: args.yearMax,
      priceMin: args.priceMin,
      priceMax: args.priceMax,
      paymentType: args.paymentType,
      monthlyBudget: args.monthlyBudget,
      buyerTimeframe: args.buyerTimeframe,
      buyerIntent,
      consentAcceptedAt: now,
      clientFingerprint: args.clientFingerprint,
      clientIpHash,
      expiresAt: now + REQUEST_EXPIRES_AFTER_DAYS * 24 * 60 * 60 * 1000,
      createdAt: now,
    });

    const candidates = await listOptedInDealerProfiles(ctx);

    const eligible: Doc<"marketplaceDealerProfiles">[] = [];
    for (const profile of candidates) {
      if (!dealerMatchesRequest(profile, { buyerCity, make })) continue;
      const org = await ctx.db.get(profile.orgId);
      if (!org || org.suspended) continue;
      eligible.push(profile);
    }

    // Same ranking as the public directory (Phase 60) and now boosted by
    // Phase 63's FEATURED tier — a dealer paying for featured placement
    // should also win fan-out priority, not just directory position.
    eligible.sort(compareDealerRank);

    const matched = eligible.slice(0, MAX_MATCHED_DEALERS);

    const intentLabelEn: Record<BuyerIntent, string> = {
      HOT: "Confirmed intent — ready soon",
      WARM: "Serious inquiry",
      COLD: "Browsing",
    };
    const vehicleDescription = [make, model].filter(Boolean).join(" ") || "a vehicle";

    for (const profile of matched) {
      await ctx.db.insert("marketplaceRequestMatches", {
        requestId,
        orgId: profile.orgId,
        matchedAt: now,
      });
      await notifyByPermission(ctx, profile.orgId, PERMISSIONS.MARKETPLACE_RESPOND, "marketplace.request_matched", {
        intentLabel: intentLabelEn[buyerIntent],
        vehicleDescription,
        city: buyerCity,
      });
    }

    if (matched.length > 0) {
      await ctx.db.patch(requestId, { status: "MATCHED" });
    }

    return { requestId, matchedCount: matched.length };
  },
});

/** Public: buyer checks their own request's status — no login, matched by id + phone. */
export const getStatusForBuyer = query({
  args: { requestId: v.id("marketplaceRequests"), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) return null;
    const normalizedPhone = args.buyerPhone.replace(/[^\d+]/g, "");
    if (request.buyerPhone !== normalizedPhone) return null;

    const matches = await ctx.db
      .query("marketplaceRequestMatches")
      .withIndex("by_request", (q) => q.eq("requestId", args.requestId))
      .collect();

    const responses = await ctx.db
      .query("marketplaceResponses")
      .withIndex("by_request", (q) => q.eq("requestId", args.requestId))
      .collect();
    const respondedOrgIds = new Set(
      responses.filter((r) => r.kind !== "NOT_AVAILABLE").map((r) => r.orgId)
    );

    return {
      status: request.status,
      createdAt: request.createdAt,
      matchedCount: matches.length,
      respondedCount: respondedOrgIds.size,
    };
  },
});

export const expireStaleRequests = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const status of ["OPEN", "MATCHED"] as const) {
      const stale = await ctx.db
        .query("marketplaceRequests")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const request of stale) {
        if (request.expiresAt < now) {
          await ctx.db.patch(request._id, { status: "EXPIRED" });
        }
      }
    }
  },
});
