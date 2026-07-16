import { ConvexError, v } from "convex/values";
import { ActionCtx, QueryCtx, MutationCtx, action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { verifyTurnstileToken, normalizeText, normalizeRequiredText, getPublishedSnapshotData } from "./websites";
import { enforceMarketplaceSubmissionRateLimit, MarketplaceSubmissionRateLimitName } from "./rateLimit";
import { notifyByPermission } from "./utils/notifications";
import { PERMISSIONS } from "./utils/permissions";
import { compareDealerRank, listOptedInDealerProfiles, checkMarketplaceQuota } from "./marketplaceDealers";
import { hasPlanFeature } from "./subscriptions";
import { scoreVehicleAgainstRequest } from "./utils/marketplaceMatching";
import { calculateUnifiedMurabaha } from "../lib/financing";

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

/**
 * Shared gate for the two public buyer-intake actions (`submitRequest`,
 * `submitTradeInRequest`): normalize the fingerprint, verify Turnstile, then
 * rate-limit on both fingerprint and phone before any DB write. Returns the
 * args with `turnstileToken` stripped (ready to hand to the internal create
 * mutation) plus the normalized fingerprint. The two rate-limit buckets differ
 * per flow, so the caller passes them in.
 */
export async function verifyPublicSubmission<
  T extends { turnstileToken: string; clientFingerprint: string; buyerPhone: string },
>(
  ctx: ActionCtx,
  args: T,
  fingerprintLimit: MarketplaceSubmissionRateLimitName,
  contactLimit: MarketplaceSubmissionRateLimitName,
): Promise<{ requestArgs: Omit<T, "turnstileToken">; clientFingerprint: string }> {
  const clientFingerprint = normalizeRequiredText(args.clientFingerprint, "Client fingerprint", MAX_FINGERPRINT_CHARS);
  await verifyTurnstileToken(args.turnstileToken);
  await enforceMarketplaceSubmissionRateLimit(ctx, fingerprintLimit, clientFingerprint);

  const normalizedPhone = normalizePhone(args.buyerPhone, "Phone");
  await enforceMarketplaceSubmissionRateLimit(ctx, contactLimit, normalizedPhone);

  const { turnstileToken: _turnstileToken, ...requestArgs } = args;
  return { requestArgs, clientFingerprint };
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
  // Buyer's financing constraints — drive personalized installment estimates
  // and finance-aware matching. Absent = illustrative 20%/60mo defaults.
  financePreferences: v.optional(
    v.object({
      downPaymentAmount: v.optional(v.number()),
      preferredTermMonths: v.optional(v.number()),
      maximumMonthlyPayment: v.optional(v.number()),
      allowHigherDownPayment: v.optional(v.boolean()),
      maximumHigherDownPayment: v.optional(v.number()),
      allowLongerTerm: v.optional(v.boolean()),
      maximumTermMonths: v.optional(v.number()),
    })
  ),
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
  handler: async (
    ctx,
    args
  ): Promise<{ requestId: Id<"marketplaceRequests">; publicId: string; matchedCount: number }> => {
    const { requestArgs, clientFingerprint } = await verifyPublicSubmission(
      ctx,
      args,
      "marketplaceRequestFingerprint",
      "marketplaceRequestContact",
    );
    return await ctx.runMutation(internal.marketplaceRequests.createRequest, {
      ...requestArgs,
      clientFingerprint,
    });
  },
});

// Illustrative finance assumptions when the buyer gave no preferences — kept
// in sync with the public browse estimate (marketplaceBrowse.ts).
const DEFAULT_DOWN_PAYMENT_PCT = 0.2;
const DEFAULT_TERM_MONTHS = 60;

type SnapshotFinanceTerms = {
  profitRate: number;
  maxTermMonths: number;
  gracePeriodMonths: number;
  insuranceRate?: number;
  adminFees?: number;
  commission?: number;
  includesCommissionInDebt?: boolean;
};

type SnapshotVehicleLite = {
  id?: string;
  make?: string;
  model?: string;
  year?: number | null;
  price?: number | null;
  financePrice?: number | null;
  status?: string;
};

type BuyerFinancePreferences = {
  downPaymentAmount?: number;
  preferredTermMonths?: number;
};

