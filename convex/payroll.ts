import { v, ConvexError } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import {
  getOrgCurrency,
  hookEmployeeAdvancePaid,
  hookEmployeeAdvanceRecovered,
  hookPayrollAccrued,
  hookPayrollPaid,
  hookCommissionAccrued,
} from "./accounting/workflowHooks";
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

// ─── Monthly payroll run (Option A: commissions paid through payroll) ───────────

/**
 * Builds a DRAFT payroll run for a period: one payslip item per employee who
 * has a salary and/or unpaid commissions. Advances are deducted up to gross.
 * Nothing posts to the GL yet — that happens on approve (accrue) and pay.
 */
export const createRun = mutation({
  args: {
    orgId: v.id("organizations"),
    periodYear: v.number(),
    periodMonth: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      if (args.periodMonth < 1 || args.periodMonth > 12) {
        throw new ConvexError("Month must be between 1 and 12.");
      }

      const clash = await ctx.db
        .query("payrollRuns")
        .withIndex("by_org_period", (q) =>
          q.eq("orgId", args.orgId).eq("periodYear", args.periodYear).eq("periodMonth", args.periodMonth)
        )
        .filter((q) => q.neq(q.field("status"), "CANCELLED"))
        .first();
      if (clash) {
        throw new ConvexError("A payroll run already exists for this period.");
      }

      const currency = await getOrgCurrency(ctx, args.orgId);
      const now = Date.now();

      // Active salaries by user.
      const comps = await ctx.db
        .query("employeeCompensation")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.eq(q.field("active"), true))
        .collect();
      const salaryByUser = new Map<string, number>();
      for (const c of comps) salaryByUser.set(c.userId, c.monthlySalaryMinor);

      // Unpaid, completed commissions grouped by salesperson.
      const sales = await ctx.db
        .query("sales")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) =>
          q.and(
            q.neq(q.field("isDeleted"), true),
            q.eq(q.field("status"), "COMPLETED"),
            q.eq(q.field("commissionPaidAt"), undefined)
          )
        )
        .collect();
      const commissionByUser = new Map<string, { minor: number; saleIds: Id<"sales">[] }>();
      for (const s of sales) {
        if (!s.commissionAmount || s.commissionAmount <= 0) continue;
        const key = s.salespersonId;
        const entry = commissionByUser.get(key) ?? { minor: 0, saleIds: [] };
        entry.minor += toMinorUnits(s.commissionAmount, currency);
        entry.saleIds.push(s._id);
        commissionByUser.set(key, entry);
      }

      const userIds = new Set<string>([...salaryByUser.keys(), ...commissionByUser.keys()]);

      const runId = await ctx.db.insert("payrollRuns", {
        orgId: args.orgId,
        periodYear: args.periodYear,
        periodMonth: args.periodMonth,
        currency,
        status: "DRAFT",
        totalGrossMinor: 0,
        totalNetMinor: 0,
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      });

      let totalGross = 0;
      let totalNet = 0;
      for (const uid of userIds) {
        const userId = uid as Id<"users">;
        const baseSalaryMinor = salaryByUser.get(uid) ?? 0;
        const commission = commissionByUser.get(uid) ?? { minor: 0, saleIds: [] };
        const grossMinor = baseSalaryMinor + commission.minor;
        if (grossMinor <= 0) continue;

        const outstanding = await outstandingAdvanceMinor(ctx, args.orgId, userId);
        const advanceDeductionMinor = Math.min(outstanding, grossMinor);
        const netMinor = grossMinor - advanceDeductionMinor;

        await ctx.db.insert("payrollItems", {
          orgId: args.orgId,
          runId,
          userId,
          baseSalaryMinor,
          commissionMinor: commission.minor,
          otherEarningsMinor: 0,
          advanceDeductionMinor,
          otherDeductionMinor: 0,
          grossMinor,
          netMinor,
          currency,
          commissionSaleIds: commission.saleIds,
          createdAt: now,
        });
        totalGross += grossMinor;
        totalNet += netMinor;
      }

      await ctx.db.patch(runId, { totalGrossMinor: totalGross, totalNetMinor: totalNet, updatedAt: now });
      return runId;
    } catch (error) {
      console.error("payroll.createRun failed", error);
      if (error instanceof ConvexError) throw error;
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Approves a DRAFT run: accrues each payslip's salary (Dr Salaries Expense /
 * Cr Salaries Payable) and ensures each consumed commission is accrued (Dr
 * Commission Expense / Cr Commission Payable — idempotent for AUTO, first-time
 * for MANUAL), so the payable exists before the payment clears it.
 */
