import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  currency: "JOD",
  currencySymbol: "د.أ",
  enabledPaymentTypes: ["CASH", "INSTALLMENT"],
};

export function definedPatchFields(fields: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    patch[key] = value;
  }
  return patch;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns the orgSettings row for the given org, or null if not yet configured.
 */
export const get = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    // Return null gracefully during logout (brief window before redirect)
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    // Return null gracefully when activeOrgId from localStorage is stale
    // (e.g. different env, user removed from org, shared device) — the
    // OrgProvider will correct activeOrgId once orgs load.
    try {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);
    } catch {
      return null;
    }
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
    dealershipName: v.optional(v.string()),
    legalCompanyName: v.optional(v.string()),
    dealershipAddress: v.optional(v.string()),
    dealershipPhone: v.optional(v.string()),
    dealershipPhones: v.optional(v.array(v.string())),
    whatsappPhoneNumberId: v.optional(v.string()),
    whatsappApiToken: v.optional(v.string()),
    whatsappWebhookSecret: v.optional(v.string()),
    approvalThresholdEnabled: v.optional(v.boolean()),
    approvalMinProfitPercent: v.optional(v.number()),
    commissionTiers: v.optional(
      v.array(v.object({ minProfitAmount: v.number(), commissionPct: v.number() }))
    ),
    commissionMode: v.optional(v.union(v.literal("AUTO_TIERS"), v.literal("AUTO_MEMBER"), v.literal("MANUAL"))),
    generatedLeadAutoAssignmentEnabled: v.optional(v.boolean()),
    reservationHoldDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    if (args.reservationHoldDays !== undefined && args.reservationHoldDays <= 0) {
      throw new Error("Reservation hold days must be greater than zero.");
    }
    const touchesWhatsApp =
      args.whatsappPhoneNumberId !== undefined ||
      args.whatsappApiToken !== undefined ||
      args.whatsappWebhookSecret !== undefined;
    if (touchesWhatsApp) {
      await requireFeature(ctx, args.orgId, "whatsapp");
    }

    const existing = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    const { orgId, ...fields } = args;
    if (fields.dealershipPhones !== undefined) {
      fields.dealershipPhones = fields.dealershipPhones.map((phone) => phone.trim()).filter(Boolean);
    }

    if (existing) {
      const patch = definedPatchFields(fields);
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
        dealershipName: fields.dealershipName,
        legalCompanyName: fields.legalCompanyName,
        dealershipAddress: fields.dealershipAddress,
        dealershipPhone: fields.dealershipPhone,
        dealershipPhones: fields.dealershipPhones,
        whatsappPhoneNumberId: fields.whatsappPhoneNumberId,
        whatsappApiToken: fields.whatsappApiToken,
        whatsappWebhookSecret: fields.whatsappWebhookSecret,
        approvalThresholdEnabled: fields.approvalThresholdEnabled,
        approvalMinProfitPercent: fields.approvalMinProfitPercent,
        commissionTiers: fields.commissionTiers,
        commissionMode: fields.commissionMode,
        generatedLeadAutoAssignmentEnabled: fields.generatedLeadAutoAssignmentEnabled,
        reservationHoldDays: fields.reservationHoldDays,
      });
      return newId;
    }
  },
});

/**
 * Controls whether automated lead sources assign new leads to SALES members
 * in round-robin order. Owner-only because it changes routing behavior.
 */
export const setGeneratedLeadAutoAssignmentEnabled = mutation({
  args: {
    orgId: v.id("organizations"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    if (settings) {
      await ctx.db.patch(settings._id, {
        generatedLeadAutoAssignmentEnabled: args.enabled,
      });
      return settings._id;
    }

    return await ctx.db.insert("orgSettings", {
      orgId: args.orgId,
      currency: DEFAULT_SETTINGS.currency,
      currencySymbol: DEFAULT_SETTINGS.currencySymbol,
      enabledPaymentTypes: DEFAULT_SETTINGS.enabledPaymentTypes,
      generatedLeadAutoAssignmentEnabled: args.enabled,
    });
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