/** Computes the buyer-personalized installment + the term snapshot the estimate was built from, so the buyer keeps seeing the exact numbers even as rates drift. */
function computePersonalizedFinance(
  price: number,
  terms: SnapshotFinanceTerms,
  prefs: BuyerFinancePreferences | undefined
) {
  const downPayment = prefs?.downPaymentAmount ?? Math.round(price * DEFAULT_DOWN_PAYMENT_PCT);
  const termMonths = Math.min(prefs?.preferredTermMonths ?? DEFAULT_TERM_MONTHS, terms.maxTermMonths);
  const result = calculateUnifiedMurabaha({
    vehiclePrice: price,
    downPayment,
    commission: terms.commission ?? 0,
    processingFees: terms.adminFees ?? 0,
    annualProfitRate: terms.profitRate,
    annualInsuranceRate: terms.insuranceRate ?? 0,
    termMonths,
    gracePeriodMonths: terms.gracePeriodMonths,
    includesCommissionInDebt: terms.includesCommissionInDebt ?? false,
  });
  return {
    monthly: Math.round(result.monthlyInstallment),
    snapshot: {
      vehiclePrice: price,
      downPayment,
      termMonths,
      annualProfitRate: terms.profitRate,
      annualInsuranceRate: terms.insuranceRate ?? 0,
      commission: terms.commission ?? 0,
      processingFees: terms.adminFees ?? 0,
    },
  };
}

type ScoredDealerMatch = {
  profile: Doc<"marketplaceDealerProfiles">;
  score: number;
  tier: "INVENTORY" | "ELIGIBLE";
  matchedVehicleRawId?: string;
  estimatedMonthlyPayment?: number;
  matchReasons?: string[];
  calculationSnapshot?: ReturnType<typeof computePersonalizedFinance>["snapshot"];
};

/**
 * Two-tier inventory-aware fan-out. For each opted-in dealer that passes the
 * monetization quota *before* being considered (so a blocked dealer never
 * consumes one of the request's limited slots), Tier A scores their published
 * inventory against the request and keeps their single best vehicle; a dealer
 * with no inventory hit but city/brand eligibility falls to Tier B for sourcing
 * capacity. Dealers are then ranked by match quality, with FEATURED demoted to
 * a final tie-break only — sponsorship buys directory placement, not a better
 * match than a genuinely closer car. Inserts up to MAX_MATCHED_DEALERS rows.
 */
async function matchDealersToRequest(
  ctx: MutationCtx,
  params: {
    requestId: Id<"marketplaceRequests">;
    criteria: Parameters<typeof scoreVehicleAgainstRequest>[0];
    buyerCity: string;
    make?: string;
    financePreferences?: BuyerFinancePreferences;
    now: number;
  }
): Promise<Array<{ orgId: Id<"organizations"> }>> {
  const candidates = await listOptedInDealerProfiles(ctx);
  const scored: ScoredDealerMatch[] = [];

  for (const profile of candidates) {
    const org = await ctx.db.get(profile.orgId);
    if (!org || org.suspended) continue;
    // Quota BEFORE inclusion — a blocked dealer must not occupy a match slot a
    // reachable dealer could have used.
    if (!checkMarketplaceQuota(profile, params.now).allowed) continue;

    let best: Omit<ScoredDealerMatch, "profile" | "tier"> | null = null;
    if (await hasPlanFeature(ctx, profile.orgId, "websiteBuilder")) {
      const snapshot = await getPublishedSnapshotData(ctx, profile.orgId);
      const financeTerms = (snapshot?.financeCompany as SnapshotFinanceTerms | null | undefined) ?? null;
      const vehicles = Array.isArray(snapshot?.vehicles) ? (snapshot!.vehicles as SnapshotVehicleLite[]) : [];

      for (const vehicle of vehicles) {
        if (!vehicle.make || !vehicle.model) continue;
        if (vehicle.status && vehicle.status !== "AVAILABLE") continue;

        const financeBasePrice = vehicle.financePrice ?? vehicle.price ?? null;
        const finance =
          financeTerms && financeBasePrice != null
            ? computePersonalizedFinance(financeBasePrice, financeTerms, params.financePreferences)
            : null;

        const result = scoreVehicleAgainstRequest(
          params.criteria,
          { make: vehicle.make, model: vehicle.model, year: vehicle.year ?? null, price: vehicle.price ?? null },
          { monthlyEstimate: finance?.monthly ?? null, financeAvailable: Boolean(financeTerms) }
        );
        if (!result) continue;

        if (!best || result.score > best.score) {
          best = {
            score: result.score,
            matchedVehicleRawId: vehicle.id,
            estimatedMonthlyPayment: finance?.monthly,
            matchReasons: result.reasons,
            calculationSnapshot: finance?.snapshot,
          };
        }
      }
    }

    if (best) {
      scored.push({ profile, tier: "INVENTORY", ...best });
    } else if (dealerMatchesRequest(profile, { buyerCity: params.buyerCity, make: params.make })) {
      scored.push({ profile, tier: "ELIGIBLE", score: 0 });
    }
  }

  // Match quality first; FEATURED/response-rank only breaks ties between
  // equally good matches (compareDealerRank already front-loads FEATURED).
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : compareDealerRank(a.profile, b.profile)));

  const chosen = scored.slice(0, MAX_MATCHED_DEALERS);
  for (const candidate of chosen) {
    const matchedVehicleId = candidate.matchedVehicleRawId
      ? ctx.db.normalizeId("vehicles", candidate.matchedVehicleRawId) ?? undefined
      : undefined;
    await ctx.db.insert("marketplaceRequestMatches", {
      requestId: params.requestId,
      orgId: candidate.profile.orgId,
      matchedAt: params.now,
      matchTier: candidate.tier,
      matchedVehicleId,
      estimatedMonthlyPayment: candidate.estimatedMonthlyPayment,
      matchScore: candidate.score,
      matchReasons: candidate.matchReasons,
      calculationSnapshot: candidate.calculationSnapshot,
    });
  }

  return chosen.map((c) => ({ orgId: c.profile.orgId }));
}

