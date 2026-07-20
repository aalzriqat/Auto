import { v, ConvexError } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { hookEmployeeAdvancePaid, hookEmployeeAdvanceRecovered } from "./accounting/workflowHooks";
import { toMinorUnits, fromMinorUnits } from "./utils/money";
import { paymentMethodValidator, normalizePaymentMethod } from "./utils/paymentMethods";

// ─── Employee compensation (fixed monthly salary) ──────────────────────────────

/**
 * Sets a team member's fixed monthly salary. History is kept: the previous
 * active row (if any) is deactivated and a new active row inserted, so past
 * payroll runs still reflect the salary that applied when they ran.
 */
export const setCompensation = mutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    monthlySalary: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      if (!(args.monthlySalary >= 0)) {
        throw new ConvexError("Monthly salary must be zero or a positive number.");
      }

      // Verify the target is a member of this org.
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId))
        .unique();
      if (!membership) {
        throw new ConvexError("User is not a member of this organization.");
      }

      const currency = await getOrgCurrency(ctx, args.orgId);
      const now = Date.now();

      const existing = await ctx.db
        .query("employeeCompensation")
        .withIndex("by_org_user_active", (q) =>
          q.eq("orgId", args.orgId).eq("userId", args.userId).eq("active", true)
        )
        .collect();
      for (const row of existing) {
        await ctx.db.patch(row._id, { active: false, updatedAt: now, updatedBy: user._id });
      }

      const id = await ctx.db.insert("employeeCompensation", {
        orgId: args.orgId,
        userId: args.userId,
        monthlySalaryMinor: toMinorUnits(args.monthlySalary, currency),
        currency,
        effectiveFrom: now,
        active: true,
        createdAt: now,
        createdBy: user._id,
        updatedAt: now,
        updatedBy: user._id,
      });
      return id;
    } catch (error) {
      console.error("payroll.setCompensation failed", error);
      if (error instanceof ConvexError) throw error;
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/** Lists the active compensation for every member (salary shown in major units). */
export const listCompensation = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_PAYROLL]);
    const rows = await ctx.db
      .query("employeeCompensation")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("active"), true))
      .collect();
    return await Promise.all(
      rows.map(async (r) => {
        const u = await ctx.db.get(r.userId);
        return {
          ...r,
          monthlySalary: fromMinorUnits(r.monthlySalaryMinor, r.currency),
          userName: u?.name ?? u?.email ?? "Unknown",
        };
      })
    );
  },
});

// ─── Employee advances (سلفة) — a recoverable ASSET, not an expense ─────────────

export const recordAdvance = mutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    amount: v.number(),
    date: v.optional(v.number()),
    method: v.optional(paymentMethodValidator),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      if (!(args.amount > 0)) {
        throw new ConvexError("Advance amount must be a positive number.");
      }
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId))
        .unique();
      if (!membership) {
        throw new ConvexError("User is not a member of this organization.");
      }

      const currency = await getOrgCurrency(ctx, args.orgId);
      const now = Date.now();
      const date = args.date ?? now;
      const method = normalizePaymentMethod(args.method);

      const advanceId = await ctx.db.insert("employeeAdvances", {
        orgId: args.orgId,
        userId: args.userId,
        amountMinor: toMinorUnits(args.amount, currency),
        recoveredMinor: 0,
        currency,
        date,
        method,
        status: "OUTSTANDING",
        note: args.note,
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      });

      // GL: Dr Employee Advances (asset) / Cr cash — NOT an expense.
      await hookEmployeeAdvancePaid(ctx, {
        orgId: args.orgId,
        advanceId,
        userId: args.userId,
        amountMinor: toMinorUnits(args.amount, currency),
        currency,
        paymentMethod: method,
        actorId: user._id,
        occurredAt: date,
      });

      return advanceId;
    } catch (error) {
      console.error("payroll.recordAdvance failed", error);
      if (error instanceof ConvexError) throw error;
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/** Records a direct (cash) repayment of an outstanding advance, in full. */
export const recoverAdvance = mutation({
  args: {
    orgId: v.id("organizations"),
    advanceId: v.id("employeeAdvances"),
    method: v.optional(paymentMethodValidator),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const advance = await ctx.db.get(args.advanceId);
      if (!advance || advance.isDeleted || advance.orgId !== args.orgId) {
        throw new ConvexError("Advance not found.");
      }
      if (advance.status !== "OUTSTANDING") {
        throw new ConvexError("Only an outstanding advance can be recovered.");
      }
      const outstandingMinor = advance.amountMinor - advance.recoveredMinor;
      if (outstandingMinor <= 0) {
        throw new ConvexError("This advance has nothing left to recover.");
      }

      const now = Date.now();
      const method = normalizePaymentMethod(args.method);
      await ctx.db.patch(args.advanceId, {
        recoveredMinor: advance.amountMinor,
        status: "RECOVERED",
        updatedAt: now,
      });

      // GL: Dr cash / Cr Employee Advances — the asset is settled.
      await hookEmployeeAdvanceRecovered(ctx, {
        orgId: args.orgId,
        advanceId: args.advanceId,
        userId: advance.userId,
        amountMinor: outstandingMinor,
        currency: advance.currency,
        paymentMethod: method,
        actorId: user._id,
        occurredAt: now,
      });
    } catch (error) {
      console.error("payroll.recoverAdvance failed", error);
      if (error instanceof ConvexError) throw error;
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/** Lists advances (optionally only outstanding), amounts shown in major units. */
export const listAdvances = query({
  args: {
    orgId: v.id("organizations"),
    onlyOutstanding: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_PAYROLL]);
    const rows = await ctx.db
      .query("employeeAdvances")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .collect();
    const filtered = args.onlyOutstanding ? rows.filter((r) => r.status === "OUTSTANDING") : rows;
    return await Promise.all(
      filtered.map(async (r) => {
        const u = await ctx.db.get(r.userId);
        return {
          ...r,
          amount: fromMinorUnits(r.amountMinor, r.currency),
          recovered: fromMinorUnits(r.recoveredMinor, r.currency),
          outstanding: fromMinorUnits(r.amountMinor - r.recoveredMinor, r.currency),
          userName: u?.name ?? u?.email ?? "Unknown",
        };
      })
    );
  },
});

/** Total outstanding advance (minor units) for one employee — used by the payroll run engine. */
export async function outstandingAdvanceMinor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">
): Promise<number> {
  const rows = await ctx.db
    .query("employeeAdvances")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .filter((q) => q.eq(q.field("status"), "OUTSTANDING"))
    .collect();
  return rows.reduce((sum, r) => sum + (r.amountMinor - r.recoveredMinor), 0);
}
