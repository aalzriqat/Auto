import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { NOTIFICATION_CATEGORIES, categoryDefaultEmail } from "../lib/notifications/types";
import { requireFeature } from "./subscriptions";

/**
 * Returns the caller's preferences for every category, filling in the
 * computed default (see categoryDefaultEmail) for any category that has no
 * explicit row yet — mirrors the fallback logic in convex/utils/notifications.ts dispatch().
 */
export const getMyPreferences = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const rows = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_org_user_category", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .collect();

    const byCategory = new Map(rows.map((r) => [r.category, r]));

    return NOTIFICATION_CATEGORIES.map((category) => {
      const row = byCategory.get(category);
      return {
        category,
        emailEnabled: row ? row.emailEnabled : categoryDefaultEmail(category),
        whatsappEnabled: row ? row.whatsappEnabled : false,
      };
    });
  },
});

export const setPreference = mutation({
  args: {
    orgId: v.id("organizations"),
    category: v.string(),
    emailEnabled: v.boolean(),
    whatsappEnabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);
    if (args.whatsappEnabled) {
      await requireFeature(ctx, args.orgId, "whatsapp");
    }

    const existing = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_org_user_category", (q) =>
        q.eq("orgId", args.orgId).eq("userId", user._id).eq("category", args.category)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        emailEnabled: args.emailEnabled,
        whatsappEnabled: args.whatsappEnabled,
      });
    } else {
      await ctx.db.insert("notificationPreferences", {
        orgId: args.orgId,
        userId: user._id,
        category: args.category,
        emailEnabled: args.emailEnabled,
        whatsappEnabled: args.whatsappEnabled,
      });
    }
  },
});