export const createRequest = internalMutation({
  args: submitRequestBaseArgs,
  handler: async (
    ctx,
    args
  ): Promise<{ requestId: Id<"marketplaceRequests">; publicId: string; matchedCount: number }> => {
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
    // Unguessable Request Room token; the raw document id must never be the
    // buyer's only credential since it can leak via referrers/screenshots.
    const publicId = crypto.randomUUID().replace(/-/g, "");
    const requestId = await ctx.db.insert("marketplaceRequests", {
      status: "OPEN",
      publicId,
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
      financePreferences: args.financePreferences,
      buyerTimeframe: args.buyerTimeframe,
      buyerIntent,
      consentAcceptedAt: now,
      clientFingerprint: args.clientFingerprint,
      clientIpHash,
      expiresAt: now + REQUEST_EXPIRES_AFTER_DAYS * 24 * 60 * 60 * 1000,
      createdAt: now,
    });

    const matched = await matchDealersToRequest(ctx, {
      requestId,
      criteria: { make, model, yearMin: args.yearMin, yearMax: args.yearMax, priceMin: args.priceMin, priceMax: args.priceMax, paymentType: args.paymentType, monthlyBudget: args.monthlyBudget },
      buyerCity,
      make,
      financePreferences: args.financePreferences,
      now,
    });

    const intentLabelEn: Record<BuyerIntent, string> = {
      HOT: "Confirmed intent — ready soon",
      WARM: "Serious inquiry",
      COLD: "Browsing",
    };
    const vehicleDescription = [make, model].filter(Boolean).join(" ") || "a vehicle";

    for (const candidate of matched) {
      await notifyByPermission(ctx, candidate.orgId, PERMISSIONS.MARKETPLACE_RESPOND, "marketplace.request_matched", {
        intentLabel: intentLabelEn[buyerIntent],
        vehicleDescription,
        city: buyerCity,
      });
    }

    if (matched.length > 0) {
      await ctx.db.patch(requestId, { status: "MATCHED" });
    }

    return { requestId, publicId, matchedCount: matched.length };
  },
});

function phoneMatchesBuyerRequest(request: Doc<"marketplaceRequests">, buyerPhone: string): boolean {
  return request.buyerPhone === buyerPhone.replace(/[^\d+]/g, "");
}

async function getBuyerRequestStatus(ctx: QueryCtx, request: Doc<"marketplaceRequests">) {
  const matches = await ctx.db
    .query("marketplaceRequestMatches")
    .withIndex("by_request", (q) => q.eq("requestId", request._id))
    .collect();

  const responses = await ctx.db
    .query("marketplaceResponses")
    .withIndex("by_request", (q) => q.eq("requestId", request._id))
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
}

