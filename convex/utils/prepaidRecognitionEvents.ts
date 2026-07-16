/**
 * Per-(schedule, month) recognition figures derived from the GL event stream
 * (PREPAID_EXPENSE_AMORTIZED + PREPAID_EXPENSE_WRITTEN_OFF), loaded org-wide
 * in one pass — see the header of ./expenseAmortization.ts for why
 * reports.ts reads these instead of recomputing a curve from the schedule's
 * current totalMinor/termMonths. A correction's write-off therefore appears
 * as expense in the month it was posted (accelerated recognition, correctly
 * reflected), and never retroactively restates a month that already posted.
 *
 * Includes both POSTED events and still-PENDING/FAILED outbox entries for the
 * same two event types: recognition "operationally happens" the moment the
 * schedule's recognizedMinor is bumped (amortizeScheduleForMonth /
 * correctSchedule), even when the GL posting itself is queued behind a closed
 * period — the operational P&L must count it in its own month, or it would
 * diverge from the authoritative schedule exactly when a period closes late.
 *
 * REVERSED originals are included alongside POSTED ones, and each reversal is
 * booked as a NEGATIVE in the month the reversal itself is dated — the same
 * treatment (and for the same reason) as accountingReports.ts's journal-entry
 * loader. A reversal is a new, independently-dated event, never an eraser: the
 * original month's expense really did post and must keep reporting. Dropping
 * the REVERSED original instead would retroactively restate an already-posted
 * (possibly already-closed) month to zero and silently disagree with the
 * ledger-backed income statement for that month.
 */
import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { yearMonthIndex, yearMonthFromIndex, yearMonthStringIndex } from "./expenseAmortization";
import { fromMinorUnits } from "./money";

const RECOGNITION_EVENT_TYPES = ["PREPAID_EXPENSE_AMORTIZED", "PREPAID_EXPENSE_WRITTEN_OFF"] as const;

interface RecognitionPayload {
  scheduleId?: string;
  amountMinor?: number;
  yearMonth?: string;
}

/**
 * The recognition month for one event/pending-post: the explicit payload
 * field when present, else amortization's own sourceId idiom
 * (`prepaid_amort_<scheduleId>_<YYYY-MM>` — covers events posted before the
 * payload carried yearMonth directly), else the posting's own accountingDate
 * month (write-offs have no per-month sourceId — their recognition month IS
 * the correction month).
 */
function monthForRecognitionRow(
  payload: RecognitionPayload | undefined,
  sourceId: string,
  accountingDate: number
): string {
  if (payload?.yearMonth) return payload.yearMonth;
  const match = /_(\d{4}-\d{2})$/.exec(sourceId);
  if (match) return match[1];
  return yearMonthFromIndex(yearMonthIndex(accountingDate));
}

/**
 * Where a month's recognition actually stands with the ledger. The operational
 * total is all three added together — that is what the schedule says happened —
 * but the three are kept apart so a report can show which of it the GL has
 * really taken, rather than presenting queued and posted work as one figure and
 * silently disagreeing with the income statement.
 */
export type RecognitionState = "posted" | "pending" | "failed";

export type RecognitionBuckets = { posted: number; pending: number; failed: number };

/** scheduleId -> "YYYY-MM" -> minor units recognized that month, split by posting state. */
export type OrgPrepaidRecognitionByMonth = Map<string, Map<string, RecognitionBuckets>>;

/** The posting state of one outbox row. FAILED is dead-lettered or erroring; anything still queued is pending. */
function stateForQueuedEntry(status: string): RecognitionState {
  return status === "FAILED" ? "failed" : "pending";
}

function addTo(
  map: OrgPrepaidRecognitionByMonth,
  scheduleId: string,
  yearMonth: string,
  amountMinor: number,
  state: RecognitionState
): void {
  if (!scheduleId || amountMinor === 0) return;
  let bySchedule = map.get(scheduleId);
  if (!bySchedule) {
    bySchedule = new Map();
    map.set(scheduleId, bySchedule);
  }
  const buckets = bySchedule.get(yearMonth) ?? { posted: 0, pending: 0, failed: 0 };
  buckets[state] += amountMinor;
  bySchedule.set(yearMonth, buckets);
}

