import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";

export const list = query({
  args: { 
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("claims")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    claimDate: v.number(),
    financingEntity: v.string(),
    buyerName: v.string(),
    claimAmount: v.number(),
    status: v.union(v.literal("PENDING"), v.literal("PAID"), v.literal("REJECTED")),
    notes: v.optional(v.string()),
    saleId: v.optional(v.id("sales")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (args.saleId) {
      const sale = await ctx.db.get(args.saleId);
      if (!sale || sale.orgId !== args.orgId) {
        throw new ConvexError("Sale not found in this organization.");
      }
    }

    const claimId = await ctx.db.insert("claims", {
      orgId: args.orgId,
      claimDate: args.claimDate,
      financingEntity: args.financingEntity,
      buyerName: args.buyerName,
      claimAmount: args.claimAmount,
      status: args.status,
      notes: args.notes,
      saleId: args.saleId,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "claim.updated",
      { actorName, claimLabel: `${args.buyerName} (${args.financingEntity})` },
      { link: `/${args.orgId}/accounting` }
    );

    return claimId;
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"), v.literal("REJECTED"))),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, claimId, ...updates } = args;

    const claim = await ctx.db.get(claimId);
    if (!claim || claim.orgId !== orgId) {
      throw new ConvexError("Claim not found in this organization.");
    }

    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    await ctx.db.patch(claimId, cleanedUpdates);

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      orgId,
      "claim.updated",
      { actorName, claimLabel: `${claim.buyerName} (${claim.financingEntity})` },
      { link: `/${orgId}/accounting` }
    );
  },
});

// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.orgId !== args.orgId) {
      throw new ConvexError("Claim not found in this organization.");
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.claimId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "claim.updated",
      { actorName, claimLabel: `${claim.buyerName} (${claim.financingEntity})` },
      { link: `/${args.orgId}/accounting` }
    );
  },
});
