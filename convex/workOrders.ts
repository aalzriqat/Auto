import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { hookExpensePosted, getOrgCurrency } from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";
import { Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";

async function createWorkOrderExpense(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    title: string;
    amount: number;
    notes: string | undefined;
    actorId: Id<"users">;
  }
): Promise<Id<"expenses">> {
  const now = Date.now();
  const expenseId = await ctx.db.insert("expenses", {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    title: args.title,
    amount: args.amount,
    date: now,
    category: "REPAIR",
    status: "PAID",
    notes: args.notes,
  });

  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: "OUT",
    amount: args.amount,
    date: now,
    category: "EXPENSE",
    description: args.title,
    vehicleId: args.vehicleId,
    expenseId,
  });

  const currency = await getOrgCurrency(ctx, args.orgId);
  await hookExpensePosted(ctx, {
    orgId: args.orgId,
    expenseId,
    amountMinor: toMinorUnits(args.amount, currency),
    currency,
    actorId: args.actorId,
    occurredAt: now,
  });

  return expenseId;
}

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
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const totalCost = args.tasks.reduce((sum, task) => sum + task.partsCost + task.laborCost, 0);

    let expenseId: Id<"expenses"> | undefined = undefined;

    // If creating a COMPLETED work order, sync to expenses with transaction + GL hook
    if (args.status === "COMPLETED" && totalCost > 0) {
      expenseId = await createWorkOrderExpense(ctx, {
        orgId: args.orgId,
        vehicleId: args.vehicleId,
        title: `Work Order: ${args.title}`,
        amount: totalCost,
        notes: args.notes,
        actorId: user._id,
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
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const wo = await ctx.db.get(args.workOrderId);
    if (!wo || wo.isDeleted || wo.orgId !== args.orgId) throw new ConvexError("Work Order not found");
    if (wo.expenseId) {
      throw new ConvexError(
        "Completed work orders with posted expenses are locked. Use a correction or reversal workflow before editing."
      );
    }

    const totalCost = args.tasks.reduce((sum, task) => sum + task.partsCost + task.laborCost, 0);

    let expenseId = wo.expenseId;

    // If changing status to COMPLETED and no expense exists, create it with transaction + GL hook
    if (args.status === "COMPLETED" && !expenseId && totalCost > 0) {
      expenseId = await createWorkOrderExpense(ctx, {
        orgId: args.orgId,
        vehicleId: wo.vehicleId,
        title: `Work Order: ${args.title}`,
        amount: totalCost,
        notes: args.notes,
        actorId: user._id,
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
      throw new ConvexError("Completed work orders with posted expenses cannot be deleted. Use a reversal workflow.");
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
