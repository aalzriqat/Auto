/**
 * prepaidExpenses.ts
 *
 * A PREPAID expense (e.g. 12 months of insurance paid up front) is capitalized
 * in full to the Prepaid Expenses asset when paid (ruleExpensePosted), then
 * released to its operating-expense account ratably over its term. One row per
 * prepaid expense in prepaidExpenseSchedules. Recognition is driven by the
 * monthly prepaid-expense-amortization cron (crons.ts), which mirrors the
 * fixed-asset depreciation and F&I-commission recognition crons exactly.
 *
 * The schedule is CALENDAR-aligned, not counter-based: each run recognizes
 * everything due *through* its calendar month, computed from the same
 * authoritative integer schedule (recognizedThroughMonthsMinor) the operational
 * P&L report uses. So after the cron has processed month M, the ledger has
 * recognized exactly what reports.ts shows as of the end of month M — the
 * ledger-backed P&L and the operational P&L can never diverge on a prepaid
 * expense. Catch-up (a missed cron month) and idempotency (a re-run of the same
 * month) both fall out of the "recognize the delta up to this month" math.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, query, MutationCtx } from "./_generated/server";
import { Id, Doc } from "./_generated/dataModel";
import { hookPrepaidExpenseAmortized } from "./accounting/workflowHooks";
import { recognizedThroughMonthsMinor } from "./utils/expenseAmortization";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";

/** Month index for a "YYYY-MM" string, comparable to the report's yearMonthIndex. */
function yearMonthStringIndex(ym: string): number {
  const [year, month] = ym.split("-").map(Number);
  return year * 12 + (month - 1);
}

/** UTC "YYYY-MM" for a timestamp — the month recognition of that expense begins. */
export function toYearMonth(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ─── Schedule lifecycle helpers (called from expenses.ts, mutation context) ───

/**
 * Creates the amortization schedule for a freshly-posted prepaid expense.
 * Idempotent per expense: a retry (e.g. a re-posted expense) reuses the
 * existing row rather than double-scheduling. `totalMinor` is the NET (ex-VAT)
 * amount actually debited to the Prepaid Expenses asset, so recognition releases
 * exactly what was capitalized.
 */
export async function createPrepaidScheduleForExpense(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    expenseId: Id<"expenses">;
    currency: string;
    totalMinor: number;
    termMonths: number;
    expenseSystemKey: string;
    startDate: number;
  }
): Promise<Id<"prepaidExpenseSchedules"> | null> {
  if (args.totalMinor <= 0 || args.termMonths <= 0) return null;

  const existing = await ctx.db
    .query("prepaidExpenseSchedules")
    .withIndex("by_expense", (q) => q.eq("expenseId", args.expenseId))
    .first();
  if (existing) return existing._id;

  return await ctx.db.insert("prepaidExpenseSchedules", {
    orgId: args.orgId,
    expenseId: args.expenseId,
    currency: args.currency,
    totalMinor: args.totalMinor,
    termMonths: args.termMonths,
    expenseSystemKey: args.expenseSystemKey,
    startYearMonth: toYearMonth(args.startDate),
    recognizedMinor: 0,
    monthsRecognized: 0,
    status: "ACTIVE",
    createdAt: Date.now(),
  });
}

/**
 * Marks a schedule CANCELLED (its expense is being reversed). The GL clawback
 * of already-posted amortization is handled separately by
 * hookPrepaidExpenseAmortizationsReversed; this just stops future recognition.
 */
export async function cancelPrepaidScheduleForExpense(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  expenseId: Id<"expenses">
): Promise<Id<"prepaidExpenseSchedules"> | null> {
  const schedule = await ctx.db
    .query("prepaidExpenseSchedules")
    .withIndex("by_expense", (q) => q.eq("expenseId", expenseId))
    .first();
  if (!schedule || schedule.orgId !== orgId) return null;
  if (schedule.status !== "CANCELLED") {
    await ctx.db.patch(schedule._id, { status: "CANCELLED" });
  }
  return schedule._id;
}

// ─── Monthly recognition (cron) ───────────────────────────────────────────────

/** Not org-scoped: the monthly cron runs across every tenant, same as listActiveDeferralsForRecognition. */
export const listActivePrepaidSchedulesForRecognition = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("prepaidExpenseSchedules")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
  },
});

