/**
 * prepaidExpenses.ts
 *
 * A PREPAID expense (e.g. 12 months of insurance paid up front) is capitalized
 * in full to the Prepaid Expenses asset when paid (ruleExpensePosted), then
 * released to its operating-expense account ratably over its term. One row per
 * prepaid expense in prepaidExpenseSchedules. Recognition is driven by the
 * monthly prepaid-expense-amortization cron (crons.ts) — which mirrors the
 * fixed-asset depreciation and F&I-commission recognition crons exactly — or
 * by an accountant explicitly running it early via runAmortizationNow.
 *
 * The schedule is CALENDAR-aligned, not counter-based: each run recognizes
 * everything due *through* its calendar month, computed from the same
 * authoritative integer schedule (recognizedThroughMonthsMinor) the operational
 * P&L report uses. So after a run has processed month M, the schedule has
 * recognized exactly what reports.ts shows as of the end of month M. Catch-up
 * (a missed cron month) and idempotency (a re-run of the same month) both fall
 * out of the "recognize the delta up to this month" math in catchUpPrepaidSchedule.
 *
 * NOTE: schedule.recognizedMinor is bumped as soon as a month is recognized,
 * before the GL posting hook runs — the hook itself may enqueue to the outbox
 * instead of posting immediately (no open period). So recognizedMinor is the
 * authoritative "should be recognized" figure, not proof the GL has actually
 * posted it; scheduleView's postedMinor/pendingMinor/failedMinor (queried from
 * accountingEvents/pendingAccountingEvents) are what distinguish the two for
 * the accountant-facing status.
 */
import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery, query, mutation, action, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id, Doc } from "./_generated/dataModel";
import {
  hookPrepaidExpenseAmortized,
  hookPrepaidExpenseRefunded,
  hookPrepaidExpenseWrittenOff,
} from "./accounting/workflowHooks";
import {
  recognizedDueThroughDateMinor,
  yearMonthStringIndex,
  yearMonthFromIndex,
  occurredAtForMonthIndex,
} from "./utils/expenseAmortization";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { auditLog } from "./financialAudit";
import { notifyFinanceManagers, notifyUser, getActorName } from "./utils/notifications";
import { paymentMethodValidator, type PaymentMethod } from "./utils/paymentMethods";
import { runWithIdempotency } from "./utils/idempotency";
import { drainEntries } from "./accountingOutbox";
import { postedSourceExpenseEvent } from "./utils/prepaidSourceLedger";
import { toMinorUnits } from "./utils/money";

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
 * exactly what was capitalized. `startDate` is the expense's amortizationStartDate
 * when the coverage begins after payment, else its payment date.
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

// ─── Monthly recognition (cron + manual trigger share this) ──────────────────

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

/**
 * Blocks any correction that would post a GL entry against a prepaid asset the
 * ledger has never seen. A write-off debits the expense account and credits
 * Prepaid Expenses; a refund credits Prepaid Expenses (and input VAT) against
 * cash. Both are pure credits to an asset — if the EXPENSE_POSTED that should
 * have debited it is still queued, they leave a negative Prepaid Expenses
 * balance (and negative input VAT) with no offsetting debit anywhere. The
 * queued original does block the period close, but an unclosable period and a
 * nonsensical balance sheet is not the same thing as a correct entry, and it
 * lands an accountant in a state they can only unpick by understanding the
 * outbox internals.
 *
 * amortizeScheduleForMonth has refused to run in exactly this situation since
 * it was written ("source_expense_not_posted"); corrections were simply never
 * given the same guard. A term-only correction is still allowed — it posts
 * nothing, it only reshapes future recognition.
 *
 * "Posted" alone isn't enough: it has to be posted *by* the date this
 * correction books at. The two are dated from different clocks — EXPENSE_POSTED
 * takes the expense's own `date` (expenses.ts), while a correction books at
 * wall-clock now — and nothing stops an expense being dated in the future. So a
 * prepayment dated 1 December, entered and posted in July into an open annual
 * period, is genuinely POSTED while its debit sits five months ahead of a
 * refund booked today: the asset goes negative from July until December, when
 * the debit finally lands. Comparing accountingDate against the correction's own
 * date is what makes the guard about the ledger's timeline rather than about
 * row existence.
 */
async function requireSourceExpensePostedForGlCorrection(
  ctx: MutationCtx,
  schedule: Doc<"prepaidExpenseSchedules">,
  amounts: { refundMinor: number; writeOffMinor: number },
  correctionDate: number
): Promise<void> {
  if (amounts.refundMinor <= 0 && amounts.writeOffMinor <= 0) return;
  const posted = await postedSourceExpenseEvent(ctx, schedule.orgId, schedule.expenseId);
  if (!posted) {
    throw new ConvexError(
      "This prepaid expense hasn't posted to the ledger yet, so it can't be refunded or written off — that would credit a Prepaid Expenses balance that was never debited. Resolve the pending accounting event first (Accounting → Setup), then try again. Changing the amortization term is still allowed."
    );
  }
  if (posted.accountingDate > correctionDate) {
    throw new ConvexError(
      "This prepaid expense is recognized in the ledger on a later date than this correction, so refunding or writing it off now would credit a Prepaid Expenses balance that doesn't exist yet — leaving the asset negative until the original entry's date is reached. Changing the amortization term is still allowed."
    );
  }
}

/**
 * Recognizes one calendar month for one schedule, if due. Idempotent: a
 * re-call for a month at or before the last recognized one is a no-op. Shared
 * handler behind both the internalMutation (cron/tests) and catchUpPrepaidSchedule.
 */
