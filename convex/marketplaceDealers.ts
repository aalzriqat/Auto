import { v } from "convex/values";
import { query, mutation, internalMutation, QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { PERMISSIONS } from "./utils/permissions";
import { requireTenantAuth } from "./utils/tenancy";
import { hasPlanFeature, requireFeature } from "./subscriptions";

const MAX_AREAS = 20;
const MAX_BRANDS = 40;
const MAX_DIRECTORY_ROWS = 100;
const MAX_ACTIVE_VEHICLE_SAMPLE = 200;

// Phase 60 badge thresholds.
const FAST_RESPONSE_MAX_AVG_MINUTES = 60;
const FAST_RESPONSE_MIN_SAMPLE = 3;

// Phase 63 monetization — see master plan §3 ("free leads for a fixed window
// (e.g. 60 days)") and Phase 63 spec.
export const FOUNDING_WINDOW_DAYS = 60;
export const FOUNDING_WINDOW_MS = FOUNDING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const LEAD_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export type MarketplaceBadge = "VERIFIED_PHONE" | "VERIFIED_LOCATION" | "FAST_RESPONSE" | "FINANCE_AVAILABLE" | "FOUNDING_DEALER";
export type MarketplaceTier = "FREE_FOUNDING" | "LEAD_PACKAGE" | "FEATURED";

async function hasActiveFinanceCompany(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<boolean> {
  const companies = await ctx.db
    .query("financeCompanies")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  return companies.some((company) => company.isActive);
}

/** Pure — computes VERIFIED_PHONE/FAST_RESPONSE/FINANCE_AVAILABLE from current profile state; leaves any other pre-existing badges (VERIFIED_LOCATION/FOUNDING_DEALER) untouched since they're not computed by this phase. */
export function computeBadges(
  profile: Pick<Doc<"marketplaceDealerProfiles">, "badges" | "avgResponseMinutes" | "totalResponses" | "phoneVerifiedAt">,
  financeAvailable: boolean
): MarketplaceBadge[] {
  const computed = new Set<MarketplaceBadge>(["VERIFIED_LOCATION", "FOUNDING_DEALER"].filter((badge) =>
    profile.badges.includes(badge as MarketplaceBadge)
  ) as MarketplaceBadge[]);

  if (profile.phoneVerifiedAt) computed.add("VERIFIED_PHONE");
  if (profile.totalResponses >= FAST_RESPONSE_MIN_SAMPLE && (profile.avgResponseMinutes ?? Infinity) <= FAST_RESPONSE_MAX_AVG_MINUTES) {
    computed.add("FAST_RESPONSE");
  }
  if (financeAvailable) computed.add("FINANCE_AVAILABLE");

  return Array.from(computed);
}

/** Lower ranks first: FEATURED dealers (Phase 63 paid ranking boost) surface above everyone else, then verified/fast-responding dealers above unverified/slow ones, tiebroken by response time then registration order — same ordering signal Phase 57 uses to pick which dealers get a request. */
export function compareDealerRank(
  a: Pick<Doc<"marketplaceDealerProfiles">, "badges" | "avgResponseMinutes" | "createdAt" | "tier">,
  b: Pick<Doc<"marketplaceDealerProfiles">, "badges" | "avgResponseMinutes" | "createdAt" | "tier">
): number {
  const featuredA = a.tier === "FEATURED" ? 0 : 1;
  const featuredB = b.tier === "FEATURED" ? 0 : 1;
  if (featuredA !== featuredB) return featuredA - featuredB;

  const fastA = a.badges.includes("FAST_RESPONSE") ? 0 : 1;
  const fastB = b.badges.includes("FAST_RESPONSE") ? 0 : 1;
  if (fastA !== fastB) return fastA - fastB;

  const scoreA = a.avgResponseMinutes ?? Number.POSITIVE_INFINITY;
  const scoreB = b.avgResponseMinutes ?? Number.POSITIVE_INFINITY;
  if (scoreA !== scoreB) return scoreA - scoreB;

  return a.createdAt - b.createdAt;
}

/** Pure — derives the FREE_FOUNDING window end even for profiles created before Phase 63 added the stamped field, so no backfill migration is needed. */
export function effectiveFoundingWindowEndsAt(
  profile: Pick<Doc<"marketplaceDealerProfiles">, "createdAt" | "foundingWindowEndsAt">
): number {
  return profile.foundingWindowEndsAt ?? profile.createdAt + FOUNDING_WINDOW_MS;
}

export type MarketplaceQuotaCheck =
  | { allowed: true }
  | { allowed: false; reason: "FOUNDING_WINDOW_EXPIRED" | "LEAD_QUOTA_EXHAUSTED" };

/** Pure — whether this dealer can send another marketplace response right now. FEATURED is unlimited (paid ranking boost, no cap per master plan Phase 63); LEAD_PACKAGE is capped by leadQuota per rolling 30-day period; FREE_FOUNDING is unlimited until its window closes. */
export function checkMarketplaceQuota(
  profile: Pick<
    Doc<"marketplaceDealerProfiles">,
    "tier" | "createdAt" | "foundingWindowEndsAt" | "leadQuota" | "leadsUsedThisPeriod" | "leadPeriodStartedAt"
  >,
  now: number
): MarketplaceQuotaCheck {
  if (profile.tier === "FREE_FOUNDING") {
    if (now >= effectiveFoundingWindowEndsAt(profile)) return { allowed: false, reason: "FOUNDING_WINDOW_EXPIRED" };
    return { allowed: true };
  }

  if (profile.tier === "LEAD_PACKAGE") {
    const periodStart = profile.leadPeriodStartedAt ?? profile.createdAt;
    const usedThisPeriod = now - periodStart >= LEAD_PERIOD_MS ? 0 : profile.leadsUsedThisPeriod;
    if (usedThisPeriod >= (profile.leadQuota ?? 0)) return { allowed: false, reason: "LEAD_QUOTA_EXHAUSTED" };
    return { allowed: true };
  }

  return { allowed: true }; // FEATURED
}

/** Records one consumed lead against a LEAD_PACKAGE dealer's rolling period, resetting the counter first if the period has elapsed. Caller (marketplaceResponses.ts's `respond`) is responsible for calling `checkMarketplaceQuota` first. */
export async function consumeMarketplaceLead(ctx: MutationCtx, profile: Doc<"marketplaceDealerProfiles">, now: number): Promise<void> {
  const periodStart = profile.leadPeriodStartedAt ?? profile.createdAt;
  const periodElapsed = now - periodStart >= LEAD_PERIOD_MS;
  await ctx.db.patch(profile._id, {
    leadsUsedThisPeriod: periodElapsed ? 1 : profile.leadsUsedThisPeriod + 1,
    leadPeriodStartedAt: periodElapsed ? now : periodStart,
    updatedAt: now,
  });
}

/** Recomputes and persists badges for one dealer profile — shared by the daily cron and the immediate post-response/post-verification refresh, so a dealer doesn't wait up to a day to see FAST_RESPONSE/VERIFIED_PHONE reflected. */
export async function refreshDealerBadges(ctx: MutationCtx, profile: Doc<"marketplaceDealerProfiles">): Promise<void> {
  const financeAvailable = await hasActiveFinanceCompany(ctx, profile.orgId);
  const nextBadges = computeBadges(profile, financeAvailable);
  const changed =
    nextBadges.length !== profile.badges.length || nextBadges.some((badge) => !profile.badges.includes(badge));
  if (changed) {
    await ctx.db.patch(profile._id, { badges: nextBadges, updatedAt: Date.now() });
  }
}

/** Opted-in, non-deleted dealer profiles — shared by every marketplace flow that fans out across the dealer network (public browse, buyer-request matching, badge recompute, phone-number resolution). Pass a limit to cap a `.take()`, or omit it for `.collect()`. */
export async function listOptedInDealerProfiles(
  ctx: QueryCtx | MutationCtx,
  limit?: number
): Promise<Doc<"marketplaceDealerProfiles">[]> {
  const query = ctx.db.query("marketplaceDealerProfiles").withIndex("by_opted_in", (q) => q.eq("isOptedIn", true));
  const profiles = limit !== undefined ? await query.take(limit) : await query.collect();
  return profiles.filter((profile) => !profile.isDeleted);
}

/** Daily cron entrypoint (Phase 60) — recomputes FAST_RESPONSE/FINANCE_AVAILABLE for every opted-in dealer, since both can drift without any single triggering event (rolling average decay, a finance company being deactivated). */
export const recomputeAllDealerBadges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const profiles = await listOptedInDealerProfiles(ctx);
    for (const profile of profiles) {
      await refreshDealerBadges(ctx, profile);
    }
  },
});