/** Records one event/pending-post row into the org-wide map, a no-op when the payload carries no scheduleId. */
function recordRecognitionRow(
  byScheduleMonth: OrgPrepaidRecognitionByMonth,
  payload: RecognitionPayload | undefined,
  sourceId: string,
  accountingDate: number,
  state: RecognitionState
): void {
  if (!payload?.scheduleId) return;
  addTo(byScheduleMonth, payload.scheduleId, monthForRecognitionRow(payload, sourceId, accountingDate), payload.amountMinor ?? 0, state);
}

/**
 * Posted (and since-REVERSED) recognition events, recorded into the month they
 * originally posted into. Also indexes each one by its own id so
 * loadRecognitionReversals can resolve a reversal back to the schedule and
 * amount it cancels — a JOURNAL_REVERSAL's own payload carries neither.
 */
async function loadPostedRecognitionEvents(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  byScheduleMonth: OrgPrepaidRecognitionByMonth
): Promise<void> {
  for (const eventType of RECOGNITION_EVENT_TYPES) {
    const posted = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) => q.eq("orgId", orgId).eq("eventType", eventType))
      .filter((q) => q.or(q.eq(q.field("status"), "POSTED"), q.eq(q.field("status"), "REVERSED")))
      .collect();
    for (const event of posted) {
      recordRecognitionRow(byScheduleMonth, event.payload as RecognitionPayload | undefined, event.sourceId, event.accountingDate, "posted");
    }
  }
}

/**
 * Books each reversal of a recognition event as a negative in the month the
 * REVERSAL is dated — deliberately never via monthForRecognitionRow, whose
 * payload.yearMonth / sourceId idiom both belong to the *original* event and
 * would fold the credit straight back into the month being reversed, cancelling
 * it to zero and reintroducing the retroactive restatement this exists to stop.
 *
 * Covers posted JOURNAL_REVERSALs and still-queued REVERSE outbox entries, for
 * symmetry with the queued-POST handling above (a reversal parked behind a
 * closed period has still operationally happened). The two can't double-count:
 * a queued reversal that posts flips to status POSTED and drops out of the
 * PENDING/FAILED scan as its JOURNAL_REVERSAL appears.
 *
 * Scanned over [windowStart, windowEnd] rather than org-wide: a reversal only
 * affects a report that contains the reversal's own month, so anything outside
 * the window would contribute nothing. Each original is then resolved by id
 * (O(1)) instead of holding the org's whole recognition history in memory —
 * the original is usually outside the window and unreachable by a dated scan.
 */
async function loadRecognitionReversals(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  byScheduleMonth: OrgPrepaidRecognitionByMonth,
  windowStart: number,
  windowEnd: number
): Promise<void> {
  const recordReversal = async (
    originalEventId: Id<"accountingEvents"> | undefined,
    reversalDate: number,
    state: RecognitionState
  ): Promise<void> => {
    if (!originalEventId) return;
    const original = await ctx.db.get(originalEventId);
    // Only reversals of prepaid recognition move the P&L's recognized figure;
    // an EXPENSE_POSTED or refund reversal moves Prepaid/Cash/VAT instead.
    if (!original || !(RECOGNITION_EVENT_TYPES as readonly string[]).includes(original.eventType)) return;
    const payload = original.payload as RecognitionPayload | undefined;
    if (!payload?.scheduleId) return;
    addTo(byScheduleMonth, payload.scheduleId, yearMonthFromIndex(yearMonthIndex(reversalDate)), -(payload.amountMinor ?? 0), state);
  };

  const postedReversals = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_eventType_date", (q) =>
      q.eq("orgId", orgId).eq("eventType", "JOURNAL_REVERSAL").gte("accountingDate", windowStart).lte("accountingDate", windowEnd)
    )
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .collect();
  for (const reversal of postedReversals) {
    await recordReversal(reversal.reversalOfEventId, reversal.accountingDate, "posted");
  }

  for (const status of ["PENDING", "FAILED"] as const) {
    const queued = await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
      .collect();
    for (const entry of queued) {
      if (entry.kind !== "REVERSE") continue;
      if (entry.accountingDate < windowStart || entry.accountingDate > windowEnd) continue;
      // A queued reversal's credit is itself unposted, so it lands in the same
      // bucket as any other queued work: the GL still shows the original in
      // full, and the operational view nets it away. Filing the credit under
      // `posted` would make the posted column claim a reversal the ledger
      // hasn't taken.
      await recordReversal(entry.originalEventId, entry.accountingDate, stateForQueuedEntry(status));
    }
  }
}

