import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists all tasks for an organization.
 * Optionally filters by assigned user, customer, or status.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    assignedTo: v.optional(v.id("users")),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("COMPLETED"))),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_TASKS]);

    let results;

    if (args.assignedTo) {
      results = await ctx.db
        .query("tasks")
        .withIndex("by_org_assignedTo", (q) =>
          q.eq("orgId", args.orgId).eq("assignedTo", args.assignedTo!)
        )
        .collect();
    } else {
      results = await ctx.db
        .query("tasks")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect();
    }

    if (args.status) {
      results = results.filter((t) => t.status === args.status);
    }

    // Hydrate associations
    return await Promise.all(
      results.map(async (task) => {
        let assigneeName = "Unknown";
        const assignee = await ctx.db.get(task.assignedTo);
        if (assignee) {
          assigneeName = assignee.name || assignee.email;
        }

        let customerName = null;
        if (task.customerId) {
          const customer = await ctx.db.get(task.customerId);
          if (customer) {
            customerName = `${customer.firstName} ${customer.lastName}`;
          }
        }

        return {
          ...task,
          assigneeName,
          customerName,
        };
      })
    );
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    assignedTo: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    dueDate: v.number(),
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED")),
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_TASKS]);

    // Ensure assignee is a member
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.assignedTo)
      )
      .unique();

    if (!membership) {
      throw new ConvexError("Assigned user is not a member of this organization.");
    }

    return await ctx.db.insert("tasks", {
      orgId: args.orgId,
      assignedTo: args.assignedTo,
      title: args.title,
      description: args.description,
      dueDate: args.dueDate,
      status: args.status,
      customerId: args.customerId,
      leadId: args.leadId,
    });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    taskId: v.id("tasks"),
    assignedTo: v.optional(v.id("users")),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    dueDate: v.optional(v.number()),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("COMPLETED"))),
    customerId: v.optional(v.union(v.id("customers"), v.null())),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_TASKS]);

    const task = await ctx.db.get(args.taskId);
    if (!task || task.orgId !== args.orgId) {
      throw new ConvexError("Task not found.");
    }

    const patch: Record<string, any> = {};

    if (args.assignedTo !== undefined) patch.assignedTo = args.assignedTo;
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.dueDate !== undefined) patch.dueDate = args.dueDate;
    if (args.status !== undefined) patch.status = args.status;
    
    if (args.customerId !== undefined) {
      patch.customerId = args.customerId === null ? undefined : args.customerId;
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.taskId, patch);
    }
  },
});

export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_TASKS]);

    const task = await ctx.db.get(args.taskId);
    if (!task || task.orgId !== args.orgId) {
      throw new ConvexError("Task not found.");
    }

    await ctx.db.delete(args.taskId);
  },
});
