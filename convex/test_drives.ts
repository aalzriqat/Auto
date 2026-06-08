import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

export const list = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")),
    customerId: v.optional(v.id("customers")),
  },
  handler: async (ctx, args) => {
    // Requires view sales permission as test drives are sales related
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    let testDrives = [];
    if (args.vehicleId) {
      testDrives = await ctx.db
        .query("test_drives")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId!))
        .filter((q) => q.neq(q.field("isDeleted"), true)).collect();
    } else if (args.customerId) {
      testDrives = await ctx.db
        .query("test_drives")
        .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId!))
        .filter((q) => q.neq(q.field("isDeleted"), true)).collect();
    } else {
      testDrives = await ctx.db
        .query("test_drives")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true)).collect();
    }

    // Hydrate
    return await Promise.all(
      testDrives.map(async (td) => {
        const vehicle = await ctx.db.get(td.vehicleId);
        const customer = await ctx.db.get(td.customerId);
        const salesperson = await ctx.db.get(td.salespersonId);
        
        return {
          ...td,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          salespersonName: salesperson?.name ?? salesperson?.email ?? "Unknown",
        };
      })
    );
  },
});

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    startTime: v.number(),
    demoPlateNumber: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);
    
    // Verify vehicle and customer exist
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) throw new ConvexError("Vehicle not found");
    
    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.isDeleted || customer.orgId !== args.orgId) throw new ConvexError("Customer not found");

    return await ctx.db.insert("test_drives", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      customerId: args.customerId,
      salespersonId: args.salespersonId,
      startTime: args.startTime,
      demoPlateNumber: args.demoPlateNumber,
      notes: args.notes,
    });
  },
});

export const complete = mutation({
  args: {
    orgId: v.id("organizations"),
    testDriveId: v.id("test_drives"),
    endTime: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_SALES]);
    
    const td = await ctx.db.get(args.testDriveId);
    if (!td || td.isDeleted || td.orgId !== args.orgId) throw new ConvexError("Test drive not found");

    await ctx.db.patch(args.testDriveId, {
      endTime: args.endTime,
      notes: args.notes !== undefined ? args.notes : td.notes,
    });
  },
});

// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    testDriveId: v.id("test_drives"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_SALES]);
    
    const td = await ctx.db.get(args.testDriveId);
    if (!td || td.isDeleted || td.orgId !== args.orgId) throw new ConvexError("Test drive not found");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    await ctx.db.patch(args.testDriveId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });
  },
});
