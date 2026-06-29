import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { auditLog } from "./financialAudit";

const periodStatusValidator = v.union(
  v.literal("FUTURE"),
  v.literal("OPEN"),
  v.literal("CLOSING"),
  v.literal("CLOSED"),
  v.literal("LOCKED"),
);

// ─── Internal helpers ─────────────────────────────────────────────────────────

export async function assertPostingAllowed(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  accountingDate: number
): Promise<Id<"accountingPeriods">> {
  const period = await ctx.db
    .query("accountingPeriods")
    .withIndex("by_org_startDate", (q) => q.eq("orgId", orgId))
    .filter((q) =>
      q.and(
        q.lte(q.field("startDate"), accountingDate),
        q.gte(q.field("endDate"), accountingDate)
      )
    )
    .first();

  if (!period) {
    throw new ConvexError(
      `No accounting period found for date ${new Date(accountingDate).toISOString().slice(0, 10)}. Create and open a period first.`
    );
  }
  if (period.status === "CLOSED" || period.status === "LOCKED") {
    throw new ConvexError(
      `Accounting period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")} is ${period.status}. Posting into closed or locked periods is not allowed.`
    );
  }
  if (period.status === "FUTURE") {
    throw new ConvexError(
      `Accounting period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")} has not been opened yet.`
    );
  }
  return period._id;
}

export async function getOpenPeriodForDate(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  date: number
): Promise<{ _id: Id<"accountingPeriods">; fiscalYear: number; periodNumber: number } | null> {
  const period = await ctx.db
    .query("accountingPeriods")
    .withIndex("by_org_startDate", (q) => q.eq("orgId", orgId))
    .filter((q) =>
      q.and(
        q.lte(q.field("startDate"), date),
        q.gte(q.field("endDate"), date),
        q.eq(q.field("status"), "OPEN")
      )
    )
    .first();
  if (!period) return null;
  return { _id: period._id, fiscalYear: period.fiscalYear, periodNumber: period.periodNumber };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(periodStatusValidator),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    let q;
    if (args.status) {
      q = ctx.db
        .query("accountingPeriods")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status!));
    } else {
      q = ctx.db
        .query("accountingPeriods")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId));
    }
    return await q.collect();
  },
});

export const get = query({
  args: {
    orgId: v.id("organizations"),
    periodId: v.id("accountingPeriods"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const period = await ctx.db.get(args.periodId);
    if (!period || period.orgId !== args.orgId) return null;
    return period;
  },
});

export const currentOpenPeriod = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const now = Date.now();
    return ctx.db
      .query("accountingPeriods")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "OPEN"))
      .filter((q) =>
        q.and(q.lte(q.field("startDate"), now), q.gte(q.field("endDate"), now))
      )
      .first();
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    fiscalYear: v.number(),
    periodNumber: v.number(),
    startDate: v.number(),
    endDate: v.number(),
    openImmediately: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (args.startDate >= args.endDate) {
      throw new ConvexError("Period start date must be before end date.");
    }

    const conflict = await ctx.db
      .query("accountingPeriods")
      .withIndex("by_org_year_period", (q) =>
        q
          .eq("orgId", args.orgId)
          .eq("fiscalYear", args.fiscalYear)
          .eq("periodNumber", args.periodNumber)
      )
      .unique();
    if (conflict) {
      throw new ConvexError(
        `Period ${args.fiscalYear}-${String(args.periodNumber).padStart(2, "0")} already exists.`
      );
    }

    // Reject overlapping date ranges
    const overlap = await ctx.db
      .query("accountingPeriods")
      .withIndex("by_org_startDate", (q) => q.eq("orgId", args.orgId))
      .filter((q) =>
        q.and(
          q.lte(q.field("startDate"), args.endDate),
          q.gte(q.field("endDate"), args.startDate)
        )
      )
      .first();
    if (overlap) {
      throw new ConvexError(
        `Period dates overlap with ${overlap.fiscalYear}-${String(overlap.periodNumber).padStart(2, "0")}.`
      );
    }

    const now = Date.now();
    const status = args.openImmediately ? "OPEN" : "FUTURE";
    const periodId = await ctx.db.insert("accountingPeriods", {
      orgId: args.orgId,
      fiscalYear: args.fiscalYear,
      periodNumber: args.periodNumber,
      startDate: args.startDate,
      endDate: args.endDate,
      status,
      createdAt: now,
      createdBy: user._id,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "CREATE_PERIOD",
      resourceType: "accountingPeriods",
      resourceId: periodId.toString(),
      description: `Created period ${args.fiscalYear}-${String(args.periodNumber).padStart(2, "0")} (status: ${status})`,
    });

    return periodId;
  },
});

