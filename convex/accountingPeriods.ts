import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id, Doc } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { auditLog } from "./financialAudit";
import { requireFeature } from "./subscriptions";
import {
  computeSubledgerReconciliation,
  SubledgerReconciliationResult,
  computeVehicleInventoryReconciliation,
  computeSupplierPayablesReconciliation,
  computeCustomerDepositsReconciliation,
  computeCommissionPayableReconciliation,
  GlVsSubledgerResult,
} from "./accountingReports";

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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    const period = await ctx.db.get(args.periodId);
    if (!period || period.orgId !== args.orgId) return null;
    return period;
  },
});

export const currentOpenPeriod = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
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
    await requireFeature(ctx, args.orgId, "accounting");

    if (!Number.isFinite(args.startDate) || !Number.isFinite(args.endDate)) {
      throw new ConvexError("Period dates must be valid timestamps.");
    }
    if (args.startDate >= args.endDate) {
      throw new ConvexError("Period start date must be before end date.");
    }
    if (!Number.isInteger(args.fiscalYear) || args.fiscalYear < 1900 || args.fiscalYear > 2200) {
      throw new ConvexError("Fiscal year must be a valid integer year (1900–2200).");
    }
    if (!Number.isInteger(args.periodNumber) || args.periodNumber < 1 || args.periodNumber > 13) {
      throw new ConvexError("Period number must be an integer between 1 and 13.");
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
    await requireFeature(ctx, args.orgId, "accounting");

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
    // Opening a period can unblock events that were enqueued while no period
    // covered their date — drain the accounting outbox.
    await ctx.scheduler.runAfter(0, internal.accountingOutbox.drainPendingAccountingEvents, {
      orgId: args.orgId,
    });
    return args.periodId;
  },
});

export type CloseChecklistResult = {
  canClose: boolean;
  blockers: string[];
  pendingOutboxEventCount: number;
  failedOutboxEventCount: number;
  pendingManualJournalCount: number;
  unmatchedBankLineCount: number;
  arReconciliation: SubledgerReconciliationResult;
  vehicleInventoryReconciliation: GlVsSubledgerResult;
  supplierPayablesReconciliation: GlVsSubledgerResult;
  customerDepositsReconciliation: GlVsSubledgerResult;
  commissionPayableReconciliation: GlVsSubledgerResult;
};

/**
 * Everything that must be true before a period can close. Closing only flips
 * a status flag and writes an audit entry — this is what actually protects
 * the books: any accounting event still waiting to post, any manual journal
 * still waiting on its second-approver, any AR-vs-GL discrepancy, or any bank
 * statement line from within the period that's never been matched, all block
 * the close outright rather than silently landing in a later period.
 */
async function computeCloseChecklist(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  period: Doc<"accountingPeriods">
): Promise<CloseChecklistResult> {
  const pendingOutboxEvents = (
    await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
      .collect()
  ).filter((e) => e.accountingDate <= period.endDate);

  // A dead-lettered event (accountingOutbox.ts's MAX_ATTEMPTS) represents the
  // same unposted GL impact as a pending one — it must block the close just
  // as hard, or a permanently-failed event could silently disappear from
  // every control the moment it stops retrying.
  const failedOutboxEvents = (
    await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "FAILED"))
      .collect()
  ).filter((e) => e.accountingDate <= period.endDate);

  // Not period-scoped by date — manualJournalDrafts have no accountingDate
  // until posted, and an unresolved approval is a control gap regardless of
  // which period it will eventually land in.
  const pendingManualJournals = await ctx.db
    .query("manualJournalDrafts")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING_APPROVAL"))
    .collect();

  const unmatchedBankLines = (
    await ctx.db
      .query("bankStatementLines")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "UNMATCHED"))
      .collect()
  ).filter((l) => l.statementDate <= period.endDate);

  // These four used to be informational-only reports, never checked at close
  // — an org could close a period with Vehicle Inventory, AP-Suppliers,
  // Customer Deposits, or Commission Payable silently out of sync with the
  // GL. They already exist and are cheap to compute, so there's no reason
  // not to gate on them the same way AR already is. Independent read-only
  // computations, so run them concurrently rather than five sequential round-trips.
  const [arReconciliation, vehicleInventoryRecon, supplierPayablesRecon, customerDepositsRecon, commissionPayableRecon] =
    await Promise.all([
      computeSubledgerReconciliation(ctx, orgId, period.endDate),
      computeVehicleInventoryReconciliation(ctx, orgId, period.endDate),
      computeSupplierPayablesReconciliation(ctx, orgId, period.endDate),
      computeCustomerDepositsReconciliation(ctx, orgId, period.endDate),
      computeCommissionPayableReconciliation(ctx, orgId, period.endDate),
    ]);

  const blockers: string[] = [];
  if (pendingOutboxEvents.length > 0) {
    blockers.push(`${pendingOutboxEvents.length} accounting event(s) from this period have not posted yet.`);
  }
  if (failedOutboxEvents.length > 0) {
    blockers.push(
      `${failedOutboxEvents.length} accounting event(s) from this period FAILED to post after repeated retries and require resolution — retry them (after fixing the underlying cause) or have an owner explicitly override the close.`
    );
  }
  if (pendingManualJournals.length > 0) {
    blockers.push(`${pendingManualJournals.length} manual journal entr${pendingManualJournals.length === 1 ? "y is" : "ies are"} awaiting approval.`);
  }
  if (!arReconciliation.isReconciled) {
    const badCurrencies = arReconciliation.currencies.filter((c) => !arReconciliation.byCurrency[c].isReconciled);
    blockers.push(`AR subledger does not reconcile to the GL for: ${badCurrencies.join(", ")}.`);
  }
  if (!vehicleInventoryRecon.isReconciled) {
    const badCurrencies = vehicleInventoryRecon.currencies.filter((c) => !vehicleInventoryRecon.byCurrency[c].isReconciled);
    blockers.push(`Vehicle Inventory subledger does not reconcile to the GL for: ${badCurrencies.join(", ")}.`);
  }
  if (!supplierPayablesRecon.isReconciled) {
    const badCurrencies = supplierPayablesRecon.currencies.filter((c) => !supplierPayablesRecon.byCurrency[c].isReconciled);
    blockers.push(`Supplier payables subledger does not reconcile to the GL for: ${badCurrencies.join(", ")}.`);
  }
  if (!customerDepositsRecon.isReconciled) {
    const badCurrencies = customerDepositsRecon.currencies.filter((c) => !customerDepositsRecon.byCurrency[c].isReconciled);
    blockers.push(`Customer deposits subledger does not reconcile to the GL for: ${badCurrencies.join(", ")}.`);
  }
  if (!commissionPayableRecon.isReconciled) {
    const badCurrencies = commissionPayableRecon.currencies.filter((c) => !commissionPayableRecon.byCurrency[c].isReconciled);
    blockers.push(`Commission payable subledger does not reconcile to the GL for: ${badCurrencies.join(", ")}.`);
  }
  if (unmatchedBankLines.length > 0) {
    blockers.push(`${unmatchedBankLines.length} bank statement line(s) from this period are still unmatched.`);
  }

  return {
    canClose: blockers.length === 0,
    blockers,
    pendingOutboxEventCount: pendingOutboxEvents.length,
    failedOutboxEventCount: failedOutboxEvents.length,
    pendingManualJournalCount: pendingManualJournals.length,
    unmatchedBankLineCount: unmatchedBankLines.length,
    arReconciliation,
    vehicleInventoryReconciliation: vehicleInventoryRecon,
    supplierPayablesReconciliation: supplierPayablesRecon,
    customerDepositsReconciliation: customerDepositsRecon,
    commissionPayableReconciliation: commissionPayableRecon,
  };
}

