import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

/**
 * Whether a prepaid schedule's own asset actually exists in the ledger yet, and
 * from when. Shared by the mutation-side correction guard (prepaidExpenses.ts)
 * and the posting-side guard (accountingOutbox.ts) so the two cannot drift into
 * disagreeing about what "the source expense posted" means.
 */

/**
 * The schedule's source expense as it actually stands in the ledger: the
 * EXPENSE_POSTED event that debits Prepaid Expenses, only once it has really
 * POSTED. A schedule is created ACTIVE the moment its expense is marked paid,
 * but that debit may still be sitting in the outbox — postability is judged per
 * event date, so an expense dated in a month that never opens stays queued
 * indefinitely. Null therefore means "the prepaid asset does not exist in the
 * GL yet", and nothing may credit it.
 */
export async function postedSourceExpenseEvent(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  expenseId: Id<"expenses">
) {
  return await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();
}

/** Prepaid events that move value OUT of the Prepaid Expenses asset. */
const PREPAID_CORRECTION_EVENT_TYPES = new Set([
  "PREPAID_EXPENSE_REFUNDED",
  "PREPAID_EXPENSE_WRITTEN_OFF",
]);

const PREPAID_SOURCE_DEPENDENT_EVENT_TYPES = new Set([
  "PREPAID_EXPENSE_AMORTIZED",
  ...PREPAID_CORRECTION_EVENT_TYPES,
]);

/**
 * Why this queued prepaid entry must not post yet, or null if it may.
 *
 * The mutation-side guard can only vet what it is asked to do now; it cannot
 * see an entry that was queued before the guard existed and is still waiting in
 * the outbox. Those entries post through the drain — whose trigger is "a period
 * covering THIS entry's date opened", which says nothing about whether the
 * source expense's own (possibly much earlier, possibly never-opening) month is
 * postable. So a legacy write-off drains and credits an asset whose debit is
 * still queued, recreating the exact negative balance the mutation guard exists
 * to prevent, with no operator action. This is that guard re-asked at the
 * moment of posting, which is the only place that can answer it truthfully.
 *
 * Ordering is checked for corrections only. Recognition is month-bucketed and
 * dated at min(end-of-month, now) (expenseAmortization.ts), so a legitimate
 * month can fall a few days before an expense dated later within that same
 * start month; refusing it would stall real amortization for no benefit, and
 * amortizeScheduleForMonth has always had its own posted-source check anyway.
 */
export async function prepaidPostingBlockedReason(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    // Optional on pendingAccountingEvents — a REVERSE entry carries none, and
    // those are exempt from this guard anyway.
    eventType?: string;
    accountingDate?: number;
    payload?: unknown;
  }
): Promise<string | null> {
  if (!entry.eventType || entry.accountingDate === undefined) return null;
  if (!PREPAID_SOURCE_DEPENDENT_EVENT_TYPES.has(entry.eventType)) return null;

  const rawScheduleId = (entry.payload as { scheduleId?: string })?.scheduleId;
  if (!rawScheduleId) return null;
  const scheduleId = ctx.db.normalizeId("prepaidExpenseSchedules", rawScheduleId);
  if (!scheduleId) return null;
  const schedule = await ctx.db.get(scheduleId);
  if (!schedule || schedule.orgId !== entry.orgId) return null;

  const posted = await postedSourceExpenseEvent(ctx, entry.orgId, schedule.expenseId);
  if (!posted) {
    return "the prepaid expense behind it has not posted to the ledger yet, so this would credit a Prepaid Expenses balance that was never debited";
  }
  if (PREPAID_CORRECTION_EVENT_TYPES.has(entry.eventType) && posted.accountingDate > entry.accountingDate) {
    return "the prepaid expense behind it is recognized on a later date, so this would credit a Prepaid Expenses balance that does not exist yet on this entry's date";
  }
  return null;
}