export const open = mutation({
  args: {
    orgId: v.id("organizations"),
    periodId: v.id("accountingPeriods"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const period = await ctx.db.get(args.periodId);
    if (!period || period.orgId !== args.orgId) {
      throw new ConvexError("Period not found in this organization.");
    }
    if (period.status !== "FUTURE" && period.status !== "CLOSING") {
      throw new ConvexError(`Cannot open a period with status "${period.status}".`);
    }

    await ctx.db.patch(args.periodId, { status: "OPEN" });
    await auditLog(ctx, {
      orgId: args.orgId, actorId: user._id, actionType: "OPEN_PERIOD",
      resourceType: "accountingPeriods", resourceId: args.periodId.toString(),
      description: `Opened period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}`,
    });
    return args.periodId;
  },
});

export const close = mutation({
  args: {
    orgId: v.id("organizations"),
    periodId: v.id("accountingPeriods"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const period = await ctx.db.get(args.periodId);
    if (!period || period.orgId !== args.orgId) {
      throw new ConvexError("Period not found in this organization.");
    }
    if (period.status !== "OPEN" && period.status !== "CLOSING") {
      throw new ConvexError(`Cannot close a period with status "${period.status}".`);
    }

    const now = Date.now();
    await ctx.db.patch(args.periodId, {
      status: "CLOSED",
      closedBy: user._id,
      closedAt: now,
    });
    await auditLog(ctx, {
      orgId: args.orgId, actorId: user._id, actionType: "CLOSE_PERIOD",
      resourceType: "accountingPeriods", resourceId: args.periodId.toString(),
      description: `Closed period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}`,
    });
    return args.periodId;
  },
});

export const lock = mutation({
  args: {
    orgId: v.id("organizations"),
    periodId: v.id("accountingPeriods"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const period = await ctx.db.get(args.periodId);
    if (!period || period.orgId !== args.orgId) {
      throw new ConvexError("Period not found in this organization.");
    }
    if (period.status !== "CLOSED") {
      throw new ConvexError(`Can only lock a CLOSED period. Current status: "${period.status}".`);
    }

    await ctx.db.patch(args.periodId, { status: "LOCKED" });
    await auditLog(ctx, {
      orgId: args.orgId, actorId: user._id, actionType: "LOCK_PERIOD",
      resourceType: "accountingPeriods", resourceId: args.periodId.toString(),
      description: `Locked period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}`,
    });
    return args.periodId;
  },
});

export const reopen = mutation({
  args: {
    orgId: v.id("organizations"),
    periodId: v.id("accountingPeriods"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const period = await ctx.db.get(args.periodId);
    if (!period || period.orgId !== args.orgId) {
      throw new ConvexError("Period not found in this organization.");
    }
    if (period.status === "LOCKED") {
      throw new ConvexError("Locked periods cannot be reopened through this mutation. Use the break-glass process.");
    }
    if (period.status !== "CLOSED" && period.status !== "CLOSING") {
      throw new ConvexError(`Cannot reopen a period with status "${period.status}".`);
    }
    if (!args.reason.trim()) {
      throw new ConvexError("A reason is required when reopening a period.");
    }

    const now = Date.now();
    await ctx.db.patch(args.periodId, {
      status: "OPEN",
      reopenedBy: user._id,
      reopenedAt: now,
      reopenReason: args.reason.trim(),
    });
    await auditLog(ctx, {
      orgId: args.orgId, actorId: user._id, actionType: "REOPEN_PERIOD",
      resourceType: "accountingPeriods", resourceId: args.periodId.toString(),
      description: `Reopened period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}: ${args.reason.trim()}`,
    });
    return args.periodId;
  },
});
