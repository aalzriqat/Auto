import { type MutationCtx } from "../../_generated/server";
import { type Id, type Doc } from "../../_generated/dataModel";
import { isChartInitialized } from "../chartAccountsRead";
import { ensurePrepaidExpensesAccount, ensureExpenseCategoryAccounts } from "../chartAccountsProvision";
import { postDomainEvent } from "./posting";
import { ensureVatReceivableAccountIfChartReady } from "./vatAccounts";
import { getOpenPeriodForDate } from "../../utils/postingPeriod";
import { reverseAccountingEvent } from "../reversals";
import { enqueuePendingReversal } from "../outboxIngress";

/**
 * Monthly release of one term-month of a prepaid expense from the Prepaid
 * Expenses asset into its operating-expense account. Exact same shape as
 * hookFiCommissionRecognized — idempotent per (schedule, yearMonth) — see
 * prepaidExpenses.amortizePrepaidExpenseForMonth.
 */
export async function hookPrepaidExpenseAmortized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    yearMonth: string; // "YYYY-MM", used only for the idempotency key
    amountMinor: number;
    currency: string;
    expenseSystemKey: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
    await ensureExpenseCategoryAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PREPAID_EXPENSE_AMORTIZED",
    sourceType: "prepaidExpenseSchedules",
    // Per-month sourceId (same idiom as the monthly depreciation posting): each
    // recognition is a distinct GL event on the source-identity dedup index, so
    // month 2+ can't be mistaken for a duplicate of month 1. The reversal
    // clawback below finds all of a schedule's months via payload.scheduleId.
    sourceId: `prepaid_amort_${args.scheduleId}_${args.yearMonth}`,
    idempotencyKey: `prepaid_amort_${args.scheduleId}_${args.yearMonth}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      scheduleId: args.scheduleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      expenseSystemKey: args.expenseSystemKey,
      // Explicit recognition month for the report's event-derived bucketing
      // (utils/prepaidRecognitionEvents.ts) — previously only encoded in the
      // sourceId suffix, which the report parses as a fallback for events
      // posted before this field existed.
      yearMonth: args.yearMonth,
    },
  });
}

/**
 * Posts the cash-in entry for a partial refund of a prepaid schedule's unused
 * portion — called from prepaidExpenses.correctSchedule. `correctionId` (the
 * prepaidScheduleCorrections row) makes the idempotency key unique per
 * correction, distinct from the per-month keys hookPrepaidExpenseAmortized uses.
 */
export async function hookPrepaidExpenseRefunded(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    correctionId: Id<"prepaidScheduleCorrections">;
    amountMinor: number;
    taxMinor?: number;
    currency: string;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
  }
  if (args.taxMinor && args.taxMinor > 0) {
    await ensureVatReceivableAccountIfChartReady(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PREPAID_EXPENSE_REFUNDED",
    sourceType: "prepaidExpenseSchedules",
    sourceId: `prepaid_refund_${args.correctionId}`,
    idempotencyKey: `prepaid_refund_${args.correctionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      scheduleId: args.scheduleId.toString(),
      amountMinor: args.amountMinor,
      taxMinor: args.taxMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      bankAccountId: args.bankAccountId?.toString(),
    },
  });
}

/**
 * Posts the accelerated write-off of a prepaid schedule's non-refundable
 * unused portion — same GL shape as hookPrepaidExpenseAmortized (release the
 * asset into its expense account) but as a distinct eventType and a one-off
 * per-correction idempotency key rather than a per-month one.
 */
export async function hookPrepaidExpenseWrittenOff(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    correctionId: Id<"prepaidScheduleCorrections">;
    amountMinor: number;
    currency: string;
    expenseSystemKey: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
    await ensureExpenseCategoryAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PREPAID_EXPENSE_WRITTEN_OFF",
    sourceType: "prepaidExpenseSchedules",
    sourceId: `prepaid_writeoff_${args.correctionId}`,
    idempotencyKey: `prepaid_writeoff_${args.correctionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      scheduleId: args.scheduleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      expenseSystemKey: args.expenseSystemKey,
    },
  });
}

/**
 * Reverses every prepaid GL event already posted for a schedule whose expense
 * is being reversed — every monthly amortization release AND every correction
 * (partial refund, accelerated write-off), same per-event clawback shape as
 * hookFiCommissionRecognitionsReversed. Together with reversing the original
 * EXPENSE_POSTED entry (which reverseExpense already does), this unwinds the
 * whole prepaid lifecycle to zero: the asset debit, the cash credit, every
 * asset→expense release, and any correction's cash refund or accelerated
 * write-off. Without covering the correction event types too, a schedule that
 * had a refund or write-off posted before its expense was reversed would keep
 * that correction's postings live in the GL — orphaned cash/prepaid/VAT
 * balances with no corresponding expense. Idempotent (reverseAccountingEvent
 * no-ops on an already-reversed event) and also drops any not-yet-posted
 * queued event (amortization or correction alike).
 *
 * Returns how many already-POSTED events it reversed, which is how a caller
 * tells real ledger history apart from a schedule that never reached the GL.
 * Note this is NOT implied by the source expense having posted: amortization
 * refuses to run until EXPENSE_POSTED lands (prepaidExpenses.ts's
 * "source_expense_not_posted" — it won't release an asset that was never
 * booked), but a correction won't. correctSchedule can post an accelerated
 * write-off against a schedule whose EXPENSE_POSTED is still queued behind a
 * month that has no open period, so a count > 0 with no posted EXPENSE_POSTED
 * is a reachable state, not a contradiction. A count of 0 means this schedule
 * left no footprint in the ledger.
 */
export async function hookPrepaidExpenseAmortizationsReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<number> {
  const scheduleIdStr = args.scheduleId.toString();
  const REVERSIBLE_EVENT_TYPES = [
    "PREPAID_EXPENSE_AMORTIZED",
    "PREPAID_EXPENSE_REFUNDED",
    "PREPAID_EXPENSE_WRITTEN_OFF",
  ] as const;
  // Each event type uses a per-event (per-month, or per-correction) sourceId,
  // so they're gathered by their (stable) payload.scheduleId rather than an
  // exact sourceId match.
  const postedEvents: Doc<"accountingEvents">[] = [];
  for (const eventType of REVERSIBLE_EVENT_TYPES) {
    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) => q.eq("orgId", args.orgId).eq("eventType", eventType))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .collect();
    postedEvents.push(...events.filter((e) => (e.payload as { scheduleId?: string })?.scheduleId === scheduleIdStr));
  }

  const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
  for (const event of postedEvents) {
    const reversalIdempotencyKey = `prepaid_reversed_${event._id}`;
    if (period) {
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
      });
    } else {
      await enqueuePendingReversal(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
        sourceType: "prepaidExpenseSchedules",
        sourceId: event.sourceId,
      });
    }
  }

  // Drop any not-yet-posted queued amortization months for this schedule
  // (PENDING or FAILED), so a later retry can't post a month for a reversed
  // prepayment — same reasoning as the F&I clawback.
  for (const status of ["PENDING", "FAILED"] as const) {
    const queued = (
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .collect()
    ).filter(
      (p) =>
        p.sourceType === "prepaidExpenseSchedules" &&
        (p.payload as { scheduleId?: string })?.scheduleId === scheduleIdStr
    );
    for (const entry of queued) {
      if (entry.kind === "POST") await ctx.db.delete(entry._id);
    }
  }

  return postedEvents.length;
}
