import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { auditLog } from "../utils/financialAuditWriter";
import { findFirstPeriodStartingBy } from "../utils/postingPeriod";

type AuditActor = Pick<Doc<"users">, "_id">;

export async function assertNoReservedOpeningRefunds(ctx: MutationCtx, orgId: Id<"organizations">, periodEnd: number) {
  // A held refund can be paid in any open period whose end follows reservation.
  const reservation = await ctx.db.query("deposits")
    .withIndex("by_org_refund_reserved_at", q => q.eq("orgId", orgId)
      .gt("openingRefundReservation.reservedAt", undefined).lte("openingRefundReservation.reservedAt", periodEnd))
    .first();
  if (reservation) throw new ConvexError("Settle or cancel the reserved opening deposit refunds before closing this period.");
}

export async function createAccountingPeriod(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    fiscalYear: number;
    periodNumber: number;
    startDate: number;
    endDate: number;
    openImmediately?: boolean;
  },
  user: AuditActor,
) {
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
}

export async function openAccountingPeriod(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    periodId: Id<"accountingPeriods">;
  },
  user: AuditActor,
) {
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
}

export async function closeAccountingPeriod(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    periodId: Id<"accountingPeriods">;
  },
  user: AuditActor,
  period: Doc<"accountingPeriods">,
  checklist: { blockers: string[]; warnings: string[] },
  overrideReason: string | undefined,
) {
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
}

export async function lockAccountingPeriod(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    periodId: Id<"accountingPeriods">;
  },
  user: AuditActor,
) {
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
}

export async function reopenAccountingPeriod(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    periodId: Id<"accountingPeriods">;
    reason: string;
  },
  user: AuditActor,
) {
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
}