/** Public: buyer checks their own request's status — no login, matched by id + phone. */
export const getStatusForBuyer = query({
  args: { requestId: v.id("marketplaceRequests"), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request || !phoneMatchesBuyerRequest(request, args.buyerPhone)) return null;
    return await getBuyerRequestStatus(ctx, request);
  },
});

/**
 * Public/mobile-safe: the buyer status lookup that accepts a pasted/link id
 * string, normalizing it and returning null for a malformed id instead of
 * surfacing a validator error to the UI. Same phone gate as getStatusForBuyer.
 */
export const getStatusForBuyerByPublicId = query({
  args: { requestId: v.string(), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    const requestId = ctx.db.normalizeId("marketplaceRequests", args.requestId.trim());
    if (!requestId) return null;
    const request = await ctx.db.get(requestId);
    if (!request || !phoneMatchesBuyerRequest(request, args.buyerPhone)) return null;
    return await getBuyerRequestStatus(ctx, request);
  },
});

/**
 * Public Request Room feed: everything the buyer sees for their request, keyed
 * only by the unguessable publicId (possession of the link = read access; the
 * phone is only needed for sensitive actions, handled elsewhere). Offers are
 * sanitized — dealer identity is a display name + badges, never internal ids
 * beyond what a buyer action needs. NOT_AVAILABLE replies are omitted; they
 * aren't offers.
 */
export const getBuyerOffers = query({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("marketplaceRequests")
      .withIndex("by_publicId", (q) => q.eq("publicId", args.publicId.trim()))
      .unique();
    if (!request) return null;

    const now = Date.now();
    const responses = await ctx.db
      .query("marketplaceResponses")
      .withIndex("by_request", (q) => q.eq("requestId", request._id))
      .collect();

    const offers = await Promise.all(
      responses
        .filter((response) => response.kind !== "NOT_AVAILABLE")
        .map(async (response) => {
          const [org, profile] = await Promise.all([
            ctx.db.get(response.orgId),
            ctx.db
              .query("marketplaceDealerProfiles")
              .withIndex("by_org", (q) => q.eq("orgId", response.orgId))
              .unique(),
          ]);

          let vehicle: {
            year?: number;
            make: string;
            model: string;
            trim?: string;
            mileage?: number;
            photoUrl: string | null;
            inspectionStatus?: string;
            dealerGuarantee?: boolean;
          } | null = null;
          if (response.vehicleId) {
            const v = await ctx.db.get(response.vehicleId);
            if (v && !v.isDeleted) {
              const firstImageId = v.imageIds?.[0];
              vehicle = {
                year: v.year,
                make: v.make,
                model: v.model,
                trim: v.trim,
                mileage: v.mileage,
                photoUrl: firstImageId ? await ctx.storage.getUrl(firstImageId) : null,
                inspectionStatus: v.inspectionStatus,
                dealerGuarantee: v.dealerGuarantee,
              };
            }
          }

          const expiresAt = response.financeOffer?.expiresAt;
          return {
            responseId: response._id,
            dealerName: org?.name ?? "Dealer",
            dealerBadges: profile?.badges ?? [],
            dealerAvgResponseMinutes: profile?.avgResponseMinutes ?? null,
            kind: response.kind,
            cashPriceJod: response.offerPriceJod ?? null,
            financeOffer: response.financeOffer ?? null,
            sourcingRange: response.sourcingRange ?? null,
            vehicle,
            note: response.note ?? null,
            expiresAt: expiresAt ?? null,
            isExpired: expiresAt !== undefined && expiresAt < now,
            buyerAction: response.buyerAction ?? null,
            contactUnlocked: response.contactUnlockedAt !== undefined,
            createdAt: response.createdAt,
          };
        })
    );

    // Newest offers first, matching how the Request Room timeline reads.
    offers.sort((a, b) => b.createdAt - a.createdAt);

    return {
      publicId: request.publicId,
      status: request.status,
      createdAt: request.createdAt,
      make: request.make,
      model: request.model,
      buyerCity: request.buyerCity,
      paymentType: request.paymentType,
      offers,
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
