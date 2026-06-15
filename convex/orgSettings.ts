import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  currency: "JOD",
  currencySymbol: "د.أ",
  enabledPaymentTypes: ["CASH", "INSTALLMENT"],
};

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns the orgSettings row for the given org, or null if not yet configured.
 */
export const get = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    return settings ?? null;
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Creates or updates orgSettings for the given org. Owner-only.
 */
export const upsert = mutation({
  args: {
    orgId: v.id("organizations"),
    currency: v.optional(v.string()),
    currencySymbol: v.optional(v.string()),
    vatRate: v.optional(v.number()),
    country: v.optional(v.string()),
    timezone: v.optional(v.string()),
    enabledPaymentTypes: v.optional(v.array(v.string())),
    logoStorageId: v.optional(v.id("_storage")),
    primaryColor: v.optional(v.string()),
    whatsappPhoneNumberId: v.optional(v.string()),
    whatsappApiToken: v.optional(v.string()),
    whatsappWebhookSecret: v.optional(v.string()),
    approvalThresholdEnabled: v.optional(v.boolean()),
    approvalMinProfitPercent: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const existing = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    const { orgId, ...fields } = args;

    if (existing) {
      // Patch only provided fields (exclude undefined values)
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
          patch[key] = value;
        }
      }
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    } else {
      // Create with defaults merged in
      const newId = await ctx.db.insert("orgSettings", {
        orgId,
        currency: fields.currency ?? DEFAULT_SETTINGS.currency,
        currencySymbol: fields.currencySymbol ?? DEFAULT_SETTINGS.currencySymbol,
        enabledPaymentTypes:
          fields.enabledPaymentTypes ?? DEFAULT_SETTINGS.enabledPaymentTypes,
        vatRate: fields.vatRate,
        country: fields.country,
        timezone: fields.timezone,
        logoStorageId: fields.logoStorageId,
        primaryColor: fields.primaryColor,
        whatsappPhoneNumberId: fields.whatsappPhoneNumberId,
        whatsappApiToken: fields.whatsappApiToken,
        whatsappWebhookSecret: fields.whatsappWebhookSecret,
        approvalThresholdEnabled: fields.approvalThresholdEnabled,
        approvalMinProfitPercent: fields.approvalMinProfitPercent,
      });
      return newId;
    }
  },
});

/**
 * Returns the Convex storage URL for the org's logo, or null if not set.
 */
export const getLogoUrl = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings?.logoStorageId) return null;
    return await ctx.storage.getUrl(settings.logoStorageId);
  },
});

/**
 * Generates a short-lived upload URL for the org logo. Owner-only.
 */
export const generateLogoUploadUrl = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    return await ctx.storage.generateUploadUrl();
  },
});
