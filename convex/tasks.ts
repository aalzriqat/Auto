import { v, ConvexError } from "convex/values";
import { MutationCtx, query } from "./_generated/server";
import { mutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth, requireOwnedRow } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyUser, getActorName } from "./utils/notifications";

async function requireTaskAssignee(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
) {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) =>
      q.eq("orgId", orgId).eq("userId", userId)
    )
    .unique();

  if (!membership) {
    throw new ConvexError("Assigned user is not a member of this organization.");
  }
}

async function validateTaskReferences(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId?: Id<"customers"> | null;
    leadId?: Id<"leads"> | null;
    vehicleId?: Id<"vehicles"> | null;
  },
) {
  const customerId = args.customerId ?? undefined;
  const leadId = args.leadId ?? undefined;
  const vehicleId = args.vehicleId ?? undefined;

  let customer: Doc<"customers"> | null = null;
  if (customerId) {
    customer = await ctx.db.get(customerId);
    if (!customer || customer.orgId !== args.orgId || customer.isDeleted) {
      throw new ConvexError("Customer not found.");
    }
  }

  let vehicle: Doc<"vehicles"> | null = null;
  if (vehicleId) {
    vehicle = await ctx.db.get(vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId || vehicle.isDeleted) {
      throw new ConvexError("Vehicle not found.");
    }
  }

  if (leadId) {
    const lead = await ctx.db.get(leadId);
    if (!lead || lead.orgId !== args.orgId || lead.isDeleted) {
      throw new ConvexError("Lead not found.");
    }
    if (customer && lead.customerId !== customer._id) {
      throw new ConvexError("Lead does not belong to the selected customer.");
    }
    if (vehicle && lead.vehicleId && lead.vehicleId !== vehicle._id) {
      throw new ConvexError("Lead does not belong to the selected vehicle.");
    }
  }
}

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
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_TASKS]);

    const q = args.assignedTo
      ? ctx.db.query("tasks").withIndex("by_org_assignedTo", (q2) =>
          q2.eq("orgId", args.orgId).eq("assignedTo", args.assignedTo!)
        )
      : ctx.db.query("tasks").withIndex("by_org", (q2) => q2.eq("orgId", args.orgId));

    const finalQ = args.status ? q.filter((q2) => q2.eq(q2.field("status"), args.status)) : q;

    const pageResult = await finalQ.filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);

    // Hydrate associations
    const page = await Promise.all(
      pageResult.page.map(async (task) => {
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
    
    return { ...pageResult, page };
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
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED"), v.literal("CANCELLED")),
    priority: v.optional(v.union(v.literal("HIGH"), v.literal("MEDIUM"), v.literal("LOW"))),
    communicationMethod: v.optional(v.union(v.literal("PHONE"), v.literal("EMAIL"), v.literal("FAX"))),
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_TASKS]);

    await requireTaskAssignee(ctx, args.orgId, args.assignedTo);
    await validateTaskReferences(ctx, {
      orgId: args.orgId,
      customerId: args.customerId,
      leadId: args.leadId,
      vehicleId: args.vehicleId,
    });

    const taskId = await ctx.db.insert("tasks", {
      orgId: args.orgId,
      assignedTo: args.assignedTo,
      title: args.title,
      description: args.description,
      dueDate: args.dueDate,
      status: args.status,
      priority: args.priority,
      communicationMethod: args.communicationMethod,
      customerId: args.customerId,
      leadId: args.leadId,
      vehicleId: args.vehicleId,
    });

    await ctx.db.insert("taskHistory", {
      orgId: args.orgId,
      taskId: taskId,
      userId: user._id,
      action: "CREATE",
      details: "Created the task.",
    });

    if (args.assignedTo !== user._id) {
      const actorName = await getActorName(ctx);
      await notifyUser(
        ctx,
        args.orgId,
        args.assignedTo,
        "task.assigned",
        { actorName, taskTitle: args.title },
        { link: `/${args.orgId}/tasks`, relatedTaskId: taskId }
      );
    }

    return taskId;
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
    status: v.optional(v.union(v.literal("PENDING"), v.literal("COMPLETED"), v.literal("CANCELLED"))),
    priority: v.optional(v.union(v.literal("HIGH"), v.literal("MEDIUM"), v.literal("LOW"))),
    statusNote: v.optional(v.string()),
    communicationMethod: v.optional(v.union(v.literal("PHONE"), v.literal("EMAIL"), v.literal("FAX"))),
    customerId: v.optional(v.union(v.id("customers"), v.null())),
    vehicleId: v.optional(v.union(v.id("vehicles"), v.null())),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_TASKS]);

    const task = await ctx.db.get(args.taskId);
    if (!task || task.isDeleted || task.orgId !== args.orgId) {
      throw new ConvexError("Task not found.");
    }

    if (args.assignedTo !== undefined) {
      await requireTaskAssignee(ctx, args.orgId, args.assignedTo);
    }
    await validateTaskReferences(ctx, {
      orgId: args.orgId,
      customerId: args.customerId === undefined ? undefined : args.customerId,
      leadId: task.leadId,
      vehicleId: args.vehicleId === undefined ? undefined : args.vehicleId,
    });

    const patch: Partial<Doc<"tasks">> = {};
    let action: "UPDATE" | "RESCHEDULE" | "CANCEL" | "STATUS_CHANGE" = "UPDATE";
    let details = "Updated task details.";
    const changes: string[] = [];

    if (args.assignedTo !== undefined && args.assignedTo !== task.assignedTo) {
      patch.assignedTo = args.assignedTo;
      changes.push("Reassigned the task.");
    }
    if (args.title !== undefined && args.title !== task.title) {
      patch.title = args.title;
      changes.push("Changed title.");
    }
    if (args.description !== undefined && args.description !== task.description) {
      patch.description = args.description;
      changes.push("Updated description.");
    }
    if (args.dueDate !== undefined && args.dueDate !== task.dueDate) {
      patch.dueDate = args.dueDate;
      patch.alarmTriggered = false;
      action = "RESCHEDULE";
      details = "Rescheduled the task.";
    }
    if (args.status !== undefined && args.status !== task.status) {
      patch.status = args.status;
      if (args.status === "CANCELLED") {
        action = "CANCEL";
        details = "Cancelled the task.";
      } else {
        action = "STATUS_CHANGE";
        details = `Marked task as ${args.status.toLowerCase()}.`;
        if (args.status === "PENDING") {
          patch.alarmTriggered = false;
        }
      }
    }
    if (args.statusNote !== undefined) {
      patch.statusNote = args.statusNote;
    }
    if (args.communicationMethod !== undefined && args.communicationMethod !== task.communicationMethod) {
      patch.communicationMethod = args.communicationMethod;
      changes.push(`Updated communication method to ${args.communicationMethod}.`);
    }

    if (args.customerId !== undefined) {
      patch.customerId = args.customerId === null ? undefined : args.customerId;
      changes.push(args.customerId ? "Linked customer." : "Removed customer link.");
    }

    if (args.vehicleId !== undefined) {
      patch.vehicleId = args.vehicleId === null ? undefined : args.vehicleId;
      changes.push(args.vehicleId ? "Linked vehicle." : "Removed vehicle link.");
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.taskId, patch);

      if (action === "UPDATE" && changes.length > 0) {
        details = changes.join(" ");
      }

      await ctx.db.insert("taskHistory", {
        orgId: args.orgId,
        taskId: args.taskId,
        userId: user._id,
        action,
        details,
        note: args.statusNote,
      });

      if (args.assignedTo !== undefined && args.assignedTo !== task.assignedTo && args.assignedTo !== user._id) {
        const actorName = await getActorName(ctx);
        await notifyUser(
          ctx,
          args.orgId,
          args.assignedTo,
          "task.assigned",
          { actorName, taskTitle: patch.title ?? task.title },
          { link: `/${args.orgId}/tasks`, relatedTaskId: args.taskId }
        );
      }
    }
  },
});