export async function amortizeScheduleForMonth(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    yearMonth: string; // "YYYY-MM" — the calendar month being recognized
    occurredAt: number;
    systemActorId: Id<"users">;
  }
): Promise<{ posted: boolean; reason?: string; amountMinor?: number }> {
  const schedule = await ctx.db.get(args.scheduleId);
  if (!schedule || schedule.orgId !== args.orgId) return { posted: false, reason: "not_found" };
  if (schedule.status !== "ACTIVE") return { posted: false, reason: "not_active" };

  // Don't release the asset before it's been booked: the schedule is created
  // ACTIVE as soon as the expense is marked paid, but the EXPENSE_POSTED entry
  // that debits Prepaid Expenses may still be queued (no open period at
  // posting time). Recognizing first would credit an asset that isn't there
  // yet. Wait until the source expense has actually posted; the next run
  // catches it up once it does.
  const sourcePosted = await postedSourceExpenseEvent(ctx, args.orgId, schedule.expenseId);
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
  // month is caught up in one posting and the cumulative always equals the
  // authoritative schedule.
  const monthsElapsedTarget = Math.min(
    Math.max(yearMonthStringIndex(args.yearMonth) - yearMonthStringIndex(schedule.startYearMonth) + 1, 0),
    schedule.termMonths
  );
  const alreadyRecognizedMonths = schedule.monthsRecognized ?? 0;
  if (monthsElapsedTarget <= alreadyRecognizedMonths) {
    return { posted: false, reason: "nothing_due_yet" };
  }

  // Recognize one calendar month's share at a time (looping internally when
  // this call catches up more than one month at once), computed from what's
  // actually left — remaining balance / remaining months — rather than a
  // whole-curve recompute from month 0 via recognizedThroughMonthsMinor.
  // Necessary because correctSchedule can change totalMinor/termMonths
  // mid-stream: a pure "floor(monthsElapsed * totalMinor / termMonths)"
  // recompute assumes every prior month was posted at the CURRENT total/term,
  // which stops being true the moment a correction changes either — it would
  // silently misstate every future month by however much the correction
  // shifted the curve (verified: a 300 write-off on a 1200/12mo schedule
  // after 3 months posted moved month 4 from 75 to 66.67 once fixed). This
  // iterative form re-derives every month from the schedule's CURRENT
  // remaining balance instead, so already-posted months are never implicated
  // and a corrected schedule always still finishes exactly at its (possibly
  // reduced) total. For a schedule that's never been corrected it produces
  // byte-identical results to the old whole-curve formula — both are
  // standard floor-division fair-share algorithms that coincide month by
  // month — so this changes nothing for the common case.
  let amountMinor = 0;
  let remainingMinor = schedule.totalMinor - schedule.recognizedMinor;
  let remainingMonths = schedule.termMonths - alreadyRecognizedMonths;
  for (let m = alreadyRecognizedMonths + 1; m <= monthsElapsedTarget; m++) {
    const monthShare = remainingMonths <= 1 ? remainingMinor : Math.floor(remainingMinor / remainingMonths);
    amountMinor += monthShare;
    remainingMinor -= monthShare;
    remainingMonths -= 1;
  }
  if (amountMinor <= 0) return { posted: false, reason: "fully_amortized" };

  const newRecognizedMinor = schedule.recognizedMinor + amountMinor;
  await ctx.db.patch(args.scheduleId, {
    recognizedMinor: newRecognizedMinor,
    monthsRecognized: monthsElapsedTarget,
    lastRecognizedYearMonth: args.yearMonth,
    status: newRecognizedMinor >= schedule.totalMinor ? "FULLY_AMORTIZED" : "ACTIVE",
  });

  // Never credit the asset before its own debit. The two dates come off
  // different clocks: EXPENSE_POSTED takes the expense's `date`, while the
  // in-progress month is dated min(end-of-month, now) — so an expense dated
  // later in its own start month than the day this runs (paid on the 25th, cron
  // on the 5th) would release an asset that the ledger doesn't show as booked
  // until twenty days later, leaving Prepaid Expenses negative in between.
  //
  // Dated at the debit rather than refused: this is a valid schedule whose asset
  // really is booked, and refusing it would stall recognition — and the period
  // close that checks recognition is caught up — over a few days' skew. The
  // clamp cannot push recognition out of the month it recognizes, because
  // expenses.ts forbids an amortizationStartDate earlier than the expense's own
  // month: the debit therefore always falls at or before the end of the start
  // month. (Recognition never runs ahead of the debit's month anyway — a month
  // index past the current one is outside catchUpPrepaidSchedule's loop.) The
  // report buckets by payload.yearMonth, not this date, so the month a figure
  // reports in is unaffected either way — see prepaidRecognitionEvents.ts.
  const occurredAt = Math.max(args.occurredAt, sourcePosted.accountingDate);

  await hookPrepaidExpenseAmortized(ctx, {
    orgId: args.orgId,
    scheduleId: args.scheduleId,
    yearMonth: args.yearMonth,
    amountMinor,
    currency: schedule.currency,
    expenseSystemKey: schedule.expenseSystemKey,
    actorId: args.systemActorId,
    occurredAt,
  });

  return { posted: true, amountMinor };
}

export const amortizePrepaidExpenseForMonth = internalMutation({
  args: {
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    yearMonth: v.string(),
    occurredAt: v.number(),
    systemActorId: v.id("users"),
  },
  handler: amortizeScheduleForMonth,
});

/**
 * Catches up one ACTIVE schedule through `throughYearMonth` (inclusive), one
 * GL posting per missing month, stopping early if the source expense hasn't
 * posted yet. Shared by the monthly cron and the accountant-triggered manual
 * run (runAmortizationNow / retryAmortization) so both follow byte-identical
 * recognition logic — there is exactly one code path that decides what a
 * schedule recognizes and when.
 */
