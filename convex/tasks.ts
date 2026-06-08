import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
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
    communicationMethod: v.optional(v.union(v.literal("PHONE"), v.literal("EMAIL"), v.literal("FAX"))),
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_TASKS]);

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

    const taskId = await ctx.db.insert("tasks", {
      orgId: args.orgId,
      assignedTo: args.assignedTo,
      title: args.title,
      description: args.description,
      dueDate: args.dueDate,
      status: args.status,
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

    const patch: Record<string, any> = {};
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

    const history = await ctx.db
      .query("taskHistory")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .collect();

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
