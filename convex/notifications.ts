import { v, ConvexError } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";

export const list = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    // userId is derived from the authenticated identity, never trusted from the client.
    const { user } = await requireTenantAuth(ctx, args.orgId);

    return await ctx.db
      .query("notifications")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .order("desc") // newest first
      .take(50);
  },
});

export const markAsRead = mutation({
  args: {
    orgId: v.id("organizations"),
    notificationId: v.id("notifications"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.orgId !== args.orgId || notification.userId !== user._id) {
      throw new ConvexError("Notification not found.");
    }

    await ctx.db.patch(args.notificationId, { isRead: true });
  },
});

export const markAllAsRead = mutation({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .filter((q) => q.eq(q.field("isRead"), false))
      .collect();

    for (const notif of unread) {
      await ctx.db.patch(notif._id, { isRead: true });
    }
  },
});