export async function catchUpPrepaidSchedule(
  ctx: MutationCtx,
  schedule: Doc<"prepaidExpenseSchedules">,
  args: { throughYearMonth: string; now: number; systemActorId: Id<"users"> }
): Promise<{ monthsPosted: number; stoppedReason?: string }> {
  if (schedule.status !== "ACTIVE") return { monthsPosted: 0, stoppedReason: "not_active" };

  const startIdx = yearMonthStringIndex(schedule.startYearMonth);
  const lastIdx = schedule.lastRecognizedYearMonth
    ? yearMonthStringIndex(schedule.lastRecognizedYearMonth)
    : startIdx - 1;
  const fromIdx = Math.max(startIdx, lastIdx + 1);
  const toIdx = Math.min(yearMonthStringIndex(args.throughYearMonth), startIdx + schedule.termMonths - 1);

  let monthsPosted = 0;
  let stoppedReason: string | undefined;
  for (let idx = fromIdx; idx <= toIdx; idx++) {
    const result = await amortizeScheduleForMonth(ctx, {
      orgId: schedule.orgId,
      scheduleId: schedule._id,
      yearMonth: yearMonthFromIndex(idx),
      occurredAt: occurredAtForMonthIndex(idx, args.now),
      systemActorId: args.systemActorId,
    });
    if (result.posted) {
      monthsPosted++;
      continue;
    }
    // The source expense hasn't posted yet (queued behind a closed period at
    // payment time): no later month can post either, so stop and let the next
    // run catch the whole schedule up once it posts.
    if (result.reason === "source_expense_not_posted") {
      stoppedReason = result.reason;
      break;
    }
  }
  return { monthsPosted, stoppedReason };
}

/**
 * Cron-facing: catches up a single schedule (by id) through the given month —
 * one mutation call per schedule instead of one per schedule-month, since the
 * whole catch-up loop now runs inside a single transaction. Called from
 * crons.ts's ActionCtx via ctx.runMutation.
 */
export const catchUpScheduleMutation = internalMutation({
  args: {
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    throughYearMonth: v.string(),
    now: v.number(),
    systemActorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule || schedule.orgId !== args.orgId) return { monthsPosted: 0, stoppedReason: "not_found" };
    return catchUpPrepaidSchedule(ctx, schedule, {
      throughYearMonth: args.throughYearMonth,
      now: args.now,
      systemActorId: args.systemActorId,
    });
  },
});

// ─── Per-schedule cron failure tracking (item: accountant alerts + retry) ────

/**
 * Records one schedule's cron catch-up failure (the cron's own try/catch
 * previously only incremented an aggregate counter, discarding which
 * schedule/org/error caused it) and alerts the org owner in-app. Called from
 * crons.ts's catch block via ctx.runMutation, since an ActionCtx can't touch
 * ctx.db directly.
 */
export const recordAmortizationFailure = internalMutation({
  args: {
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    yearMonth: v.string(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("prepaidAmortizationFailures", {
      orgId: args.orgId,
      scheduleId: args.scheduleId,
      yearMonth: args.yearMonth,
      errorMessage: args.errorMessage,
      createdAt: Date.now(),
    });
    const schedule = await ctx.db.get(args.scheduleId);
    const expense = schedule ? await ctx.db.get(schedule.expenseId) : null;
    await notifyFinanceManagers(ctx, args.orgId, "accounting.prepaidAmortizationFailed", {
      expenseTitle: expense?.title ?? "Prepaid expense",
      yearMonth: args.yearMonth,
      errorMessage: args.errorMessage,
    });
  },
});

/**
 * Accountant-facing safe retry for a schedule with unresolved cron failures —
 * re-runs the same catchUpPrepaidSchedule logic through the current month and,
 * on success, marks every unresolved failure record for this schedule resolved.
 */
export const retryAmortizationFailure = mutation({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule || schedule.orgId !== args.orgId) {
      throw new ConvexError("Prepaid schedule not found in this organization.");
    }

    const now = Date.now();
    const currentYearMonth = toYearMonth(now);
    const result = await catchUpPrepaidSchedule(ctx, schedule, {
      throughYearMonth: currentYearMonth,
      now,
      systemActorId: user._id,
    });

    // catchUpPrepaidSchedule sets stoppedReason when it had to break out early
    // (currently only "source_expense_not_posted") — the underlying blocker is
    // still there, so marking every failure resolved here would report success
    // to the accountant while the schedule is still stuck. Only clear the
    // failure records once the loop actually ran clean through the target month.
    if (result.stoppedReason) {
      throw new ConvexError(
        `Retry could not clear the blocker (${result.stoppedReason}). The schedule's source expense still hasn't posted — resolve that first, then retry.`
      );
    }

    const unresolved = (
      await ctx.db
        .query("prepaidAmortizationFailures")
        .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
        .collect()
    ).filter((f) => f.resolvedAt === undefined);
    for (const failure of unresolved) {
      await ctx.db.patch(failure._id, { resolvedAt: now });
    }

    return result;
  },
});

// ─── Accountant-triggered manual run (item: no longer cron-only) ─────────────

/**
 * Auth + the org's ACTIVE schedule list for the manual run action below —
 * split out because an action can't touch ctx.db directly, and doing the
 * auth/feature check here (not in the action) means it runs inside a real
 * query/mutation context, matching how every other tenant-auth check in this
 * codebase works.
 */
export const listActiveForManualRun = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const schedules = await ctx.db
      .query("prepaidExpenseSchedules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("status"), "ACTIVE"))
      .collect();
    const expenses = await Promise.all(schedules.map((s) => ctx.db.get(s.expenseId)));

    return {
      userId: user._id,
      schedules: schedules.map((s, i) => ({
        id: s._id,
        expenseTitle: expenses[i]?.title ?? "Prepaid expense",
      })),
    };
  },
});

/**
 * Runs prepaid amortization immediately for every ACTIVE schedule in one org,
 * instead of waiting for the 1st-of-month cron. The accountant, not a
 * background job impersonating the owner, is the actor on every posting.
 *
 * An action orchestrating one mutation call per schedule — same shape as the
 * cron (crons.ts's runPrepaidExpenseAmortization) — so one schedule's failure
 * can no longer roll back or block every other schedule in the org, the way a
 * single all-schedules mutation would (a throw inside a Convex mutation rolls
 * back every write in that call, per feedback_convex_mutation_atomicity).
 * Every failure is persisted to the same prepaidAmortizationFailures table the
 * cron uses, so retry (retryAmortizationFailure) and the accountant-facing
 * failure badge work identically regardless of which path caused the failure.
 */
