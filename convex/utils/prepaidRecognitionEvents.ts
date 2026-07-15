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

/** scheduleId -> "YYYY-MM" -> minor units recognized (posted + still-queued) that month. */
export type OrgPrepaidRecognitionByMonth = Map<string, Map<string, number>>;

function addTo(map: OrgPrepaidRecognitionByMonth, scheduleId: string, yearMonth: string, amountMinor: number): void {
  if (!scheduleId || amountMinor === 0) return;
  let bySchedule = map.get(scheduleId);
  if (!bySchedule) {
    bySchedule = new Map();
    map.set(scheduleId, bySchedule);
  }
  bySchedule.set(yearMonth, (bySchedule.get(yearMonth) ?? 0) + amountMinor);
}

/** Records one event/pending-post row into the org-wide map, a no-op when the payload carries no scheduleId. */
function recordRecognitionRow(
  byScheduleMonth: OrgPrepaidRecognitionByMonth,
  payload: RecognitionPayload | undefined,
  sourceId: string,
  accountingDate: number
): void {
  if (!payload?.scheduleId) return;
  addTo(byScheduleMonth, payload.scheduleId, monthForRecognitionRow(payload, sourceId, accountingDate), payload.amountMinor ?? 0);
}

async function loadPostedRecognitionEvents(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  byScheduleMonth: OrgPrepaidRecognitionByMonth
): Promise<void> {
  for (const eventType of RECOGNITION_EVENT_TYPES) {
    const posted = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) => q.eq("orgId", orgId).eq("eventType", eventType))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .collect();
    for (const event of posted) {
      recordRecognitionRow(byScheduleMonth, event.payload as RecognitionPayload | undefined, event.sourceId, event.accountingDate);
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
      recordRecognitionRow(byScheduleMonth, entry.payload as RecognitionPayload | undefined, entry.sourceId, entry.accountingDate);
    }
  }
}

/**
 * One org-wide pass over posted + parked prepaid recognition events — same
 * cost shape (indexed event queries + outbox status queries) as
 * prepaidExpenses.listSchedules' existing aggregation.
 */
export async function loadOrgPrepaidRecognitionByMonth(
  ctx: QueryCtx,
  orgId: Id<"organizations">
): Promise<OrgPrepaidRecognitionByMonth> {
  const byScheduleMonth: OrgPrepaidRecognitionByMonth = new Map();
  await loadPostedRecognitionEvents(ctx, orgId, byScheduleMonth);
  await loadQueuedRecognitionEvents(ctx, orgId, byScheduleMonth);
  return byScheduleMonth;
}

/**
 * Sum of a schedule's recognized amount (in the schedule's own currency,
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
  currency: string
): number {
  const byMonth = events.get(scheduleId.toString());
  if (!byMonth) return 0;
  const startIdx = yearMonthIndex(startDate);
  const endIdx = yearMonthIndex(endDate);
  let totalMinor = 0;
  for (const [ym, minor] of byMonth) {
    const idx = yearMonthStringIndex(ym);
    if (idx >= startIdx && idx <= endIdx) totalMinor += minor;
  }
  if (totalMinor <= 0) return 0;
  return fromMinorUnits(totalMinor, currency);
}