function normalizeStringList(values: string[], max: number): string[] {
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return Array.from(new Set(cleaned)).slice(0, max);
}

/** Fetches the org's own marketplace dealer profile by orgId (not filtered by isOptedIn/isDeleted — callers that need "active and opted in" should check those fields themselves). */
export async function getOwnProfile(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
  return await ctx.db
    .query("marketplaceDealerProfiles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
}

async function resolveSiteUrl(ctx: QueryCtx, orgId: Id<"organizations">): Promise<string | null> {
  if (!(await hasPlanFeature(ctx, orgId, "websiteBuilder"))) return null;
  const primaryDomain = await ctx.db
    .query("websiteDomains")
    .withIndex("by_org_primary", (q) => q.eq("orgId", orgId).eq("isPrimary", true))
    .first();
  return primaryDomain?.status === "active" ? `https://${primaryDomain.domain}` : null;
}

/** Dashboard: the current org's marketplace profile, or null if never configured. */
export const getMyProfile = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MARKETPLACE_SETTINGS]);
    const profile = await getOwnProfile(ctx, args.orgId);
    return profile && !profile.isDeleted ? profile : null;
  },
});

/** Dashboard: opt in/out and configure marketplace matching criteria. Upserts. */
export const updateProfile = mutation({
  args: {
    orgId: v.id("organizations"),
    isOptedIn: v.boolean(),
    areas: v.array(v.string()),
    brandsCarried: v.array(v.string()),
    whatsappNumber: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MARKETPLACE_SETTINGS]);
    await requireFeature(ctx, args.orgId, "marketplace");

    const areas = normalizeStringList(args.areas, MAX_AREAS);
    const brandsCarried = normalizeStringList(args.brandsCarried, MAX_BRANDS);
    const whatsappNumber = args.whatsappNumber?.trim() || undefined;

    const existing = await getOwnProfile(ctx, args.orgId);
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        isOptedIn: args.isOptedIn,
        areas,
        brandsCarried,
        whatsappNumber,
        isDeleted: false,
        deletedAt: undefined,
        deletedBy: undefined,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("marketplaceDealerProfiles", {
      orgId: args.orgId,
      isOptedIn: args.isOptedIn,
      areas,
      brandsCarried,
      whatsappNumber,
      badges: [],
      totalResponses: 0,
      totalAccepted: 0,
      tier: "FREE_FOUNDING",
      leadsUsedThisPeriod: 0,
      foundingWindowEndsAt: now + FOUNDING_WINDOW_MS,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Public: the cross-org dealer directory — no auth, marketplace.autoflow buyer-facing. */
export const listPublicDirectory = query({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db
      .query("marketplaceDealerProfiles")
      .withIndex("by_opted_in", (q) => q.eq("isOptedIn", true))
      .take(MAX_DIRECTORY_ROWS);

    const rows = await Promise.all(
      profiles
        .filter((profile) => !profile.isDeleted)
        .sort(compareDealerRank)
        .map(async (profile) => {
          const org = await ctx.db.get(profile.orgId);
          if (!org || org.suspended) return null;

          const [orgSettings, activeVehicles, siteUrl] = await Promise.all([
            ctx.db
              .query("orgSettings")
              .withIndex("by_org", (q) => q.eq("orgId", profile.orgId))
              .unique(),
            ctx.db
              .query("vehicles")
              .withIndex("by_org_status", (q) => q.eq("orgId", profile.orgId).eq("status", "AVAILABLE"))
              .take(MAX_ACTIVE_VEHICLE_SAMPLE),
            resolveSiteUrl(ctx, profile.orgId),
          ]);

          let logoUrl: string | null = null;
          if (orgSettings?.logoStorageId) {
            try {
              logoUrl = await ctx.storage.getUrl(orgSettings.logoStorageId);
            } catch (error) {
              console.error(error);
            }
          }

          return {
            orgId: profile.orgId,
            dealershipName: orgSettings?.dealershipName ?? org.name,
            phone: orgSettings?.dealershipPhone ?? null,
            address: orgSettings?.dealershipAddress ?? null,
            logoUrl,
            siteUrl,
            areas: profile.areas,
            brandsCarried: profile.brandsCarried,
            badges: profile.badges,
            activeVehicleCount: activeVehicles.filter((vehicle) => !vehicle.isDeleted).length,
          };
        })
    );

    return rows.filter((row): row is NonNullable<typeof row> => row !== null);
  },
});