export const runAmortizationNow = action({
  args: { orgId: v.id("organizations") },
  handler: async (
    ctx,
    args
  ): Promise<{
    posted: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; monthsPosted: number }>;
    blocked: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; reason: string }>;
    failed: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; error: string }>;
    upToDateCount: number;
    scheduleCount: number;
  }> => {
    const { userId, schedules } = await ctx.runQuery(internal.prepaidExpenses.listActiveForManualRun, {
      orgId: args.orgId,
    });

    const now = Date.now();
    const currentYearMonth = toYearMonth(now);

    const posted: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; monthsPosted: number }> = [];
    const blocked: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; reason: string }> = [];
    const failed: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; title: string; error: string }> = [];
    let upToDateCount = 0;

    for (const schedule of schedules) {
      try {
        const result = await ctx.runMutation(internal.prepaidExpenses.catchUpScheduleMutation, {
          orgId: args.orgId,
          scheduleId: schedule.id,
          throughYearMonth: currentYearMonth,
          now,
          systemActorId: userId,
        });
        if (result.stoppedReason) {
          blocked.push({ scheduleId: schedule.id, title: schedule.expenseTitle, reason: result.stoppedReason });
        } else if (result.monthsPosted > 0) {
          posted.push({ scheduleId: schedule.id, title: schedule.expenseTitle, monthsPosted: result.monthsPosted });
        } else {
          upToDateCount++;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        failed.push({ scheduleId: schedule.id, title: schedule.expenseTitle, error: errorMessage });
        await ctx.runMutation(internal.prepaidExpenses.recordAmortizationFailure, {
          orgId: args.orgId,
          scheduleId: schedule.id,
          yearMonth: currentYearMonth,
          errorMessage,
        });
      }
    }

    return { posted, blocked, failed, upToDateCount, scheduleCount: schedules.length };
  },
});

// ─── Schedule-scoped redrive (item: full GL-status visibility) ───────────────

/**
 * Re-drives just ONE schedule's own PENDING/FAILED outbox rows (amortization
 * months and/or corrections) — the accountant-facing counterpart to the
 * cron/period-open re-drive, for a schedule stuck behind a since-resolved
 * blocker (chart just initialized, period just reopened) without waiting for
 * the next org-wide drain. Shares accountingOutbox.drainEntries with
 * drainPendingForOrg, so posting/retry/dead-letter behavior is identical.
 */
export const redriveScheduleEvents = mutation({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule || schedule.orgId !== args.orgId) {
      throw new ConvexError("Prepaid schedule not found in this organization.");
    }

    const scheduleKey = args.scheduleId.toString();
    const sourceKey = `expense_posted_${schedule.expenseId}`;
    const scheduleRows: Doc<"pendingAccountingEvents">[] = [];
    // The schedule's own asset debit. It is sourceType "expenses", not
    // "prepaidExpenseSchedules", so a schedule-scoped sweep that filters on
    // sourceType alone can never see it — leaving this button able to post the
    // schedule's credits while the debit they depend on stays queued forever,
    // which is precisely the state it is meant to rescue the accountant from.
    let sourceRow: Doc<"pendingAccountingEvents"> | null = null;
    for (const status of ["PENDING", "FAILED"] as const) {
      const rows = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .collect();
      for (const row of rows) {
        if (row.kind === "POST" && row.idempotencyKey === sourceKey) {
          sourceRow = row;
          continue;
        }
        if (row.sourceType !== "prepaidExpenseSchedules") continue;
        if ((row.payload as { scheduleId?: string })?.scheduleId !== scheduleKey) continue;
        scheduleRows.push(row);
      }
    }

    // Source debit first: the schedule's own entries are guarded against
    // posting ahead of it (prepaidSourceLedger.ts), so draining them in the
    // other order would hold every one of them and the button would report
    // doing nothing on the very schedule it just unblocked.
    const matches = sourceRow ? [sourceRow, ...scheduleRows] : scheduleRows;

    // A dead-lettered row's attempts counter is already at/above the retry
    // threshold — reset it so drainEntries gives it a real attempt instead of
    // immediately re-dead-lettering on what looks like an already-exhausted try.
    const toDrain = matches.map((row) => (row.status === "FAILED" ? { ...row, attempts: 0 } : row));

    return await drainEntries(ctx, toDrain);
  },
});

// ─── Corrections: partial refund / non-refundable write-off / term change ────

/**
 * How much input VAT is still eligible to be refunded against this schedule:
 * the source expense's own original taxAmount, minus whatever VAT this
 * schedule's corrections have already refunded. Tax isn't part of the
 * prepaid asset (schedule totals are net by design), so this is tracked
 * against the expense's taxAmount rather than the schedule's remaining
 * balance. Shared by correctSchedule's own validation and the read-only
 * query the correction dialog uses to show the cap as helper text.
 */
async function remainingRefundableTaxMinorForSchedule(
  ctx: QueryCtx | MutationCtx,
  schedule: Doc<"prepaidExpenseSchedules">
): Promise<number> {
  const expense = await ctx.db.get(schedule.expenseId);
  const originalTaxMinor = expense?.taxAmount ? toMinorUnits(expense.taxAmount, schedule.currency) : 0;
  const priorCorrections = await ctx.db
    .query("prepaidScheduleCorrections")
    .withIndex("by_schedule", (q) => q.eq("scheduleId", schedule._id))
    .collect();
  const alreadyRefundedTaxMinor = priorCorrections.reduce((sum, c) => sum + (c.refundTaxMinor ?? 0), 0);
  return Math.max(originalTaxMinor - alreadyRefundedTaxMinor, 0);
}

/** Read-only counterpart of remainingRefundableTaxMinorForSchedule, for the correction dialog's helper text. */
export const getRemainingRefundableTaxMinor = query({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule || schedule.orgId !== args.orgId) {
      throw new ConvexError("Prepaid schedule not found in this organization.");
    }
    return remainingRefundableTaxMinorForSchedule(ctx, schedule);
  },
});

interface CorrectionInputs {
  refundMinor: number;
  refundTaxMinor: number;
  refundPaymentMethod?: PaymentMethod;
  writeOffMinor: number;
  newTermMonths: number;
}

