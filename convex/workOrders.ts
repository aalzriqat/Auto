import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";

export const list = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    let results = [];
    if (args.vehicleId) {
      results = await ctx.db
        .query("workOrders")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId!))
        .filter((q) => q.neq(q.field("isDeleted"), true)).collect();
    } else {
      results = await ctx.db
        .query("workOrders")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true)).collect();
    }

    return await Promise.all(
      results.map(async (wo) => {
        const vehicle = await ctx.db.get(wo.vehicleId);
        return {
          ...wo,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
        };
      })
    );
  },
});

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    title: v.string(),
    status: v.union(v.literal("OPEN"), v.literal("IN_PROGRESS"), v.literal("COMPLETED")),
    tasks: v.array(
      v.object({
        id: v.string(),
        description: v.string(),
        partsCost: v.number(),
        laborCost: v.number(),
        mechanicName: v.optional(v.string()),
        completed: v.boolean(),
      })
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const totalCost = args.tasks.reduce((sum, task) => sum + task.partsCost + task.laborCost, 0);

    let expenseId = undefined;

    // If creating a COMPLETED work order, sync to expenses
    if (args.status === "COMPLETED" && totalCost > 0) {
      expenseId = await ctx.db.insert("expenses", {
        orgId: args.orgId,
        vehicleId: args.vehicleId,
        title: `Work Order: ${args.title}`,
        amount: totalCost,
        date: Date.now(),
        category: "REPAIR",
        status: "PAID",
        notes: args.notes,
      });
    }

    const workOrderId = await ctx.db.insert("workOrders", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      title: args.title,
      status: args.status,
      totalCost,
      tasks: args.tasks,
      expenseId,
      notes: args.notes,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "workOrder.created",
      { actorName, label: args.title },
      { link: `/${args.orgId}/vehicles?highlightId=${args.vehicleId}` }
    );

    return workOrderId;
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    workOrderId: v.id("workOrders"),
    title: v.string(),
    status: v.union(v.literal("OPEN"), v.literal("IN_PROGRESS"), v.literal("COMPLETED")),
    tasks: v.array(
      v.object({
        id: v.string(),
        description: v.string(),
        partsCost: v.number(),
        laborCost: v.number(),
        mechanicName: v.optional(v.string()),
        completed: v.boolean(),
      })
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const wo = await ctx.db.get(args.workOrderId);
    if (!wo || wo.isDeleted || wo.orgId !== args.orgId) throw new ConvexError("Work Order not found");

    const totalCost = args.tasks.reduce((sum, task) => sum + task.partsCost + task.laborCost, 0);

    let expenseId = wo.expenseId;

    // If changing status to COMPLETED and no expense exists, create it
    if (args.status === "COMPLETED" && !expenseId && totalCost > 0) {
      expenseId = await ctx.db.insert("expenses", {
        orgId: args.orgId,
        vehicleId: wo.vehicleId,
        title: `Work Order: ${args.title}`,
        amount: totalCost,
        date: Date.now(),
        category: "REPAIR",
        status: "PAID",
        notes: args.notes,
      });
    } 
    // If expense already exists, update it
    else if (expenseId) {
      await ctx.db.patch(expenseId, {
        title: `Work Order: ${args.title}`,
        amount: totalCost,
        notes: args.notes,
      });
    }

    await ctx.db.patch(args.workOrderId, {
      title: args.title,
      status: args.status,
      totalCost,
      tasks: args.tasks,
      notes: args.notes,
      expenseId,
    });

    if (args.status === "COMPLETED" && wo.status !== "COMPLETED") {
      await notifyManagers(
        ctx,
        args.orgId,
        "workOrder.completed",
        { label: args.title },
        { link: `/${args.orgId}/vehicles?highlightId=${wo.vehicleId}` }
      );
    }
  },
});

// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    workOrderId: v.id("workOrders"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);
    
    const wo = await ctx.db.get(args.workOrderId);
    if (!wo || wo.isDeleted || wo.orgId !== args.orgId) throw new ConvexError("Work Order not found");

    if (wo.expenseId) {
      const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(wo.expenseId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.workOrderId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });
  },
});
