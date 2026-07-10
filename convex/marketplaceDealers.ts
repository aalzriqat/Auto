import { v } from "convex/values";
import { query, mutation, QueryCtx, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { PERMISSIONS } from "./utils/permissions";
import { requireTenantAuth } from "./utils/tenancy";
import { hasPlanFeature } from "./subscriptions";

const MAX_AREAS = 20;
const MAX_BRANDS = 40;
const MAX_DIRECTORY_ROWS = 100;
const MAX_ACTIVE_VEHICLE_SAMPLE = 200;

function normalizeStringList(values: string[], max: number): string[] {
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return Array.from(new Set(cleaned)).slice(0, max);
}

async function getOwnProfile(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
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