/**
 * All the business-rule validation for a schedule correction, independent of
 * whether it's about to apply directly or is only being checked before
 * queuing a maker-checker approval request — both paths must reject the same
 * inputs, so an accountant never gets a "this looks fine" acknowledgment for
 * a request that would fail validation again at approval time.
 */
function validateCorrectionInputs(
  schedule: Doc<"prepaidExpenseSchedules">,
  inputs: CorrectionInputs,
  remainingRefundableTaxMinor: number
): void {
  const { refundMinor, refundTaxMinor, writeOffMinor, newTermMonths } = inputs;
  if (refundMinor < 0 || writeOffMinor < 0 || refundTaxMinor < 0) {
    throw new ConvexError("Refund, VAT, and write-off amounts cannot be negative.");
  }
  if (refundMinor > 0 && !inputs.refundPaymentMethod) {
    throw new ConvexError("A payment method is required to record a refund.");
  }
  if (refundTaxMinor > 0 && refundMinor <= 0) {
    throw new ConvexError("A VAT refund requires a net refund amount alongside it.");
  }
  if (refundTaxMinor > 0 && refundTaxMinor > remainingRefundableTaxMinor) {
    throw new ConvexError(
      `VAT refund (${refundTaxMinor}) cannot exceed the remaining refundable input VAT (${remainingRefundableTaxMinor}).`
    );
  }

  const termChanged = newTermMonths !== schedule.termMonths;
  if (refundMinor === 0 && writeOffMinor === 0 && !termChanged) {
    throw new ConvexError("No change specified — provide a refund, write-off, or new term.");
  }
  if (!Number.isInteger(newTermMonths) || newTermMonths < 1 || newTermMonths > 600) {
    throw new ConvexError("Term must be a whole number of months, between 1 and 600.");
  }
  const monthsRecognized = schedule.monthsRecognized ?? 0;
  if (newTermMonths < monthsRecognized) {
    throw new ConvexError(
      `Term cannot be shortened below the ${monthsRecognized} month(s) already recognized. Use a write-off for the remainder instead.`
    );
  }

  const remainingMinor = Math.max(schedule.totalMinor - schedule.recognizedMinor, 0);
  if (refundMinor + writeOffMinor > remainingMinor) {
    throw new ConvexError(
      `Refund + write-off (${refundMinor + writeOffMinor}) cannot exceed the unrecognized remainder (${remainingMinor}).`
    );
  }

  // A term equal to monthsRecognized leaves zero future months for
  // amortizeScheduleForMonth to ever recognize — if the refund/write-off
  // doesn't also cover the entire remainder, the leftover balance would sit
  // ACTIVE in the Prepaid Expenses asset forever with no path to expense it.
  if (newTermMonths <= monthsRecognized && refundMinor + writeOffMinor < remainingMinor) {
    throw new ConvexError(
      "The corrected term leaves no future month to recognize the remaining balance — either keep at least one month beyond what's already recognized, or write off/refund the full remainder."
    );
  }
}

/**
 * The core of a schedule correction — validates against the schedule's
 * CURRENT state (never trusts a caller's earlier read, since a maker-checker
 * approval can apply long after the request was validated at submission
 * time) and applies it: correction row, schedule patch, GL hooks, audit log.
 * Shared by correctSchedule's direct-apply path and approveCorrectionRequest,
 * so both follow byte-identical business rules and GL posting.
 */
async function applyScheduleCorrection(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    refundMinor: number;
    refundTaxMinor: number;
    refundPaymentMethod?: PaymentMethod;
    writeOffMinor: number;
    newTermMonths: number | undefined;
    reason: string;
    reference: string | undefined;
    actorId: Id<"users">;
  }
): Promise<Id<"prepaidScheduleCorrections">> {
  const schedule = await ctx.db.get(args.scheduleId);
  if (!schedule || schedule.orgId !== args.orgId) {
    throw new ConvexError("Prepaid schedule not found in this organization.");
  }
  if (schedule.status !== "ACTIVE") {
    throw new ConvexError(`Cannot correct a schedule with status "${schedule.status}".`);
  }

  // The one date this correction happens on: handed to the guard and then used
  // verbatim for the correction row and its GL entries, so the date the guard
  // vets is the date that actually posts. Reading the clock again lower down
  // would let the two drift apart and reopen the ordering hole the guard closes.
  const now = Date.now();

  // Re-checked here rather than only at submission: this is the single choke
  // point both the direct path and approveCorrectionRequest go through, and an
  // approval can land long after the request, by which time the source expense
  // may still be unposted — or still be dated ahead of the approval.
  await requireSourceExpensePostedForGlCorrection(
    ctx,
    schedule,
    { refundMinor: args.refundMinor, writeOffMinor: args.writeOffMinor },
    now
  );

  const newTermMonths = args.newTermMonths ?? schedule.termMonths;
  const remainingRefundableTaxMinor =
    args.refundTaxMinor > 0 ? await remainingRefundableTaxMinorForSchedule(ctx, schedule) : 0;
  validateCorrectionInputs(
    schedule,
    {
      refundMinor: args.refundMinor,
      refundTaxMinor: args.refundTaxMinor,
      refundPaymentMethod: args.refundPaymentMethod,
      writeOffMinor: args.writeOffMinor,
      newTermMonths,
    },
    remainingRefundableTaxMinor
  );

  const correctionId = await ctx.db.insert("prepaidScheduleCorrections", {
    orgId: args.orgId,
    scheduleId: args.scheduleId,
    refundMinor: args.refundMinor,
    refundTaxMinor: args.refundMinor > 0 ? args.refundTaxMinor : undefined,
    refundPaymentMethod: args.refundMinor > 0 ? args.refundPaymentMethod : undefined,
    writeOffMinor: args.writeOffMinor,
    previousTermMonths: schedule.termMonths,
    newTermMonths,
    reason: args.reason,
    reference: args.refundMinor > 0 ? args.reference : undefined,
    actorId: args.actorId,
    createdAt: now,
  });

  const newTotalMinor = schedule.totalMinor - args.refundMinor - args.writeOffMinor;
  await ctx.db.patch(args.scheduleId, {
    totalMinor: newTotalMinor,
    termMonths: newTermMonths,
    status: newTotalMinor <= schedule.recognizedMinor ? "CANCELLED" : "ACTIVE",
  });

  if (args.refundMinor > 0) {
    await hookPrepaidExpenseRefunded(ctx, {
      orgId: args.orgId,
      scheduleId: args.scheduleId,
      correctionId,
      amountMinor: args.refundMinor,
      taxMinor: args.refundTaxMinor > 0 ? args.refundTaxMinor : undefined,
      currency: schedule.currency,
      paymentMethod: args.refundPaymentMethod,
      actorId: args.actorId,
      occurredAt: now,
    });
  }
  if (args.writeOffMinor > 0) {
    await hookPrepaidExpenseWrittenOff(ctx, {
      orgId: args.orgId,
      scheduleId: args.scheduleId,
      correctionId,
      amountMinor: args.writeOffMinor,
      currency: schedule.currency,
      expenseSystemKey: schedule.expenseSystemKey,
      actorId: args.actorId,
      occurredAt: now,
    });
  }

  const vatSuffix = args.refundTaxMinor > 0 ? ` (+${args.refundTaxMinor} VAT)` : "";
  const referenceSuffix = args.reference ? `, ref ${args.reference}` : "";
  await auditLog(ctx, {
    orgId: args.orgId,
    actorId: args.actorId,
    actionType: "CORRECT_PREPAID_SCHEDULE",
    resourceType: "prepaidExpenseSchedules",
    resourceId: args.scheduleId.toString(),
    description: `Corrected prepaid schedule: refund ${args.refundMinor}${vatSuffix}, write-off ${args.writeOffMinor}, term ${schedule.termMonths} -> ${newTermMonths}${referenceSuffix}. Reason: ${args.reason}`,
  });

  return correctionId;
}

