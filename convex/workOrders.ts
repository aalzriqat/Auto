import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { hookExpensePosted, getOrgCurrency } from "./accounting/workflowHooks";
import { toMinorUnits, assertFiniteNumber } from "./utils/money";
import { Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { runWithIdempotency } from "./utils/idempotency";
import { costBearerValidator, type CostBearer } from "./utils/costBearer";

/**
 * SCRUM-389 phase 1. Resolves the bearer a work-order expense is recorded
 * under, refusing before anything is written. A SOURCED vehicle belongs to a
 * supplier, so the choice cannot be defaulted there; SUPPLIER is refused
 * outright until work orders open a supplier-cost recovery (SCRUM-402).
 */
async function resolveWorkOrderCostBearer(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles">; costBearer: CostBearer | undefined }
): Promise<CostBearer> {
  const vehicle = await ctx.db.get(args.vehicleId);
  if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
    throw new ConvexError("Vehicle not found in this organization.");
  }
  if (args.costBearer === "SUPPLIER") {
    throw new ConvexError(
      "A work order cannot be charged to the supplier yet. Record it as a vehicle expense borne by the supplier instead."
    );
  }
  if (vehicle.sourceType === "SOURCED" && args.costBearer === undefined) {
    throw new ConvexError(
      "This vehicle is sourced from a supplier. Choose who bears the work order's cost before completing it."
    );
  }
  return "SHOWROOM";
}

async function createWorkOrderExpense(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    title: string;
    amount: number;
    notes: string | undefined;
    actorId: Id<"users">;
    costBearer: CostBearer | undefined;
  }
): Promise<Id<"expenses">> {
  const costBearer = await resolveWorkOrderCostBearer(ctx, args);
  const now = Date.now();
  const expenseId = await ctx.db.insert("expenses", {
    costBearer,
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
    costBearer,
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

/**
 * A NaN in any task cost makes totalCost NaN, and `totalCost > 0` is false for
 * NaN — so the work order would persist while its expense and GL posting were
 * silently skipped, with no error anywhere. Shared by `create` and `update` so
 * the rule cannot drift between the two.
 */
function assertTaskCostsFinite(
  tasks: ReadonlyArray<{ partsCost: number; laborCost: number }>
): void {
  for (const task of tasks) {
    assertFiniteNumber(task.partsCost, "parts cost");
    assertFiniteNumber(task.laborCost, "labor cost");
  }
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

const workOrderTasksValidator = v.array(
  v.object({
    id: v.string(),
    description: v.string(),
    partsCost: v.number(),
    laborCost: v.number(),
    mechanicName: v.optional(v.string()),
    completed: v.boolean(),
  })
);

/**
 * SCRUM-389 — who bears a completed work order's cost. Required when the
 * vehicle is SOURCED (the showroom must say it is carrying a supplier's car's
 * repair), and only SHOWROOM is accepted in phase 1: a supplier-borne work
 * order needs its own recovery wiring (SCRUM-402).
 */
const workOrderCostBearerArg = v.optional(costBearerValidator);

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    title: v.string(),
    status: v.union(v.literal("OPEN"), v.literal("IN_PROGRESS"), v.literal("COMPLETED")),
    tasks: workOrderTasksValidator,

    notes: v.optional(v.string()),
    costBearer: workOrderCostBearerArg,

    // SCRUM-313 census. A COMPLETED work order calls `createWorkOrderExpense`,
    // which mints an `expenses` id, writes a legacy `transactions` row and
    // posts EXPENSE_POSTED keyed on that fresh id — all BEFORE the work-order
    // row itself exists. So there is no durable object a retry could look at:
    // the state that would identify the retry is created last.
    //
    // That is precisely why `create` needs intent identity while `update` does
    // NOT (see the state guard on `update` below): `update` has an existing
    // work order carrying `expenseId`, and refuses on it.
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    assertTaskCostsFinite(args.tasks);
    const totalCost = args.tasks.reduce((sum, task) => sum + task.partsCost + task.laborCost, 0);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "workOrders.create",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          vehicleId: args.vehicleId.toString(),
          title: args.title,
          status: args.status,
          totalCost,
          // SCRUM-389. `undefined` is dropped by JSON.stringify, so a replay
          // stored before the bearer existed still matches its own fingerprint.
          costBearer: args.costBearer,
        }),
      },
      async () => {
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
        costBearer: args.costBearer,
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
      }
    );
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    workOrderId: v.id("workOrders"),
    title: v.string(),
    status: v.union(v.literal("OPEN"), v.literal("IN_PROGRESS"), v.literal("COMPLETED")),
    tasks: workOrderTasksValidator,

    notes: v.optional(v.string()),
    costBearer: workOrderCostBearerArg,

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

    assertTaskCostsFinite(args.tasks);
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
        costBearer: args.costBearer,
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
