import { openingVerificationContext } from "./utils/openingSourceIdentity";
import { v, ConvexError } from "convex/values";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Id, Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireTenantAuth } from "./utils/tenancy";
import { STATEMENT_PERMISSIONS } from "./supplierStatement";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { auditLog } from "./utils/financialAuditWriter";
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
  computeEmployeeAdvancesReconciliation,
  computeSupplierRecoverablesReconciliation,
  computePartnerCapitalReconciliation,
  orgHasOpeningHistory,
  openingSuspenseIsOpen,
  CustomerDepositsReconciliationResult,
  GlVsSubledgerResult,
  OpeningFamilyReconciliationResult,
  SupplierPayablesReconciliationResult,
} from "./accountingReports";
import { buildPeriodCloseChecklist, type PeriodCloseInputs } from "./accounting/periodLifecycle";

const periodStatusValidator = v.union(
  v.literal("FUTURE"),
  v.literal("OPEN"),
  v.literal("CLOSING"),
  v.literal("CLOSED"),
  v.literal("LOCKED"),
);

// Internal snapshot provenance must not change the existing period API shape.
function publicPeriod(period: Doc<"accountingPeriods">) {
  const result = { ...period };
  delete result.snapshotFastPathEligible;
  return result;
}

import { findFirstPeriodStartingBy } from "./utils/postingPeriod";
export { assertPostingAllowed, checkPostingAllowed, getOpenPeriodForDate } from "./utils/postingPeriod";
export type { PostingAllowed } from "./utils/postingPeriod";

export { assertValidAccountingDate } from "./utils/accountingDate";

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
    return (await q.collect()).map(publicPeriod);
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
    return publicPeriod(period);
  },
});