/**
 * The only way to adjust an ACTIVE schedule short of a full expense reversal.
 * `refundMinor` (cash/bank refund for the unused portion) and `writeOffMinor`
 * (non-refundable unused portion expensed immediately) can be combined — e.g.
 * an early cancellation where some months are a non-refundable penalty and the
 * rest is refunded. Both are capped by the schedule's current unrecognized
 * remainder, since only that portion is still sitting in the Prepaid Expenses
 * asset. `newTermMonths`, if given, can shorten the remaining term no further
 * than what's already been recognized (can't retroactively invalidate posted
 * months) or extend it freely.
 *
 * Maker-checker: a non-owner's write-off (asset -> P&L, the highest-risk
 * correction shape) doesn't apply immediately — it creates a
 * prepaidCorrectionRequests row for another MANAGE_FINANCE holder or the
 * owner to approve/reject (see approveCorrectionRequest). Owner submissions
 * and refund-only/term-only corrections (no write-off) always apply directly.
 */
export const correctSchedule = mutation({
  args: {
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    refundMinor: v.optional(v.number()),
    refundTaxMinor: v.optional(v.number()),
    refundPaymentMethod: v.optional(paymentMethodValidator),
    writeOffMinor: v.optional(v.number()),
    newTermMonths: v.optional(v.number()),
    reason: v.string(),
    reference: v.optional(v.string()), // vendor credit-note / reference number, refund only
    // A double-click, dialog re-submit, or client retry must not create two
    // corrections (two refunds, two write-offs) for what the accountant only
    // intended once — same idempotency discipline expenses.create already
    // uses. The dialog mints one fresh key per open, so a retry within one
    // open replays safely and a second, deliberate open gets a new key.
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("A reason is required for a schedule correction.");
    const reference = args.reference?.trim() || undefined;

    const refundMinor = Math.round(args.refundMinor ?? 0);
    const refundTaxMinor = Math.round(args.refundTaxMinor ?? 0);
    const writeOffMinor = Math.round(args.writeOffMinor ?? 0);
    const requiresApproval = writeOffMinor > 0 && !isSystemOwnerRole(role);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: requiresApproval ? "submitPrepaidCorrectionRequest" : "correctPrepaidSchedule",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          scheduleId: args.scheduleId,
          refundMinor,
          refundTaxMinor,
          refundPaymentMethod: refundMinor > 0 ? (args.refundPaymentMethod ?? null) : null,
          writeOffMinor,
          newTermMonths: args.newTermMonths ?? null,
          reason,
          reference: reference ?? null,
        }),
      },
      async () => {
        if (!requiresApproval) {
          const correctionId = await applyScheduleCorrection(ctx, {
            orgId: args.orgId,
            scheduleId: args.scheduleId,
            refundMinor,
            refundTaxMinor,
            refundPaymentMethod: args.refundPaymentMethod,
            writeOffMinor,
            newTermMonths: args.newTermMonths,
            reason,
            reference,
            actorId: user._id,
          });
          return { status: "APPLIED" as const, correctionId, requestId: null };
        }

        // Same validation the direct path runs, checked up front so the
        // accountant gets immediate feedback instead of a surprise rejection
        // once someone finally reviews the request.
        const schedule = await ctx.db.get(args.scheduleId);
        if (!schedule || schedule.orgId !== args.orgId) {
          throw new ConvexError("Prepaid schedule not found in this organization.");
        }
        if (schedule.status !== "ACTIVE") {
          throw new ConvexError(`Cannot correct a schedule with status "${schedule.status}".`);
        }
        // Vetted against submission time, which is the earliest the correction
        // could post. applyScheduleCorrection re-runs it against the real
        // posting date at approval — this is only to fail the accountant fast.
        await requireSourceExpensePostedForGlCorrection(
          ctx,
          schedule,
          { refundMinor, writeOffMinor },
          Date.now()
        );

        const newTermMonths = args.newTermMonths ?? schedule.termMonths;
        const remainingRefundableTaxMinor =
          refundTaxMinor > 0 ? await remainingRefundableTaxMinorForSchedule(ctx, schedule) : 0;
        validateCorrectionInputs(
          schedule,
          { refundMinor, refundTaxMinor, refundPaymentMethod: args.refundPaymentMethod, writeOffMinor, newTermMonths },
          remainingRefundableTaxMinor
        );

        const now = Date.now();
        const requestId = await ctx.db.insert("prepaidCorrectionRequests", {
          orgId: args.orgId,
          scheduleId: args.scheduleId,
          refundMinor,
          refundTaxMinor: refundMinor > 0 ? refundTaxMinor : undefined,
          refundPaymentMethod: refundMinor > 0 ? args.refundPaymentMethod : undefined,
          writeOffMinor,
          newTermMonths,
          reason,
          reference: refundMinor > 0 ? reference : undefined,
          status: "PENDING",
          requestedBy: user._id,
          createdAt: now,
        });

        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "REQUEST_PREPAID_CORRECTION",
          resourceType: "prepaidCorrectionRequests",
          resourceId: requestId.toString(),
          description: `Requested approval for a prepaid write-off: refund ${refundMinor}, write-off ${writeOffMinor}. Reason: ${reason}`,
        });

        const expense = await ctx.db.get(schedule.expenseId);
        const actorName = await getActorName(ctx);
        // Every OTHER MANAGE_FINANCE holder (or the owner) — never the maker
        // themselves, who already knows they just submitted this.
        await notifyFinanceManagers(
          ctx,
          args.orgId,
          "accounting.prepaidCorrectionRequested",
          { actorName, expenseTitle: expense?.title ?? "Prepaid expense", amount: String(writeOffMinor) },
          { excludeUserId: user._id }
        );

        return { status: "PENDING" as const, correctionId: null, requestId };
      }
    );
  },
});

