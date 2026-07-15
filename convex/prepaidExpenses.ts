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
import { internalMutation, internalQuery, query, mutation, MutationCtx } from "./_generated/server";
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
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { auditLog } from "./financialAudit";
import { notifyOwner } from "./utils/notifications";
import { paymentMethodValidator } from "./utils/paymentMethods";
import { runWithIdempotency } from "./utils/idempotency";

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
    await notifyOwner(ctx, args.orgId, "accounting.prepaidAmortizationFailed", {
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
 * Runs prepaid amortization immediately for every ACTIVE schedule in one org,
 * instead of waiting for the 1st-of-month cron. The accountant, not a
 * background job impersonating the owner, is the actor on every posting.
 */
export const runAmortizationNow = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const now = Date.now();
    const currentYearMonth = toYearMonth(now);

    const schedules = await ctx.db
      .query("prepaidExpenseSchedules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("status"), "ACTIVE"))
      .collect();

    const results: Array<{ scheduleId: Id<"prepaidExpenseSchedules">; monthsPosted: number; stoppedReason?: string }> = [];
    for (const schedule of schedules) {
      const result = await catchUpPrepaidSchedule(ctx, schedule, {
        throughYearMonth: currentYearMonth,
        now,
        systemActorId: user._id,
      });
      results.push({ scheduleId: schedule._id, ...result });
    }

    return {
      scheduleCount: schedules.length,
      monthsPosted: results.reduce((sum, r) => sum + r.monthsPosted, 0),
      results,
    };
  },
});

// ─── Corrections: partial refund / non-refundable write-off / term change ────

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
 */
export const correctSchedule = mutation({
  args: {
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    refundMinor: v.optional(v.number()),
    refundPaymentMethod: v.optional(paymentMethodValidator),
    writeOffMinor: v.optional(v.number()),
    newTermMonths: v.optional(v.number()),
    reason: v.string(),
    // A double-click, dialog re-submit, or client retry must not create two
    // corrections (two refunds, two write-offs) for what the accountant only
    // intended once — same idempotency discipline expenses.create already
    // uses. The dialog mints one fresh key per open, so a retry within one
    // open replays safely and a second, deliberate open gets a new key.
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("A reason is required for a schedule correction.");

    const refundMinor = Math.round(args.refundMinor ?? 0);
    const writeOffMinor = Math.round(args.writeOffMinor ?? 0);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "correctPrepaidSchedule",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          scheduleId: args.scheduleId,
          refundMinor,
          writeOffMinor,
          newTermMonths: args.newTermMonths ?? null,
          reason,
        }),
      },
      async () => {
        const schedule = await ctx.db.get(args.scheduleId);
        if (!schedule || schedule.orgId !== args.orgId) {
          throw new ConvexError("Prepaid schedule not found in this organization.");
        }
        if (schedule.status !== "ACTIVE") {
          throw new ConvexError(`Cannot correct a schedule with status "${schedule.status}".`);
        }

        if (refundMinor < 0 || writeOffMinor < 0) {
          throw new ConvexError("Refund and write-off amounts cannot be negative.");
        }
        if (refundMinor > 0 && !args.refundPaymentMethod) {
          throw new ConvexError("A payment method is required to record a refund.");
        }

        const newTermMonths = args.newTermMonths ?? schedule.termMonths;
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

        const now = Date.now();
        const correctionId = await ctx.db.insert("prepaidScheduleCorrections", {
          orgId: args.orgId,
          scheduleId: args.scheduleId,
          refundMinor,
          refundPaymentMethod: refundMinor > 0 ? args.refundPaymentMethod : undefined,
          writeOffMinor,
          previousTermMonths: schedule.termMonths,
          newTermMonths,
          reason,
          actorId: user._id,
          createdAt: now,
        });

        const newTotalMinor = schedule.totalMinor - refundMinor - writeOffMinor;
        await ctx.db.patch(args.scheduleId, {
          totalMinor: newTotalMinor,
          termMonths: newTermMonths,
          status: newTotalMinor <= schedule.recognizedMinor ? "CANCELLED" : "ACTIVE",
        });

        if (refundMinor > 0) {
          await hookPrepaidExpenseRefunded(ctx, {
            orgId: args.orgId,
            scheduleId: args.scheduleId,
            correctionId,
            amountMinor: refundMinor,
            currency: schedule.currency,
            paymentMethod: args.refundPaymentMethod,
            actorId: user._id,
            occurredAt: now,
          });
        }
        if (writeOffMinor > 0) {
          await hookPrepaidExpenseWrittenOff(ctx, {
            orgId: args.orgId,
            scheduleId: args.scheduleId,
            correctionId,
            amountMinor: writeOffMinor,
            currency: schedule.currency,
            expenseSystemKey: schedule.expenseSystemKey,
            actorId: user._id,
            occurredAt: now,
          });
        }

        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "CORRECT_PREPAID_SCHEDULE",
          resourceType: "prepaidExpenseSchedules",
          resourceId: args.scheduleId.toString(),
          description: `Corrected prepaid schedule: refund ${refundMinor}, write-off ${writeOffMinor}, term ${schedule.termMonths} -> ${newTermMonths}. Reason: ${reason}`,
        });

        return correctionId;
      }
    );
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

    const pendingByScheduleId = new Map<string, number>();
    const failedByScheduleId = new Map<string, number>();
    for (const status of ["PENDING", "FAILED"] as const) {
      const target = status === "PENDING" ? pendingByScheduleId : failedByScheduleId;
      const queued = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .collect();
      for (const entry of queued) {
        // Refund/write-off corrections share sourceType + scheduleId with
        // ordinary monthly amortization but are a separate eventType — without
        // this check a pending/failed refund or write-off would be miscounted
        // into the "amortization" pending/failed totals shown to the accountant.
        if (
          entry.sourceType !== "prepaidExpenseSchedules" ||
          entry.kind !== "POST" ||
          entry.eventType !== "PREPAID_EXPENSE_AMORTIZED"
        ) {
          continue;
        }
        const scheduleId = (entry.payload as { scheduleId?: string })?.scheduleId;
        const amountMinor = (entry.payload as { amountMinor?: number })?.amountMinor ?? 0;
        if (!scheduleId) continue;
        target.set(scheduleId, (target.get(scheduleId) ?? 0) + amountMinor);
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
