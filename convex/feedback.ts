import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuth, requireTenantAuth, requireOwner, requireSuperAdmin } from "./utils/tenancy";
import { notifyUser } from "./utils/notifications";

export const submit = mutation({
  args: {
    orgId: v.id("organizations"),
    type: v.union(v.literal("BUG"), v.literal("FEATURE")),
    title: v.string(),
    description: v.optional(v.string()),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);
    await requireTenantAuth(ctx, args.orgId);

    await ctx.db.insert("feedback", {
      orgId: args.orgId,
      userId: user._id,
      type: args.type,
      title: args.title.trim(),
      description: args.description?.trim(),
      url: args.url,
      status: "OPEN",
      createdAt: Date.now(),
    });
  },
});

export const list = query({
  args: {
    orgId: v.id("organizations"),
    type: v.optional(v.union(v.literal("BUG"), v.literal("FEATURE"))),
    status: v.optional(v.union(v.literal("OPEN"), v.literal("CLOSED"))),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    let items = await ctx.db
      .query("feedback")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();

    if (args.type) items = items.filter((i) => i.type === args.type);
    if (args.status) items = items.filter((i) => i.status === args.status);

    const withUser = await Promise.all(
      items.map(async (item) => {
        const user = await ctx.db.get(item.userId);
        return { ...item, userName: user?.name ?? user?.email ?? "Unknown" };
      })
    );

    return withUser;
  },
});

export const myList = query({
  args: {
    orgId: v.id("organizations"),
    type: v.optional(v.union(v.literal("BUG"), v.literal("FEATURE"))),
    status: v.optional(v.union(v.literal("OPEN"), v.literal("CLOSED"))),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);
    await requireTenantAuth(ctx, args.orgId);

    const type = args.type;
    const status = args.status;

    if (type && status) {
      return await ctx.db
        .query("feedback")
        .withIndex("by_org_user_type_status", (q) =>
          q.eq("orgId", args.orgId).eq("userId", user._id).eq("type", type).eq("status", status)
        )
        .order("desc")
        .collect();
    }

    if (type) {
      return await ctx.db
        .query("feedback")
        .withIndex("by_org_user_type", (q) => q.eq("orgId", args.orgId).eq("userId", user._id).eq("type", type))
        .order("desc")
        .collect();
    }

    if (status) {
      return await ctx.db
        .query("feedback")
        .withIndex("by_org_user_status", (q) =>
          q.eq("orgId", args.orgId).eq("userId", user._id).eq("status", status)
        )
        .order("desc")
        .collect();
    }

    return await ctx.db
      .query("feedback")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .order("desc")
      .collect();
  },
});

export const setStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    feedbackId: v.id("feedback"),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    const patch: Record<string, unknown> = { status: args.status };
    if (args.status === "CLOSED") patch.resolvedAt = Date.now();
    await ctx.db.patch(args.feedbackId, patch);
  },
});

// ─── Super-admin functions ─────────────────────────────────────────────────────

export const adminList = query({
  args: {
    type: v.optional(v.union(v.literal("BUG"), v.literal("FEATURE"))),
    status: v.optional(v.union(v.literal("OPEN"), v.literal("CLOSED"))),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);

    let items = await ctx.db.query("feedback").order("desc").collect();

    if (args.type) items = items.filter((i) => i.type === args.type);
    if (args.status) items = items.filter((i) => i.status === args.status);

    return await Promise.all(
      items.map(async (item) => {
        const user = await ctx.db.get(item.userId);
        const org = await ctx.db.get(item.orgId);
        return {
          ...item,
          userName: user?.name ?? user?.email ?? "Unknown",
          orgName: org?.name ?? "Unknown Org",
        };
      })
    );
  },
});

export const adminSetStatus = mutation({
  args: {
    feedbackId: v.id("feedback"),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const item = await ctx.db.get(args.feedbackId);
    if (!item) throw new Error("Feedback not found");
    const patch: Record<string, unknown> = { status: args.status };
    if (args.status === "CLOSED") patch.resolvedAt = Date.now();
    else patch.resolvedAt = undefined;
    await ctx.db.patch(args.feedbackId, patch);
    if (args.status === "CLOSED") {
      const orgId = item.orgId;
      const link = `/${orgId}/settings/feedback`;
      await notifyUser(ctx, orgId, item.userId, "feedback.resolved", { title: item.title }, { link });
    }
  },
});

export const adminReply = mutation({
  args: {
    feedbackId: v.id("feedback"),
    reply: v.string(),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const item = await ctx.db.get(args.feedbackId);
    if (!item) throw new Error("Feedback not found");
    await ctx.db.patch(args.feedbackId, {
      adminReply: args.reply.trim(),
      adminRepliedAt: Date.now(),
    });
    const orgId = item.orgId;
    const link = `/${orgId}/settings/feedback`;
    await notifyUser(ctx, orgId, item.userId, "feedback.replied", { title: item.title }, { link });
  },
});