export const amortizePrepaidExpenseForMonth = internalMutation({
  args: {
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    yearMonth: v.string(), // "YYYY-MM" — the calendar month being recognized
    occurredAt: v.number(),
    systemActorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule || schedule.orgId !== args.orgId) return { posted: false, reason: "not_found" };
    if (schedule.status !== "ACTIVE") return { posted: false, reason: "not_active" };

    // Don't release the asset before it's been booked: the schedule is created
    // ACTIVE as soon as the expense is marked paid, but the EXPENSE_POSTED entry
    // that debits Prepaid Expenses may still be queued (no open period at
    // posting time). Recognizing first would credit an asset that isn't there
    // yet. Wait until the source expense has actually posted; the next cron run
    // catches it up once it does.
    const sourcePosted = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", args.orgId).eq("sourceType", "expenses").eq("sourceId", schedule.expenseId.toString())
      )
      .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .first();
    if (!sourcePosted) return { posted: false, reason: "source_expense_not_posted" };

    // Strict month ordering (lexicographic "YYYY-MM"): never recognize a month
    // at or before the last one already recognized — that would double-post.
    if (schedule.lastRecognizedYearMonth && args.yearMonth <= schedule.lastRecognizedYearMonth) {
      return { posted: false, reason: "not_after_last_recognized_month" };
    }

    // Calendar-aligned: how many whole recognition months have elapsed by the
    // end of args.yearMonth (month of the expense counts as month 1, matching
    // reports.ts's +1 convention). Recognize the delta between what's due
    // through this month and what's already been recognized — so a skipped
    // cron month is caught up in one posting and the cumulative always equals
    // the authoritative schedule.
    const monthsElapsedTarget = Math.min(
      Math.max(yearMonthStringIndex(args.yearMonth) - yearMonthStringIndex(schedule.startYearMonth) + 1, 0),
      schedule.termMonths
    );
    const alreadyRecognizedMonths = schedule.monthsRecognized ?? 0;
    if (monthsElapsedTarget <= alreadyRecognizedMonths) {
      return { posted: false, reason: "nothing_due_yet" };
    }

    const amountMinor =
      recognizedThroughMonthsMinor(schedule.totalMinor, schedule.termMonths, monthsElapsedTarget) -
      recognizedThroughMonthsMinor(schedule.totalMinor, schedule.termMonths, alreadyRecognizedMonths);
    if (amountMinor <= 0) return { posted: false, reason: "fully_amortized" };

    const newRecognizedMinor = schedule.recognizedMinor + amountMinor;
    await ctx.db.patch(args.scheduleId, {
      recognizedMinor: newRecognizedMinor,
      monthsRecognized: monthsElapsedTarget,
      lastRecognizedYearMonth: args.yearMonth,
      status: newRecognizedMinor >= schedule.totalMinor ? "FULLY_AMORTIZED" : "ACTIVE",
    });

    await hookPrepaidExpenseAmortized(ctx, {
      orgId: args.orgId,
      scheduleId: args.scheduleId,
      yearMonth: args.yearMonth,
      amountMinor,
      currency: schedule.currency,
      expenseSystemKey: schedule.expenseSystemKey,
      actorId: args.systemActorId,
      occurredAt: args.occurredAt,
    });

    return { posted: true, amountMinor };
  },
});

// ─── Accountant-facing schedule ───────────────────────────────────────────────

function scheduleView(schedule: Doc<"prepaidExpenseSchedules">) {
  const monthsRecognized = schedule.monthsRecognized ?? 0;
  const remainingMinor = Math.max(schedule.totalMinor - schedule.recognizedMinor, 0);
  return {
    _id: schedule._id,
    expenseId: schedule.expenseId,
    currency: schedule.currency,
    totalMinor: schedule.totalMinor,
    recognizedMinor: schedule.recognizedMinor,
    remainingMinor,
    termMonths: schedule.termMonths,
    monthsRecognized,
    monthsRemaining: Math.max(schedule.termMonths - monthsRecognized, 0),
    startYearMonth: schedule.startYearMonth,
    lastRecognizedYearMonth: schedule.lastRecognizedYearMonth,
    expenseSystemKey: schedule.expenseSystemKey,
    status: schedule.status,
    createdAt: schedule.createdAt,
  };
}

/**
 * Every prepaid amortization schedule for the org, newest first, with the
 * remaining asset balance and months left — the accountant's view of what is
 * still amortizing without having to read the ledger.
 */
export const listSchedules = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(
      v.union(v.literal("ACTIVE"), v.literal("FULLY_AMORTIZED"), v.literal("CANCELLED"))
    ),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const rows = await ctx.db
      .query("prepaidExpenseSchedules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const filtered = args.status ? rows.filter((r) => r.status === args.status) : rows;
    return filtered
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(scheduleView);
  },
});