/**
 * Soft deletes a task.
 *
 * Mirrors `leads.softDelete`: the row stays, `list`/`update`/`getHistory`
 * already filter it out, and an admin can restore it. The taskHistory entry is
 * appended rather than cleared so the deletion is itself answerable for.
 */
export const softDelete = mutation({
  args: {
    orgId: v.id("organizations"),
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_TASKS]);
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new ConvexError("Unauthenticated");

      // requireTenantAuth only proves the caller may act inside the org they
      // named — never that this row belongs to it. Without this line a member
      // of org B can delete org A's task by naming org B honestly.
      const task = await requireOwnedRow(ctx, args.orgId, "tasks", args.taskId, "Task not found.");
      if (task.isDeleted) {
        throw new ConvexError("Task not found.");
      }

      await ctx.db.patch(args.taskId, {
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: identity.subject,
      });

      await ctx.db.insert("taskHistory", {
        orgId: args.orgId,
        taskId: args.taskId,
        userId: user._id,
        action: "DELETE",
        details: "Deleted the task.",
      });

      return null;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("tasks.softDelete failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

export const getHistory = query({
  args: {
    orgId: v.id("organizations"),
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_TASKS]);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.isDeleted || task.orgId !== args.orgId) {
      throw new ConvexError("Task not found.");
    }

    const history = (await ctx.db
      .query("taskHistory")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .collect()).filter((entry) => entry.orgId === args.orgId);

    // Resolve user names
    return Promise.all(
      history.map(async (entry) => {
        const user = await ctx.db.get(entry.userId);
        return {
          ...entry,
          userName: user ? user.name : "Unknown User",
        };
      })
    );
  },
});
