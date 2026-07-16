import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

/**
 * Read-only survey of prepaid schedules whose GL history is internally
 * inconsistent — corrections that credited the Prepaid Expenses asset without a
 * matching debit standing behind them, and the related shapes that leave the
 * asset misstated.
 *
 * DELIBERATELY DIAGNOSTIC ONLY. It never writes, and it must not be turned into
 * an auto-repair: every hit here has several defensible resolutions (post the
 * queued original, reverse the bad correction, reopen the period, book a
 * prior-period adjustment) and which one is right depends on facts the database
 * doesn't hold — what the vendor actually did, which periods have been filed.
 * That is an accountant-and-controller decision, so this reports and stops.
 *
 * Why it exists: the guard in prepaidExpenses.ts
 * (requireSourceExpensePostedForGlCorrection) is preventative and only sits on
 * the mutation path. It cannot see rows written before it existed. This is how
 * you find those rows before handing the books to an accountant.
 *
 * Paginated over organizations and self-rescheduling in the same shape as
 * migrateExpenseReversals, so it can be run against production without a single
 * transaction trying to scan every event.
 */

const ORG_BATCH_SIZE = 5;

/** Correction event types that post against the Prepaid Expenses asset. */
const CORRECTION_EVENT_TYPES = [
  "PREPAID_EXPENSE_REFUNDED",
  "PREPAID_EXPENSE_WRITTEN_OFF",
] as const;

type DefectKind =
  /** A correction credited Prepaid Expenses but EXPENSE_POSTED never posted. */
  | "correction_without_posted_source"
  /** A correction is dated before the debit it credits, so the asset is negative until the debit lands. */
  | "correction_dated_before_source"
  /** Recognition posted without a posted source expense (amortization's own guard bypassed). */
  | "amortization_without_posted_source"
  /** The source expense was reversed while a correction against it is still POSTED. */
  | "source_reversed_with_live_correction";

type Finding = {
  orgId: Id<"organizations">;
  orgName: string;
  scheduleId: Id<"prepaidExpenseSchedules">;
  expenseId: Id<"expenses">;
  expenseTitle: string;
  expenseDate: number;
  defect: DefectKind;
  eventId: Id<"accountingEvents">;
  eventType: string;
  eventStatus: string;
  eventAccountingDate: number;
  journalEntryId: Id<"journalEntries"> | null;
  amountMinor: number;
  currency: string;
  /** accountingDate of the source EXPENSE_POSTED, when one exists at all. */
  sourceAccountingDate: number | null;
  sourceStatus: string | null;
};

export const surveyPrepaidLedgerIntegrity = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("organizations")
      .paginate({ cursor: args.cursor ?? null, numItems: ORG_BATCH_SIZE });

    const findings: Finding[] = [];

    for (const org of page.page) {
      const schedules = await ctx.db
        .query("prepaidExpenseSchedules")
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .collect();
      if (schedules.length === 0) continue;

      // Every prepaid GL event for this org once, then matched to schedules in
      // memory — an org has few schedules but the event table is large, so this
      // is one indexed read per event type rather than per schedule.
      const eventsByScheduleId = new Map<string, Doc<"accountingEvents">[]>();
      for (const eventType of [...CORRECTION_EVENT_TYPES, "PREPAID_EXPENSE_AMORTIZED"] as const) {
        const events = await ctx.db
          .query("accountingEvents")
          .withIndex("by_org_eventType", (q) => q.eq("orgId", org._id).eq("eventType", eventType))
          .collect();
        for (const event of events) {
          const scheduleId = (event.payload as { scheduleId?: string })?.scheduleId;
          if (!scheduleId) continue;
          const list = eventsByScheduleId.get(scheduleId);
          if (list) list.push(event);
          else eventsByScheduleId.set(scheduleId, [event]);
        }
      }

      for (const schedule of schedules) {
        const events = eventsByScheduleId.get(schedule._id.toString());
        if (!events || events.length === 0) continue;

        const expense = await ctx.db.get(schedule.expenseId);
        const source = await ctx.db
          .query("accountingEvents")
          .withIndex("by_org_source", (q) =>
            q.eq("orgId", org._id).eq("sourceType", "expenses").eq("sourceId", schedule.expenseId.toString())
          )
          .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
          .first();

        const sourcePosted = source !== null && source.status === "POSTED";

        for (const event of events) {
          // Only POSTED events moved the ledger. A queued one is a separate
          // (real) risk, but it hasn't misstated anything yet.
          if (event.status !== "POSTED") continue;

          const isCorrection = (CORRECTION_EVENT_TYPES as readonly string[]).includes(event.eventType);

          let defect: DefectKind | null = null;
          if (!source || source.status === "PENDING" || source.status === "FAILED") {
            defect = isCorrection ? "correction_without_posted_source" : "amortization_without_posted_source";
          } else if (source.status === "REVERSED" && isCorrection) {
            defect = "source_reversed_with_live_correction";
          } else if (sourcePosted && source.accountingDate > event.accountingDate) {
            defect = "correction_dated_before_source";
          }
          if (!defect) continue;

          findings.push({
            orgId: org._id,
            orgName: org.name,
            scheduleId: schedule._id,
            expenseId: schedule.expenseId,
            expenseTitle: expense?.title ?? "(expense row missing)",
            expenseDate: expense?.date ?? 0,
            defect,
            eventId: event._id,
            eventType: event.eventType,
            eventStatus: event.status,
            eventAccountingDate: event.accountingDate,
            journalEntryId: event.journalEntryId ?? null,
            amountMinor: (event.payload as { amountMinor?: number })?.amountMinor ?? 0,
            currency: event.currency ?? schedule.currency,
            sourceAccountingDate: source?.accountingDate ?? null,
            sourceStatus: source?.status ?? null,
          });
        }
      }
    }

    return {
      findings,
      // Cursor semantics: isDone can only be proven by the next page coming back
      // empty, so keep paging until findings stop and page.isDone is true.
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      orgsScanned: page.page.length,
    };
  },
});
