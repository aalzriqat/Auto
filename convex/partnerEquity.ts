import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyOwner, getActorName } from "./utils/notifications";

export const list = query({
  args: { 
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("partnerEquity")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    partnerName: v.string(),
    initialCapital: v.number(),
    currentBalance: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const equityId = await ctx.db.insert("partnerEquity", {
      orgId: args.orgId,
      partnerName: args.partnerName,
      initialCapital: args.initialCapital,
      currentBalance: args.currentBalance,
      notes: args.notes,
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "partnerEquity.changed", { actorName }, {
      link: `/${args.orgId}/accounting`,
    });

    return equityId;
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    equityId: v.id("partnerEquity"),
    partnerName: v.optional(v.string()),
    initialCapital: v.optional(v.number()),
    currentBalance: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, equityId, ...updates } = args;

    const equity = await ctx.db.get(equityId);
    if (!equity || equity.orgId !== orgId) {
      throw new ConvexError("Partner equity record not found in this organization.");
    }

    // Clean up undefined optional values
    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    await ctx.db.patch(equityId, cleanedUpdates);

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, orgId, "partnerEquity.changed", { actorName }, {
      link: `/${orgId}/accounting`,
    });
  },
});

// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    equityId: v.id("partnerEquity"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const equity = await ctx.db.get(args.equityId);
    if (!equity || equity.orgId !== args.orgId) {
      throw new ConvexError("Partner equity record not found in this organization.");
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.equityId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "partnerEquity.changed", { actorName }, {
      link: `/${args.orgId}/accounting`,
    });
  },
});