/** Every PENDING correction request for the org, newest first, enriched for the approval panel. */
export const listPendingCorrectionRequests = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const requests = await ctx.db
      .query("prepaidCorrectionRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .collect();

    const enriched = await Promise.all(
      requests.map(async (r) => {
        const schedule = await ctx.db.get(r.scheduleId);
        const expense = schedule ? await ctx.db.get(schedule.expenseId) : null;
        const requester = await ctx.db.get(r.requestedBy);
        return {
          ...r,
          expenseTitle: expense?.title ?? "Prepaid expense",
          currency: schedule?.currency ?? "USD",
          requestedByName: requester?.name ?? requester?.email ?? "Unknown",
        };
      })
    );
    return enriched.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * Approves a PENDING correction request and applies it — re-validated
 * against the schedule's CURRENT state (balances may have moved while the
 * request sat pending), attributed on the GL/audit trail to the original
 * requester (the approver's decision is its own record on the request row).
 * The maker can never approve their own request.
 */
export const approveCorrectionRequest = mutation({
  args: { orgId: v.id("organizations"), requestId: v.id("prepaidCorrectionRequests"), decisionNote: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const request = await ctx.db.get(args.requestId);
    if (!request || request.orgId !== args.orgId) {
      throw new ConvexError("Correction request not found in this organization.");
    }
    if (request.status !== "PENDING") {
      throw new ConvexError(`This request has already been ${request.status.toLowerCase()}.`);
    }
    if (request.requestedBy === user._id) {
      throw new ConvexError("You cannot approve your own correction request — ask another finance manager or the owner.");
    }

    const correctionId = await applyScheduleCorrection(ctx, {
      orgId: args.orgId,
      scheduleId: request.scheduleId,
      refundMinor: request.refundMinor,
      refundTaxMinor: request.refundTaxMinor ?? 0,
      refundPaymentMethod: request.refundPaymentMethod,
      writeOffMinor: request.writeOffMinor,
      newTermMonths: request.newTermMonths,
      reason: request.reason,
      reference: request.reference,
      actorId: request.requestedBy,
    });

    await ctx.db.patch(args.requestId, {
      status: "APPROVED",
      decidedBy: user._id,
      decidedAt: Date.now(),
      decisionNote: args.decisionNote,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "APPROVE_PREPAID_CORRECTION",
      resourceType: "prepaidCorrectionRequests",
      resourceId: args.requestId.toString(),
      description: `Approved prepaid correction request (write-off ${request.writeOffMinor}). Reason: ${request.reason}`,
    });

    const schedule = await ctx.db.get(request.scheduleId);
    const expense = schedule ? await ctx.db.get(schedule.expenseId) : null;
    await notifyUser(ctx, args.orgId, request.requestedBy, "accounting.prepaidCorrectionDecided", {
      expenseTitle: expense?.title ?? "Prepaid expense",
      status: "approved",
    });

    return correctionId;
  },
});

/**
 * Rejects a PENDING correction request — no schedule change, no GL posting.
 * Unlike approval, a requester CAN reject/withdraw their own request (same
 * self-service-cancel precedent as approvals.cancelMyApproval); segregation
 * of duties only requires that the maker can't be the one who approves.
 */
export const rejectCorrectionRequest = mutation({
  args: { orgId: v.id("organizations"), requestId: v.id("prepaidCorrectionRequests"), decisionNote: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const request = await ctx.db.get(args.requestId);
    if (!request || request.orgId !== args.orgId) {
      throw new ConvexError("Correction request not found in this organization.");
    }
    if (request.status !== "PENDING") {
      throw new ConvexError(`This request has already been ${request.status.toLowerCase()}.`);
    }

    await ctx.db.patch(args.requestId, {
      status: "REJECTED",
      decidedBy: user._id,
      decidedAt: Date.now(),
      decisionNote: args.decisionNote,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "REJECT_PREPAID_CORRECTION",
      resourceType: "prepaidCorrectionRequests",
      resourceId: args.requestId.toString(),
      description: `Rejected prepaid correction request (write-off ${request.writeOffMinor}). Reason: ${request.reason}`,
    });

    if (request.requestedBy !== user._id) {
      const schedule = await ctx.db.get(request.scheduleId);
      const expense = schedule ? await ctx.db.get(schedule.expenseId) : null;
      await notifyUser(ctx, args.orgId, request.requestedBy, "accounting.prepaidCorrectionDecided", {
        expenseTitle: expense?.title ?? "Prepaid expense",
        status: "rejected",
      });
    }
  },
});

/** Every correction ever applied to a schedule, newest first — the accountant's audit trail for that schedule. */
export const listCorrections = query({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const rows = await ctx.db
      .query("prepaidScheduleCorrections")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .collect();
    return rows.filter((r) => r.orgId === args.orgId).sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * A schedule's unresolved cron/manual-run catch-up failures, newest first —
 * the accountant-facing detail behind listSchedules' openFailureCount, loaded
 * on demand (e.g. a status-detail popover) rather than embedded in the
 * broader org-wide schedule list.
 */
export const listOpenFailures = query({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const rows = await ctx.db
      .query("prepaidAmortizationFailures")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .collect();
    return rows
      .filter((r) => r.orgId === args.orgId && r.resolvedAt === undefined)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

// ─── Accountant-facing schedule list + status ────────────────────────────────

/**
 * Every prepaid amortization schedule for the org, newest first, enriched with:
 * - dueMinor: what the authoritative schedule says should be recognized by now
 * - postedMinor/pendingMinor/failedMinor: what has actually happened on the GL
 *   side (accountingEvents / the outbox) — distinct from recognizedMinor,
 *   which bumps before the GL hook runs and so can be ahead of what's posted
 * - openFailureCount: unresolved cron catch-up failures needing a retry
 * - expenseTitle/expenseVendor: joined from the source expense for display
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

    // One org-wide pass each for posted GL events, pending/failed outbox
    // entries, and open cron failures — grouped by scheduleId in JS — instead
    // of per-schedule queries, so this stays O(schedules + events) even as a
    // schedule list grows.
    const postedEvents = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) => q.eq("orgId", args.orgId).eq("eventType", "PREPAID_EXPENSE_AMORTIZED"))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .collect();
    const postedByScheduleId = new Map<string, number>();
    for (const event of postedEvents) {
      const scheduleId = (event.payload as { scheduleId?: string })?.scheduleId;
      const amountMinor = (event.payload as { amountMinor?: number })?.amountMinor ?? 0;
      if (!scheduleId) continue;
      postedByScheduleId.set(scheduleId, (postedByScheduleId.get(scheduleId) ?? 0) + amountMinor);
    }

    // Refund/write-off corrections share sourceType + scheduleId with ordinary
    // monthly amortization but are their own eventTypes — routed into their
    // own pendingCorrection/failedCorrection buckets (not the plain
    // pending/failed ones) so a queued or dead-lettered correction is visible
    // to the accountant instead of silently missing from every total, while
    // still never being miscounted as pending/failed amortization.
    const pendingByScheduleId = new Map<string, number>();
    const failedByScheduleId = new Map<string, number>();
    const pendingCorrectionByScheduleId = new Map<string, number>();
    const failedCorrectionByScheduleId = new Map<string, number>();
    for (const status of ["PENDING", "FAILED"] as const) {
      const isPending = status === "PENDING";
      const queued = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .collect();
      for (const entry of queued) {
        if (entry.sourceType !== "prepaidExpenseSchedules" || entry.kind !== "POST") continue;
        const scheduleId = (entry.payload as { scheduleId?: string })?.scheduleId;
        const amountMinor = (entry.payload as { amountMinor?: number })?.amountMinor ?? 0;
        if (!scheduleId) continue;

        if (entry.eventType === "PREPAID_EXPENSE_AMORTIZED") {
          const target = isPending ? pendingByScheduleId : failedByScheduleId;
          target.set(scheduleId, (target.get(scheduleId) ?? 0) + amountMinor);
        } else if (entry.eventType === "PREPAID_EXPENSE_REFUNDED" || entry.eventType === "PREPAID_EXPENSE_WRITTEN_OFF") {
          const target = isPending ? pendingCorrectionByScheduleId : failedCorrectionByScheduleId;
          target.set(scheduleId, (target.get(scheduleId) ?? 0) + amountMinor);
        }
      }
    }

    const openFailures = (
      await ctx.db
        .query("prepaidAmortizationFailures")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).filter((f) => f.resolvedAt === undefined);
    const failureCountByScheduleId = new Map<string, number>();
    for (const failure of openFailures) {
      const key = failure.scheduleId.toString();
      failureCountByScheduleId.set(key, (failureCountByScheduleId.get(key) ?? 0) + 1);
    }

    const now = Date.now();
    const sorted = filtered.sort((a, b) => b.createdAt - a.createdAt);
    const expenses = await Promise.all(sorted.map((s) => ctx.db.get(s.expenseId)));

    return sorted.map((schedule, i) => {
      const key = schedule._id.toString();
      const monthsRecognized = schedule.monthsRecognized ?? 0;
      const expense = expenses[i];
      return {
        _id: schedule._id,
        expenseId: schedule.expenseId,
        expenseTitle: expense?.title,
        expenseVendor: expense?.vendor,
        currency: schedule.currency,
        totalMinor: schedule.totalMinor,
        recognizedMinor: schedule.recognizedMinor,
        remainingMinor: Math.max(schedule.totalMinor - schedule.recognizedMinor, 0),
        dueMinor: recognizedDueThroughDateMinor(
          { totalMinor: schedule.totalMinor, termMonths: schedule.termMonths, startYearMonth: schedule.startYearMonth, currency: schedule.currency },
          { recognizedMinor: schedule.recognizedMinor, monthsRecognized: monthsRecognized },
          now
        ),
        postedMinor: postedByScheduleId.get(key) ?? 0,
        pendingMinor: pendingByScheduleId.get(key) ?? 0,
        failedMinor: failedByScheduleId.get(key) ?? 0,
        pendingCorrectionMinor: pendingCorrectionByScheduleId.get(key) ?? 0,
        failedCorrectionMinor: failedCorrectionByScheduleId.get(key) ?? 0,
        openFailureCount: failureCountByScheduleId.get(key) ?? 0,
        termMonths: schedule.termMonths,
        monthsRecognized,
        monthsRemaining: Math.max(schedule.termMonths - monthsRecognized, 0),
        startYearMonth: schedule.startYearMonth,
        lastRecognizedYearMonth: schedule.lastRecognizedYearMonth,
        expenseSystemKey: schedule.expenseSystemKey,
        status: schedule.status,
        createdAt: schedule.createdAt,
      };
    });
  },
});