export const currentOpenPeriod = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    const now = Date.now();
    // OPEN periods only (index), in insertion order; the date window is checked
    // in memory over that small set and the first match is returned, as the
    // former `.filter(...).first()` did.
    const openPeriods = ctx.db
      .query("accountingPeriods")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "OPEN"));
    for await (const period of openPeriods) {
      if (period.startDate <= now && period.endDate >= now) return publicPeriod(period);
    }
    return null;
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
    const overlap = await findFirstPeriodStartingBy(
      ctx,
      args.orgId,
      args.endDate,
      (p) => p.endDate >= args.startDate
    );
    if (overlap) {
      throw new ConvexError(
        `Period dates overlap with ${overlap.fiscalYear}-${String(overlap.periodNumber).padStart(2, "0")}.`
      );
    }

    const now = Date.now();
    const status = args.openImmediately ? "OPEN" : "FUTURE";
    const periodId = await ctx.db.insert("accountingPeriods", {
      orgId: args.orgId,
      // A newly allocated period id cannot have historical journal lines.
      // Every posting path writes its account snapshot in the same mutation.
      snapshotFastPathEligible: true,
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

    // A period created already OPEN resolves the same blocker `open` does.
    if (status === "OPEN") {
      await ctx.scheduler.runAfter(0, internal.accountingOutbox.wakePeriodHeldRows, {
        orgId: args.orgId,
        startDate: args.startDate,
        endDate: args.endDate,
      });
    }

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
    // SCRUM-807 — period holds back off, so the drain above does not reach
    // them; wake exactly the rows this period now covers.
    await ctx.scheduler.runAfter(0, internal.accountingOutbox.wakePeriodHeldRows, {
      orgId: args.orgId,
      startDate: period.startDate,
      endDate: period.endDate,
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
  supplierPayablesReconciliation: SupplierPayablesReconciliationResult;
  customerDepositsReconciliation: CustomerDepositsReconciliationResult;
  commissionPayableReconciliation: GlVsSubledgerResult;
  // SCRUM-858: opening-balance families. Differences are reported, never posted away.
  employeeAdvancesReconciliation: OpeningFamilyReconciliationResult;
  supplierRecoverablesReconciliation: OpeningFamilyReconciliationResult;
  partnerCapitalReconciliation: OpeningFamilyReconciliationResult;
};

async function readPeriodReconciliations(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  period: Doc<"accountingPeriods">,
  { allPendingOutbox, allFailedOutbox, allSales, sharedGl }: PeriodCloseInputs,
) {
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
  const [arReconciliation, vehicleInventoryRecon, customerDepositsRecon, commissionPayableRecon, prepaidRecognitionShortfall, commissionRecognitionDivergence] =
    await Promise.all([
      computeSubledgerReconciliation(ctx, orgId, period.endDate, true),
      computeVehicleInventoryReconciliation(ctx, orgId, period.endDate, true),
      computeCustomerDepositsReconciliation(ctx, orgId, period.endDate),
      computeCommissionPayableReconciliation(ctx, orgId, period.endDate, { sales: allSales }),
      computePrepaidRecognitionShortfall(ctx, orgId, period.endDate),
      computeCommissionRecognitionDivergence(ctx, orgId, {
        pendingEvents: [...allPendingOutbox, ...allFailedOutbox],
        sales: allSales,
      }),
    ]);
  // The three opening-family readers run AFTER the readers above, one at a time. Each admits its own reads against the
  // transaction's remaining read headroom (readBoundedDocuments, measured as they stream), and that headroom is only true once the earlier
  // readers have finished reading: run beside them, every reader would be admitted against the same untouched budget
  // and together overrun it (SCRUM-858 PR #710 R11: the readers above already take ~24.6k of the 32,000 documents).
  const openingCtx = openingVerificationContext(ctx);
  const supplierPayablesRecon = await computeSupplierPayablesReconciliation(openingCtx, orgId, period.endDate, {
    outboxEvents: [...allPendingOutbox, ...allFailedOutbox],
  });
  const employeeAdvancesRecon = await computeEmployeeAdvancesReconciliation(openingCtx, orgId, period.endDate, sharedGl);
  const supplierRecoverablesRecon = await computeSupplierRecoverablesReconciliation(openingCtx, orgId, period.endDate, sharedGl);
  const partnerCapitalRecon = await computePartnerCapitalReconciliation(openingCtx, orgId, period.endDate, sharedGl);

  return {
    arReconciliation,
    vehicleInventoryRecon,
    customerDepositsRecon,
    commissionPayableRecon,
    prepaidRecognitionShortfall,
    commissionRecognitionDivergence,
    openingCtx,
    supplierPayablesRecon,
    employeeAdvancesRecon,
    supplierRecoverablesRecon,
    partnerCapitalRecon,
  };
}

const periodCloseReaders = {
  readReconciliations: readPeriodReconciliations,
  orgHasOpeningHistory,
  openingSuspenseIsOpen,
};

export async function computeCloseChecklist(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  period: Doc<"accountingPeriods">,
): Promise<CloseChecklistResult> {
  const { summary, reconciliations } = await buildPeriodCloseChecklist(ctx, orgId, period, periodCloseReaders);
  return {
    ...summary,
    arReconciliation: reconciliations.arReconciliation,
    vehicleInventoryReconciliation: reconciliations.vehicleInventoryRecon,
    supplierPayablesReconciliation: reconciliations.supplierPayablesRecon,
    customerDepositsReconciliation: reconciliations.customerDepositsRecon,
    commissionPayableReconciliation: reconciliations.commissionPayableRecon,
    employeeAdvancesReconciliation: reconciliations.employeeAdvancesRecon,
    supplierRecoverablesReconciliation: reconciliations.supplierRecoverablesRecon,
    partnerCapitalReconciliation: reconciliations.partnerCapitalRecon,
  };
}

export const closeChecklist = query({
  args: {
    orgId: v.id("organizations"),
    periodId: v.id("accountingPeriods"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, STATEMENT_PERMISSIONS);
    await requireFeature(ctx, args.orgId, "accounting");

    const period = await ctx.db.get(args.periodId);
    if (!period || period.orgId !== args.orgId) {
      throw new ConvexError("Period not found in this organization.");
    }
    return computeCloseChecklist(ctx, args.orgId, period);
  },
});

async function assertNoReservedOpeningRefunds(ctx: MutationCtx, orgId: Id<"organizations">, periodEnd: number) {
  // A held refund can be paid in any open period whose end follows reservation.
  const reservation = await ctx.db.query("deposits")
    .withIndex("by_org_refund_reserved_at", q => q.eq("orgId", orgId)
      .gt("openingRefundReservation.reservedAt", undefined).lte("openingRefundReservation.reservedAt", periodEnd))
    .first();
  if (reservation) throw new ConvexError("Settle or cancel the reserved opening deposit refunds before closing this period.");
}

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

    await assertNoReservedOpeningRefunds(ctx, args.orgId, period.endDate);
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

    await assertNoReservedOpeningRefunds(ctx, args.orgId, period.endDate);
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
    // SCRUM-807 — every transition into OPEN wakes the period-parked rows it covers.
    await ctx.scheduler.runAfter(0, internal.accountingOutbox.wakePeriodHeldRows, {
      orgId: args.orgId,
      startDate: period.startDate,
      endDate: period.endDate,
    });
    return args.periodId;
  },
});
