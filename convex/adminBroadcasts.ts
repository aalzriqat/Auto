import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireSuperAdmin } from "./utils/tenancy";
import { notifyAllMembers } from "./utils/notifications";
import { logAdminAction } from "./adminAudit";

/**
 * Sends a platform-wide or single-org announcement. Super-admin-authored
 * text bypasses the bilingual registry (lib/notifications/types.ts) — see
 * the "system.announcement" special case in lib/notifications/render.ts —
 * since this is free-form content typed by an operator, not a translated
 * template.
 */
export const create = mutation({
  args: {
    audience: v.union(v.literal("all_orgs"), v.literal("one_org")),
    orgId: v.optional(v.id("organizations")),
    title: v.string(),
    message: v.string(),
    link: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);

    if (args.audience === "one_org" && !args.orgId) {
      throw new Error("orgId is required when audience is one_org.");
    }

    const targetOrgIds = args.audience === "one_org"
      ? [args.orgId!]
      : (await ctx.db.query("organizations").collect()).map((o) => o._id);

    let recipientCount = 0;
    for (const orgId of targetOrgIds) {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      recipientCount += memberships.length;

      await notifyAllMembers(ctx, orgId, "system.announcement", {
        title: args.title,
        message: args.message,
      }, { link: args.link });
    }

    const broadcastId = await ctx.db.insert("notificationBroadcasts", {
      orgId: args.audience === "one_org" ? args.orgId : undefined,
      title: args.title,
      message: args.message,
      link: args.link,
      createdBy: admin._id,
      createdAt: Date.now(),
      recipientCount,
    });

    await logAdminAction(ctx, admin, {
      action: "broadcast:create",
      targetTable: "notificationBroadcasts",
      targetId: broadcastId,
      orgId: args.audience === "one_org" ? args.orgId : undefined,
      after: { audience: args.audience, title: args.title, recipientCount },
    });

    return broadcastId;
  },
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    return await ctx.db
      .query("notificationBroadcasts")
      .withIndex("by_createdAt")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