export const closeChecklist = query({
  args: {
    orgId: v.id("organizations"),
    periodId: v.id("accountingPeriods"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const period = await ctx.db.get(args.periodId);
    if (!period || period.orgId !== args.orgId) {
      throw new ConvexError("Period not found in this organization.");
    }
    return computeCloseChecklist(ctx, args.orgId, period);
  },
});

export const close = mutation({
  args: {
    orgId: v.id("organizations"),
    periodId: v.id("accountingPeriods"),
    // A period whose checklist fails can still be closed with an explicit
    // override + reason, for cases the checklist can't model (e.g. a known,
    // accepted rounding discrepancy) — but the override is always audited.
    overrideReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const period = await ctx.db.get(args.periodId);
    if (!period || period.orgId !== args.orgId) {
      throw new ConvexError("Period not found in this organization.");
    }
    if (period.status !== "OPEN" && period.status !== "CLOSING") {
      throw new ConvexError(`Cannot close a period with status "${period.status}".`);
    }

    const checklist = await computeCloseChecklist(ctx, args.orgId, period);
    let overrideReason: string | undefined;
    if (!checklist.canClose) {
      const trimmedReason = args.overrideReason?.trim();
      if (!trimmedReason) {
        throw new ConvexError(
          `This period cannot be closed yet: ${checklist.blockers.join(" ")} Pass overrideReason to close anyway.`
        );
      }
      // Bypassing an integrity blocker (unreconciled AR, unposted events,
      // unmatched bank lines, pending approvals) is a materially bigger risk
      // than a routine clean close — restrict it to the org owner, not any
      // MANAGE_FINANCE holder (e.g. the ACCOUNTANT role).
      if (!isSystemOwnerRole(role)) {
        throw new ConvexError(
          "Forbidden: Only the organization owner can close a period that has open blockers."
        );
      }
      overrideReason = trimmedReason;
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
      description: overrideReason
        ? `Closed period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")} despite open blockers (${checklist.blockers.join(" ")}) — override: ${overrideReason}`
        : `Closed period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}`,
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
    await requireFeature(ctx, args.orgId, "accounting");

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
    // Reopening un-does a close's own protections (pending events, AR/subledger
    // reconciliation, unmatched bank lines all stop blocking anything once a
    // period is OPEN again) — the same reasoning close()'s override path
    // already uses to require the org owner specifically, not any
    // MANAGE_FINANCE holder (e.g. the default ACCOUNTANT role). requireOwner
    // already implies every permission (owners have them all), so it
    // subsumes the MANAGE_FINANCE check too.
    const { user } = await requireOwner(ctx, args.orgId);
    await requireFeature(ctx, args.orgId, "accounting");

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
    const reopenReason = args.reason.trim();
    if (!reopenReason) {
      throw new ConvexError("A reason is required when reopening a period.");
    }
    if (reopenReason.length > 500) {
      throw new ConvexError("Reopen reason must be 500 characters or fewer.");
    }

    const now = Date.now();
    await ctx.db.patch(args.periodId, {
      status: "OPEN",
      reopenedBy: user._id,
      reopenedAt: now,
      reopenReason,
    });
    await auditLog(ctx, {
      orgId: args.orgId, actorId: user._id, actionType: "REOPEN_PERIOD",
      resourceType: "accountingPeriods", resourceId: args.periodId.toString(),
      description: `Reopened period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}: ${reopenReason}`,
    });
    return args.periodId;
  },
});