/** Refund/write-off corrections share sourceType with amortization but are their own eventTypes — this scopes the pending/failed outbox scan to just the two recognition event types. */
function isQueuedRecognitionEntry(entry: Doc<"pendingAccountingEvents">): boolean {
  if (entry.sourceType !== "prepaidExpenseSchedules" || entry.kind !== "POST") return false;
  return !!entry.eventType && (RECOGNITION_EVENT_TYPES as readonly string[]).includes(entry.eventType);
}

async function loadQueuedRecognitionEvents(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  byScheduleMonth: OrgPrepaidRecognitionByMonth
): Promise<void> {
  for (const status of ["PENDING", "FAILED"] as const) {
    const queued = await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
      .collect();
    for (const entry of queued) {
      if (!isQueuedRecognitionEntry(entry)) continue;
      recordRecognitionRow(
        byScheduleMonth,
        entry.payload as RecognitionPayload | undefined,
        entry.sourceId,
        entry.accountingDate,
        stateForQueuedEntry(status)
      );
    }
  }
}

/**
 * One org-wide pass over posted + parked prepaid recognition events — same
 * cost shape (indexed event queries + outbox status queries) as
 * prepaidExpenses.listSchedules' existing aggregation.
 *
 * `windowStart`/`windowEnd` bound the reversal scan to the window being
 * reported (see loadRecognitionReversals). They deliberately do NOT bound the
 * recognition scan: an event's recognition month comes from its payload/sourceId
 * rather than its accountingDate, so a dated scan could silently drop a month
 * whose posting date and recognition month disagree. recognizedAmountInRangeFromEvents
 * filters by month anyway, so loading extra costs reads, never correctness.
 */
export async function loadOrgPrepaidRecognitionByMonth(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  windowStart: number,
  windowEnd: number
): Promise<OrgPrepaidRecognitionByMonth> {
  const byScheduleMonth: OrgPrepaidRecognitionByMonth = new Map();
  await loadPostedRecognitionEvents(ctx, orgId, byScheduleMonth);
  await loadQueuedRecognitionEvents(ctx, orgId, byScheduleMonth);
  await loadRecognitionReversals(ctx, orgId, byScheduleMonth, windowStart, windowEnd);
  return byScheduleMonth;
}

/**
 * Net of a schedule's recognized amount (in the schedule's own currency,
 * major units) whose month falls in [startDate, endDate] (month granularity —
 * a month "is in range" the same way recognizedThroughMonthsMinor-based math
 * always has: any month whose index falls between the two dates' own month
 * indexes, inclusive). Mirrors the signature of the curve-based helper this
 * replaces (recognizedAmountInRangeFromSchedule) so reports.ts's call sites
 * stay simple.
 */
export function recognizedAmountInRangeFromEvents(
  events: OrgPrepaidRecognitionByMonth,
  scheduleId: Id<"prepaidExpenseSchedules">,
  startDate: number,
  endDate: number,
  currency: string,
  /** Restrict to one posting state. Omitted = the operational figure: all three. */
  state?: RecognitionState
): number {
  const byMonth = events.get(scheduleId.toString());
  if (!byMonth) return 0;
  const startIdx = yearMonthIndex(startDate);
  const endIdx = yearMonthIndex(endDate);
  let totalMinor = 0;
  for (const [ym, buckets] of byMonth) {
    const idx = yearMonthStringIndex(ym);
    if (idx < startIdx || idx > endIdx) continue;
    totalMinor += state ? buckets[state] : buckets.posted + buckets.pending + buckets.failed;
  }
  // Deliberately not clamped at zero: a window containing a reversal but not
  // the month it reversed nets negative, exactly as the ledger shows it.
  if (totalMinor === 0) return 0;
  return fromMinorUnits(totalMinor, currency);
}
