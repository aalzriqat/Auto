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
    .filter((q) => q.and(q.eq(q.field("status"), "OUTSTANDING"), q.neq(q.field("isDeleted"), true)))
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

      // Salary applicable to the SELECTED period, not just whatever is active
      // today: for each employee pick the latest compensation row that took
      // effect on or before the period's end, so a retroactive June run created
      // after a July raise still pays the June salary. Employees whose salary
      // was first recorded after the period fall back to their current active
      // row (they were mid-onboarding; the alternative — paying 0 — surprises).
      const periodEndMs = Date.UTC(args.periodYear, args.periodMonth, 1) - 1;
      const comps = await ctx.db
        .query("employeeCompensation")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect();
      const compsByUser = new Map<string, typeof comps>();
      for (const c of comps) {
        const list = compsByUser.get(c.userId) ?? [];
        list.push(c);
        compsByUser.set(c.userId, list);
      }
      const salaryByUser = new Map<string, number>();
      for (const [uid, rows] of compsByUser) {
        const applicable = rows
          .filter((r) => r.effectiveFrom <= periodEndMs)
          .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
        const chosen = applicable ?? rows.find((r) => r.active);
        if (chosen) salaryByUser.set(uid, chosen.monthlySalaryMinor);
      }

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

      // Build every payslip BEFORE inserting the run, so an empty period (no
      // salaries, no commissions) is rejected instead of leaving a zero-item
      // draft that blocks the period until someone cancels it.
      let totalGross = 0;
      let totalNet = 0;
      const itemPayloads: {
        userId: Id<"users">;
        baseSalaryMinor: number;
        commissionMinor: number;
        advanceDeductionMinor: number;
        grossMinor: number;
        netMinor: number;
        commissionSaleIds: Id<"sales">[];
      }[] = [];
      for (const uid of userIds) {
        const userId = uid as Id<"users">;
        const baseSalaryMinor = salaryByUser.get(uid) ?? 0;
        const commission = commissionByUser.get(uid) ?? { minor: 0, saleIds: [] };
        const grossMinor = baseSalaryMinor + commission.minor;
        if (grossMinor <= 0) continue;

        const outstanding = await outstandingAdvanceMinor(ctx, args.orgId, userId);
        const advanceDeductionMinor = Math.min(outstanding, grossMinor);
        const netMinor = grossMinor - advanceDeductionMinor;
        itemPayloads.push({
          userId,
          baseSalaryMinor,
          commissionMinor: commission.minor,
          advanceDeductionMinor,
          grossMinor,
          netMinor,
          commissionSaleIds: commission.saleIds,
        });
        totalGross += grossMinor;
        totalNet += netMinor;
      }
      if (itemPayloads.length === 0) {
        throw new ConvexError(
          "Nothing to pay for this period: no member has a salary or an unpaid commission."
        );
      }

      const runId = await ctx.db.insert("payrollRuns", {
        orgId: args.orgId,
        periodYear: args.periodYear,
        periodMonth: args.periodMonth,
        currency,
        status: "DRAFT",
        totalGrossMinor: totalGross,
        totalNetMinor: totalNet,
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      });
      for (const p of itemPayloads) {
        await ctx.db.insert("payrollItems", {
          orgId: args.orgId,
          runId,
          userId: p.userId,
          baseSalaryMinor: p.baseSalaryMinor,
          commissionMinor: p.commissionMinor,
          otherEarningsMinor: 0,
          advanceDeductionMinor: p.advanceDeductionMinor,
          otherDeductionMinor: 0,
          grossMinor: p.grossMinor,
          netMinor: p.netMinor,
          currency,
          commissionSaleIds: p.commissionSaleIds,
          createdAt: now,
        });
      }
      return runId;
    } catch (error) {
      console.error("payroll.createRun failed", error);
      if (error instanceof ConvexError) throw error;
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Cancels a DRAFT run. Only drafts: nothing has posted to the GL yet, so
 * cancellation is purely operational and frees the period for a fresh run
 * (the createRun clash check ignores CANCELLED runs). Reversing an APPROVED
 * or PAID run requires offsetting journal entries and is deliberately NOT
 * offered here — that's a manual accounting correction until a dedicated
 * reversal flow ships.
 */
export const cancelRun = mutation({
  args: { orgId: v.id("organizations"), runId: v.id("payrollRuns") },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const run = await ctx.db.get(args.runId);
      if (!run || run.orgId !== args.orgId) throw new ConvexError("Payroll run not found.");
      if (run.status !== "DRAFT") {
        throw new ConvexError(
          "Only a draft payroll run can be cancelled. Approved or paid runs need an accounting reversal."
        );
      }
      const now = Date.now();
      await ctx.db.patch(args.runId, {
        status: "CANCELLED",
        cancelledBy: user._id,
        cancelledAt: now,
        updatedAt: now,
      });
    } catch (error) {
      console.error("payroll.cancelRun failed", error);
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
          // A sale can leave the payable population between draft and approval:
          // cancelled/voided sales get their accrual REVERSED by the void hook,
          // so accruing (or later paying) them here would corrupt the payable.
          if (
            !sale ||
            sale.isDeleted ||
            sale.status !== "COMPLETED" ||
            !sale.commissionAmount ||
            sale.commissionAmount <= 0
          ) {
            continue;
          }
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

      let paidGrossMinor = 0;
      let paidNetMinor = 0;
      for (const item of items) {
        // Re-derive the commission from CURRENT state, not the draft snapshot.
        // A run for another period may have paid some of these sales since this
        // one was drafted (createRun captures all unpaid commissions with no
        // period filter), and paying on the stale snapshot would pay the same
        // commission twice and over-clear Commission Payable. Only still-unpaid
        // sales are settled here.
        let commissionMinor = 0;
        const saleIdsToSettle: Id<"sales">[] = [];
        for (const saleId of item.commissionSaleIds) {
          const sale = await ctx.db.get(saleId);
          // Must still be a live COMPLETED sale: a cancelled/voided sale has had
          // its COMMISSION_ACCRUED entry reversed, so "paying" it would debit a
          // payable that no longer exists and hand out cash for a dead sale.
          if (
            !sale ||
            sale.isDeleted ||
            sale.status !== "COMPLETED" ||
            sale.commissionPaidAt != null ||
            !sale.commissionAmount ||
            sale.commissionAmount <= 0
          ) {
            continue;
          }
          commissionMinor += toMinorUnits(sale.commissionAmount, item.currency);
          saleIdsToSettle.push(saleId);
        }

        const salaryMinor = item.baseSalaryMinor;
        const grossMinor = salaryMinor + commissionMinor;

        // Recover advances oldest-first from CURRENT outstanding advances (an
        // advance may have been recovered or soft-deleted since drafting), capped
        // at this payslip's gross. advanceRecoveredMinor is the amount ACTUALLY
        // taken so the GL credit to Employee Advances can never exceed reality.
        let toRecover = Math.min(await outstandingAdvanceMinor(ctx, args.orgId, item.userId), grossMinor);
        let advanceRecoveredMinor = 0;
        if (toRecover > 0) {
          const advances = (
            await ctx.db
              .query("employeeAdvances")
              .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", item.userId))
              .filter((q) => q.and(q.eq(q.field("status"), "OUTSTANDING"), q.neq(q.field("isDeleted"), true)))
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
            advanceRecoveredMinor += take;
            toRecover -= take;
          }
        }

        const netMinor = grossMinor - advanceRecoveredMinor;

        // Nothing left to pay on this payslip (e.g. its only commission was
        // already settled by another period's run and it carries no salary).
        // Skip the GL post — an all-zero PAYROLL_PAID would be an empty entry —
        // but still zero out the item below so reports don't show a phantom.
        if (grossMinor > 0) {
          await hookPayrollPaid(ctx, {
            orgId: args.orgId,
            itemId: item._id,
            userId: item.userId,
            salaryMinor,
            commissionMinor,
            advanceRecoveredMinor,
            netMinor,
            currency: item.currency,
            paymentMethod: method,
            actorId: user._id,
            occurredAt: now,
          });
        }

        // Mark the settled commissions paid (payable cleared by the payment above).
        for (const saleId of saleIdsToSettle) {
          await ctx.db.patch(saleId, {
            commissionPaidAt: now,
            commissionPaidBy: user._id,
            commissionPaymentMethod: method,
          });
        }

        // Persist what was ACTUALLY paid back onto the payslip so payslips and
        // reports reflect reality rather than the possibly-stale draft snapshot.
        await ctx.db.patch(item._id, {
          commissionMinor,
          advanceDeductionMinor: advanceRecoveredMinor,
          grossMinor,
          netMinor,
          commissionSaleIds: saleIdsToSettle,
        });
        paidGrossMinor += grossMinor;
        paidNetMinor += netMinor;
      }

      await ctx.db.patch(args.runId, {
        status: "PAID",
        paidBy: user._id,
        paidAt: now,
        totalGrossMinor: paidGrossMinor,
        totalNetMinor: paidNetMinor,
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
