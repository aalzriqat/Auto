import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";

export const listByCustomer = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    return await ctx.db
      .query("guarantors")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true)).collect();
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    firstName: v.string(),
    lastName: v.string(),
    nationalId: v.string(),
    phone: v.string(),
    relationship: v.optional(v.string()),
    income: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_CUSTOMERS]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.isDeleted || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    const id = await ctx.db.insert("guarantors", {
      orgId: args.orgId,
      customerId: args.customerId,
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      nationalId: args.nationalId.trim(),
      phone: args.phone.trim(),
      relationship: args.relationship?.trim(),
      income: args.income,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "Guarantor Added",
      `${actorName} added a guarantor for ${customer.firstName} ${customer.lastName}`,
      `/customers?highlightId=${args.customerId}`
    );

    return id;
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    guarantorId: v.id("guarantors"),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    phone: v.optional(v.string()),
    relationship: v.optional(v.string()),
    income: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_CUSTOMERS]);

    const guarantor = await ctx.db.get(args.guarantorId);
    if (!guarantor || guarantor.isDeleted || guarantor.orgId !== args.orgId) {
      throw new ConvexError("Guarantor not found in this organization.");
    }

    const patch: Record<string, any> = {};
    if (args.firstName !== undefined) patch.firstName = args.firstName.trim();
    if (args.lastName !== undefined) patch.lastName = args.lastName.trim();
    if (args.nationalId !== undefined) patch.nationalId = args.nationalId.trim();
    if (args.phone !== undefined) patch.phone = args.phone.trim();
    if (args.relationship !== undefined) patch.relationship = args.relationship?.trim();
    if (args.income !== undefined) patch.income = args.income;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.guarantorId, patch);
    }
  },
});

// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    guarantorId: v.id("guarantors"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_CUSTOMERS]);

    const guarantor = await ctx.db.get(args.guarantorId);
    if (!guarantor || guarantor.isDeleted || guarantor.orgId !== args.orgId) {
      throw new ConvexError("Guarantor not found in this organization.");
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.guarantorId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });
  },
});
