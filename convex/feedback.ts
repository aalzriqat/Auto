import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuth, requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

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

export const setStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    feedbackId: v.id("feedback"),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    await ctx.db.patch(args.feedbackId, { status: args.status });
  },
});
