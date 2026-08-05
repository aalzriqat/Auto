import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Id, Doc } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTenantAuth } from "./utils/tenancy";
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
  computeCommissionRecognitionDivergence,
  computePrepaidRecognitionShortfall,
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

/**
 * Whether `accountingDate` can be posted into right now, as data rather than an
 * exception, so callers that need to branch on the answer don't have to catch
 * and string-match. `waiting: true` marks the blockers that clear on their own
 * once an operator opens the relevant period — as opposed to a CLOSED/LOCKED
 * period, which is a deliberate refusal that will not resolve by itself. The
 * accounting outbox relies on that distinction to decide whether an entry is
 * failing or merely queued (see accountingOutbox.drainEntries).
 */
export type PostingAllowed =
  | { ok: true; periodId: Id<"accountingPeriods"> }
  | { ok: false; waiting: boolean; reason: string };

export async function checkPostingAllowed(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  accountingDate: number
): Promise<PostingAllowed> {
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
    return {
      ok: false,
      waiting: true,
      reason: `No accounting period found for date ${new Date(accountingDate).toISOString().slice(0, 10)}. Create and open a period first.`,
    };
  }
  const label = `${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}`;
  if (period.status === "CLOSED" || period.status === "LOCKED") {
    return {
      ok: false,
      waiting: false,
      reason: `Accounting period ${label} is ${period.status}. Posting into closed or locked periods is not allowed.`,
    };
  }
  if (period.status === "FUTURE") {
    return {
      ok: false,
      waiting: true,
      reason: `Accounting period ${label} has not been opened yet.`,
    };
  }
  return { ok: true, periodId: period._id };
}

