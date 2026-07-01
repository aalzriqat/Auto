import { v, ConvexError } from "convex/values";
import { query, mutation } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";

/** Capped recent feed for the bell dropdown. */
export const list = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    // userId is derived from the authenticated identity, never trusted from the client.
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .order("desc") // newest first
      .take(75);

    return notifications.filter((n) => !n.isArchived).slice(0, 50);
  },
});

/** Unread count for the bell badge, via the indexed (orgId, userId, isRead) lookup. */
export const unreadCount = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_org_user_read", (q) =>
        q.eq("orgId", args.orgId).eq("userId", user._id).eq("isRead", false)
      )
      .collect();

    return unread.filter((n) => !n.isArchived).length;
  },
});

/** Paginated history for the dedicated /notifications page, with optional category/archived filters. */
export const listPage = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    category: v.optional(v.string()),
    showArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const wantArchived = Boolean(args.showArchived);

    const baseQuery = args.category
      ? ctx.db
          .query("notifications")
          .withIndex("by_org_user_category", (q) =>
            q.eq("orgId", args.orgId).eq("userId", user._id).eq("category", args.category)
          )
          // Filter archived state in the query chain (before paginate) to avoid
          // sparse pages from post-cursor JS filtering.
          .filter((q) =>
            wantArchived
              ? q.eq(q.field("isArchived"), true)
              : q.neq(q.field("isArchived"), true)
          )
      : ctx.db
          .query("notifications")
          // by_org_user_archived index covers the common case; isArchived is
          // stored as true or undefined (never false) so archived=false means
          // the field is absent, which Convex treats as undefined in eq checks.
          .withIndex("by_org_user_archived", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("userId", user._id)
              .eq("isArchived", wantArchived ? (true as const) : undefined)
          );

    return await baseQuery.order("desc").paginate(args.paginationOpts);
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
      .withIndex("by_org_user_read", (q) =>
        q.eq("orgId", args.orgId).eq("userId", user._id).eq("isRead", false)
      )
      .collect();

    for (const notif of unread) {
      await ctx.db.patch(notif._id, { isRead: true });
    }
  },
});

export const archive = mutation({
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

    await ctx.db.patch(args.notificationId, { isArchived: true, archivedAt: Date.now() });
  },
});