export const approveRun = mutation({
  args: { orgId: v.id("organizations"), runId: v.id("payrollRuns") },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const run = await ctx.db.get(args.runId);
      if (!run || run.orgId !== args.orgId) throw new ConvexError("Payroll run not found.");
      if (run.status !== "DRAFT") throw new ConvexError("Only a draft payroll run can be approved.");

      const now = Date.now();
      const items = await ctx.db
        .query("payrollItems")
        .withIndex("by_run", (q) => q.eq("runId", args.runId))
        .collect();

      for (const item of items) {
        if (item.baseSalaryMinor > 0) {
          await hookPayrollAccrued(ctx, {
            orgId: args.orgId,
            itemId: item._id,
            runId: args.runId,
            userId: item.userId,
            amountMinor: item.baseSalaryMinor,
            currency: item.currency,
            actorId: user._id,
            occurredAt: now,
          });
        }
        for (const saleId of item.commissionSaleIds) {
          const sale = await ctx.db.get(saleId);
          if (!sale || !sale.commissionAmount || sale.commissionAmount <= 0) continue;
          await hookCommissionAccrued(ctx, {
            orgId: args.orgId,
            saleId,
            salespersonId: sale.salespersonId,
            amountMinor: toMinorUnits(sale.commissionAmount, item.currency),
            currency: item.currency,
            actorId: user._id,
            occurredAt: now,
          });
        }
      }

      await ctx.db.patch(args.runId, {
        status: "APPROVED",
        approvedBy: user._id,
        approvedAt: now,
        updatedAt: now,
      });
    } catch (error) {
      console.error("payroll.approveRun failed", error);
      if (error instanceof ConvexError) throw error;
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Pays an APPROVED run: for each payslip, recovers advances (oldest first),
 * posts the payslip payment (clears salary + commission payables, credits
 * Employee Advances, pays net cash), and marks the consumed commissions paid.
 * The commission payable is cleared by the payroll payment itself, so
 * hookCommissionPaid is NOT called (that would double-clear it).
 */
export const payRun = mutation({
  args: {
    orgId: v.id("organizations"),
    runId: v.id("payrollRuns"),
    method: v.optional(paymentMethodValidator),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const run = await ctx.db.get(args.runId);
      if (!run || run.orgId !== args.orgId) throw new ConvexError("Payroll run not found.");
      if (run.status !== "APPROVED") throw new ConvexError("Only an approved payroll run can be paid.");

      const now = Date.now();
      const method = normalizePaymentMethod(args.method);
      const items = await ctx.db
        .query("payrollItems")
        .withIndex("by_run", (q) => q.eq("runId", args.runId))
        .collect();

      for (const item of items) {
        // Recover advances oldest-first, up to the item's advance deduction.
        let toRecover = item.advanceDeductionMinor;
        if (toRecover > 0) {
          const advances = (
            await ctx.db
              .query("employeeAdvances")
              .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", item.userId))
              .filter((q) => q.eq(q.field("status"), "OUTSTANDING"))
              .collect()
          ).sort((a, b) => a.date - b.date);
          for (const adv of advances) {
            if (toRecover <= 0) break;
            const remaining = adv.amountMinor - adv.recoveredMinor;
            const take = Math.min(remaining, toRecover);
            const newRecovered = adv.recoveredMinor + take;
            await ctx.db.patch(adv._id, {
              recoveredMinor: newRecovered,
              status: newRecovered >= adv.amountMinor ? "RECOVERED" : "OUTSTANDING",
              updatedAt: now,
            });
            toRecover -= take;
          }
        }

        await hookPayrollPaid(ctx, {
          orgId: args.orgId,
          itemId: item._id,
          userId: item.userId,
          salaryMinor: item.baseSalaryMinor,
          commissionMinor: item.commissionMinor,
          advanceRecoveredMinor: item.advanceDeductionMinor,
          netMinor: item.netMinor,
          currency: item.currency,
          paymentMethod: method,
          actorId: user._id,
          occurredAt: now,
        });

        // Mark the consumed commissions paid (payable already cleared above).
        for (const saleId of item.commissionSaleIds) {
          const sale = await ctx.db.get(saleId);
          if (!sale || sale.commissionPaidAt != null) continue;
          await ctx.db.patch(saleId, {
            commissionPaidAt: now,
            commissionPaidBy: user._id,
            commissionPaymentMethod: method,
          });
        }
      }

      await ctx.db.patch(args.runId, {
        status: "PAID",
        paidBy: user._id,
        paidAt: now,
        updatedAt: now,
      });
    } catch (error) {
      console.error("payroll.payRun failed", error);
      if (error instanceof ConvexError) throw error;
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/** Lists payroll runs (newest first) with their item counts. */
export const listRuns = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_PAYROLL]);
    const runs = await ctx.db
      .query("payrollRuns")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();
    return runs.map((r) => ({
      ...r,
      totalGross: fromMinorUnits(r.totalGrossMinor, r.currency),
      totalNet: fromMinorUnits(r.totalNetMinor, r.currency),
    }));
  },
});

/** Lists the payslip items of one run (amounts in major units). */
export const listRunItems = query({
  args: { orgId: v.id("organizations"), runId: v.id("payrollRuns") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_PAYROLL]);
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== args.orgId) throw new ConvexError("Payroll run not found.");
    const items = await ctx.db
      .query("payrollItems")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    return await Promise.all(
      items.map(async (i) => {
        const u = await ctx.db.get(i.userId);
        return {
          ...i,
          userName: u?.name ?? u?.email ?? "Unknown",
          baseSalary: fromMinorUnits(i.baseSalaryMinor, i.currency),
          commission: fromMinorUnits(i.commissionMinor, i.currency),
          advanceDeduction: fromMinorUnits(i.advanceDeductionMinor, i.currency),
          gross: fromMinorUnits(i.grossMinor, i.currency),
          net: fromMinorUnits(i.netMinor, i.currency),
        };
      })
    );
  },
});