export async function assertPostingAllowed(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  accountingDate: number
): Promise<Id<"accountingPeriods">> {
  const result = await checkPostingAllowed(ctx, orgId, accountingDate);
  if (!result.ok) {
    throw new ConvexError(result.reason);
  }
  return result.periodId;
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
  // Non-blocking advisories the accountant should review but which must NOT
  // prevent a close (see the four current-state reconciliations below).
  warnings: string[];
  pendingOutboxEventCount: number;
  failedOutboxEventCount: number;
  pendingManualJournalCount: number;
  unmatchedBankLineCount: number;
  prepaidRecognitionShortfallScheduleCount: number;
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
  // Collected once, unfiltered, and shared: the blocker counts below want only
  // this period's rows, while the commission-recognition control needs every
  // outstanding row regardless of date (a queued entry dated later still means
  // that sale's recognition is pending rather than wrong). Reading them twice
  // is what pushed this checklist toward the transaction read limit — and a
  // checklist that throws takes `close` down with it, before the owner override
  // that is supposed to be the escape hatch.
  const allPendingOutbox = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
    .collect();
  // A dead-lettered event (accountingOutbox.ts's MAX_ATTEMPTS) represents the
  // same unposted GL impact as a pending one — it must block the close just
  // as hard, or a permanently-failed event could silently disappear from
  // every control the moment it stops retrying.
  const allFailedOutbox = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "FAILED"))
    .collect();

  const pendingOutboxEvents = allPendingOutbox.filter((e) => e.accountingDate <= period.endDate);
  const failedOutboxEvents = allFailedOutbox.filter((e) => e.accountingDate <= period.endDate);

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

  // AR is the only one of these five that is a genuine point-in-time
  // reconstruction as of period.endDate on BOTH sides — so it's the only one
  // safe to hard-block on. The other four (Vehicle Inventory, AP-Suppliers,
  // Customer Deposits, Commission Payable) reconcile a period-end GL balance
  // against a CURRENT-state subledger (none of them records historical state
  // changes — see the docstring on computeVehicleInventoryReconciliation), so
  // a perfectly legitimate June close can look "unreconciled" purely because a
  // vehicle was sold, a deposit applied, or a payable settled in July. Blocking
  // on them produced false close-blockers, so they are surfaced as warnings the
  // accountant reviews, not blockers. Independent read-only computations, so
  // run them concurrently rather than five sequential round-trips.
  const [arReconciliation, vehicleInventoryRecon, supplierPayablesRecon, customerDepositsRecon, commissionPayableRecon, prepaidRecognitionShortfall, commissionRecognitionDivergence] =
    await Promise.all([
      computeSubledgerReconciliation(ctx, orgId, period.endDate),
      computeVehicleInventoryReconciliation(ctx, orgId, period.endDate),
      computeSupplierPayablesReconciliation(ctx, orgId, period.endDate),
      computeCustomerDepositsReconciliation(ctx, orgId, period.endDate),
      computeCommissionPayableReconciliation(ctx, orgId, period.endDate),
      computePrepaidRecognitionShortfall(ctx, orgId, period.endDate),
      computeCommissionRecognitionDivergence(ctx, orgId, {
        pendingEvents: [...allPendingOutbox, ...allFailedOutbox],
      }),
    ]);

  const blockers: string[] = [];
  const warnings: string[] = [];
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
  if (unmatchedBankLines.length > 0) {
    blockers.push(`${unmatchedBankLines.length} bank statement line(s) from this period are still unmatched.`);
  }
  // Point-in-time (as of period.endDate), computed from the authoritative
  // prepaid schedule — so, unlike the current-state warnings below, a shortfall
  // is a real "expense that belongs in this period hasn't been recognized"
  // error and blocks the close. Resolved by running the amortization cron /
  // recognizing the due months before closing.
  if (prepaidRecognitionShortfall.hasShortfall) {
    const currencies = Object.keys(prepaidRecognitionShortfall.byCurrency).join(", ");
    blockers.push(
      `${prepaidRecognitionShortfall.scheduleCount} prepaid expense schedule(s) have amortization due through this period that has not been recognized yet (${currencies}) — run prepaid amortization for the period before closing.`
    );
  }

  // Current-state reconciliations — advisory only (see the note above). A
  // discrepancy here is worth the accountant's attention but is frequently a
  // legitimate cross-period timing artifact rather than a real books error, so
  // it never blocks the close.
  if (!vehicleInventoryRecon.isReconciled) {
    const badCurrencies = vehicleInventoryRecon.currencies.filter((c) => !vehicleInventoryRecon.byCurrency[c].isReconciled);
    warnings.push(`Vehicle Inventory subledger does not reconcile to the GL for: ${badCurrencies.join(", ")} (current-state check — review for timing differences).`);
  }
  if (!supplierPayablesRecon.isReconciled) {
    const badCurrencies = supplierPayablesRecon.currencies.filter((c) => !supplierPayablesRecon.byCurrency[c].isReconciled);
    warnings.push(`Supplier payables subledger does not reconcile to the GL for: ${badCurrencies.join(", ")} (current-state check — review for timing differences).`);
  }
  if (!customerDepositsRecon.isReconciled) {
    const badCurrencies = customerDepositsRecon.currencies.filter((c) => !customerDepositsRecon.byCurrency[c].isReconciled);
    warnings.push(`Customer deposits subledger does not reconcile to the GL for: ${badCurrencies.join(", ")} (current-state check — review for timing differences).`);
  }
  if (!commissionPayableRecon.isReconciled) {
    const badCurrencies = commissionPayableRecon.currencies.filter((c) => !commissionPayableRecon.byCurrency[c].isReconciled);
    // The subledger side sums only what the commission ENTRIES actually
    // recognized in the GL (see computeCommissionPayableReconciliation), so
    // neither a commission still queued behind a closed period nor a correction
    // that posted into a later one shows up here as a difference. What remains
    // is a real one — which matters, because closing a period requires
    // acknowledging every warning verbatim, and a line that fires on every
    // close teaches people to click through the ones that matter.
    warnings.push(`Commission payable subledger does not reconcile to the GL for: ${badCurrencies.join(", ")} (current-state check — review for timing differences).`);
  }
  // The reconciliation above compares the GL against amounts derived from the
  // same posted entries, so it cannot see a commission recognized at the wrong
  // figure — both sides would be wrong together and agree. These are the
  // independent checks: what the ledger recognized versus what the sale
  // actually records. Sales with an entry still in the outbox are excluded,
  // since unposted events are already a blocker above.
  //
  // Reported separately on purpose. "Never recognized" is the expected state of
  // every commission decided before earned-time recognition shipped, and it is
  // fixed by running the backfill; "recognized at a different amount" means
  // something went wrong and needs a person. Reporting both under one message
  // made an ordinary migration backlog read as ledger corruption — and a
  // warning that must be acknowledged verbatim on every close is exactly how
  // people learn to click through the ones that matter.
  if (commissionRecognitionDivergence.unrecognizedCount > 0) {
    warnings.push(
      `${commissionRecognitionDivergence.unrecognizedCount} completed sale commission(s) are not recognized in the ledger at all. Run the commission accrual backfill.`
    );
  }
  if (commissionRecognitionDivergence.divergentCount > 0) {
    warnings.push(
      `${commissionRecognitionDivergence.divergentCount} commission(s) are recognized in the ledger at a different amount than the sale records. Review before closing.`
    );
  }

  return {
    canClose: blockers.length === 0,
    blockers,
    warnings,
    pendingOutboxEventCount: pendingOutboxEvents.length,
    failedOutboxEventCount: failedOutboxEvents.length,
    pendingManualJournalCount: pendingManualJournals.length,
    unmatchedBankLineCount: unmatchedBankLines.length,
    prepaidRecognitionShortfallScheduleCount: prepaidRecognitionShortfall.scheduleCount,
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
    // Every current warning's exact text (from closeChecklist), required
    // before a close proceeds when warnings exist. This is what forces the
    // caller to have actually fetched and displayed the checklist rather than
    // calling close() directly — the review dialog is the only realistic way
    // to produce this list.
    acknowledgedWarnings: v.optional(v.array(v.string())),
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

    if (checklist.warnings.length > 0) {
      const acknowledged = new Set(args.acknowledgedWarnings ?? []);
      const missing = checklist.warnings.filter((w) => !acknowledged.has(w));
      if (missing.length > 0) {
        throw new ConvexError(
          `Review and acknowledge every warning before closing: ${missing.join(" ")}`
        );
      }
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
      description:
        (overrideReason
          ? `Closed period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")} despite open blockers (${checklist.blockers.join(" ")}) — override: ${overrideReason}`
          : `Closed period ${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}`) +
        (checklist.warnings.length > 0 ? ` Acknowledged warnings: ${checklist.warnings.join(" | ")}` : ""),
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
    // Locking is the one period transition with NO way back: reopen() refuses
    // LOCKED outright and nothing else in the product moves a period out of it,
    // so a mistaken lock permanently freezes that period's books — any error
    // found later can never be corrected through the app. That makes it strictly
    // more consequential than reopening, which is recoverable, yet it used to
    // need only MANAGE_FINANCE — a permission the default ACCOUNTANT role
    // template carries. Gate it behind the same narrow grant reopen requires, so
    // the irreversible operation is never easier to reach than the reversible
    // one.
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.MANAGE_FINANCE,
      PERMISSIONS.REOPEN_PERIODS,
    ]);
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
    // period is OPEN again) — deliberately narrower than plain MANAGE_FINANCE
    // (e.g. the default ACCOUNTANT role doesn't have it out of the box). The
    // owner always has REOPEN_PERIODS via ALL_PERMISSIONS; other orgs grant
    // it to a controller role explicitly, founder-independence style, rather
    // than requiring the owner personally for every reopen.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.REOPEN_PERIODS]);
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
    // Same reason open() drains: this period accepts postings again, so any
    // event held back because its date fell in a closed period can go now.
    // Without this the entries sit until some unrelated period opens, which for
    // a reopened prior period may be never.
    await ctx.scheduler.runAfter(0, internal.accountingOutbox.drainPendingAccountingEvents, {
      orgId: args.orgId,
    });
    return args.periodId;
  },
});
