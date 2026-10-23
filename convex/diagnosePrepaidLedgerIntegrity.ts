import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { resolvePrepaidScheduleSource } from "./utils/openingPrepaidBasis";

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
 * Paginated over organizations so no single transaction tries to scan every
 * event on a mature deployment. surveyPrepaidLedgerIntegrity is ONE page;
 * runPrepaidLedgerIntegritySurvey is the whole survey and is what you actually
 * run — a page's empty findings mean nothing on their own, and an operator who
 * runs the query once against more than ORG_BATCH_SIZE orgs gets a clean bill of
 * health for the first few and silence about the rest.
 */

const ORG_BATCH_SIZE = 5;

/** Correction event types that post against the Prepaid Expenses asset. */
const CORRECTION_EVENT_TYPES = [
  "PREPAID_EXPENSE_REFUNDED",
  "PREPAID_EXPENSE_WRITTEN_OFF",
] as const;

type DefectKind =
  | "opening_source_unavailable"
  /** A correction credited Prepaid Expenses but EXPENSE_POSTED never posted. */
  | "correction_without_posted_source"
  /** A correction is dated before the debit it credits, so the asset is negative until the debit lands. */
  | "correction_dated_before_source"
  /** Recognition posted without a posted source expense (amortization's own guard bypassed). */
  | "amortization_without_posted_source"
  /** Recognition is dated before the debit it releases — same negative asset, but reached by the cron's clock rather than a correction. */
  | "amortization_dated_before_source"
  /** The source expense was reversed while a correction against it is still POSTED. */
  | "source_reversed_with_live_correction";

type UnavailableSource = { orgId: Id<"organizations">; scheduleId: Id<"prepaidExpenseSchedules">; reason: string };

type Finding = {
  orgId: Id<"organizations">;
  orgName: string;
  scheduleId: Id<"prepaidExpenseSchedules">;
  expenseId: Id<"expenses"> | null;
  sourceKind: "EXPENSE" | "OPENING" | "UNAVAILABLE";
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
    const unavailableSources: UnavailableSource[] = [];

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
        const basis = await resolvePrepaidScheduleSource(ctx, org._id, schedule._id);
        if (basis.kind === "UNAVAILABLE") unavailableSources.push({ orgId: org._id, scheduleId: schedule._id, reason: basis.reason });
        const events = eventsByScheduleId.get(schedule._id.toString());
        if (!events || events.length === 0) continue;
        const expense = schedule.kind === "OPENING" ? null : await ctx.db.get(schedule.expenseId);
        const source = schedule.kind === "OPENING" ? null : await ctx.db
          .query("accountingEvents")
          .withIndex("by_org_source", (q) =>
            q.eq("orgId", org._id).eq("sourceType", "expenses").eq("sourceId", schedule.expenseId.toString())
          )
          .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
          .first();
        const sourceDate = basis.kind === "OPENING" ? basis.basisDate : source?.accountingDate ?? null;
        const sourcePosted = basis.kind === "OPENING" || (source !== null && source.status === "POSTED");

        for (const event of events) {
          // Only POSTED events moved the ledger. A queued one is a separate
          // (real) risk, but it hasn't misstated anything yet.
          if (event.status !== "POSTED") continue;

          const isCorrection = (CORRECTION_EVENT_TYPES as readonly string[]).includes(event.eventType);

          let defect: DefectKind | null = null;
          if (basis.kind === "UNAVAILABLE" && schedule.kind === "OPENING") {
            defect = "opening_source_unavailable";
          } else if (basis.kind !== "OPENING" && (!source || source.status === "PENDING" || source.status === "FAILED")) {
            defect = isCorrection ? "correction_without_posted_source" : "amortization_without_posted_source";
          } else if (source?.status === "REVERSED" && isCorrection) {
            defect = "source_reversed_with_live_correction";
          } else if (sourcePosted && sourceDate !== null && sourceDate > event.accountingDate) {
            // Same negative asset either way, but a correction gets there
            // because someone booked it too early and recognition because the
            // cron's clock ran ahead of the expense's own date — different
            // causes, different fixes. Reporting recognition as a "correction"
            // sends the reader hunting for a refund that was never made.
            defect = isCorrection ? "correction_dated_before_source" : "amortization_dated_before_source";
          }
          if (!defect) continue;

          findings.push({
            orgId: org._id,
            orgName: org.name,
            scheduleId: schedule._id,
            expenseId: schedule.kind === "OPENING" ? null : schedule.expenseId,
            sourceKind: basis.kind,
            expenseTitle: basis.kind === "OPENING" ? basis.title : expense?.title ?? "(source unavailable)",
            expenseDate: basis.kind === "OPENING" ? basis.basisDate : expense?.date ?? 0,
            defect,
            eventId: event._id,
            eventType: event.eventType,
            eventStatus: event.status,
            eventAccountingDate: event.accountingDate,
            journalEntryId: event.journalEntryId ?? null,
            amountMinor: (event.payload as { amountMinor?: number })?.amountMinor ?? 0,
            currency: event.currency ?? schedule.currency,
            sourceAccountingDate: sourceDate,
            sourceStatus: basis.kind === "OPENING" ? "POSTED" : source?.status ?? null,
          });
        }
      }
    }

    return {
      findings,
      unavailableSources,
      sourcesAvailable: unavailableSources.length === 0,
      // Cursor semantics: isDone can only be proven by the next page coming back
      // empty, so keep paging until findings stop and page.isDone is true.
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      orgsScanned: page.page.length,
    };
  },
});

/** Pages beyond which the run reports itself incomplete rather than looping forever. */
const MAX_SURVEY_PAGES = 500;

/**
 * The whole survey, every organization, in one call — page one to isDone.
 *
 * This exists because the honest answer to "are the books clean?" is the only
 * output anyone wants from a diagnostic, and a single page cannot give it: it
 * sees ORG_BATCH_SIZE organizations and says nothing about the rest, which reads
 * as an all-clear to whoever ran it. `complete` is the load-bearing field —
 * findings are only exhaustive when it is true, and a run that exhausts its page
 * budget says so and hands back a cursor instead of quietly reporting clean.
 *
 * An action, not a self-rescheduling mutation: the survey never writes, so
 * nothing needs to survive a transaction, and paging from an action returns one
 * assembled report to whoever ran it rather than scattering pages across
 * scheduled runs with no assembly point.
 */
export const runPrepaidLedgerIntegritySurvey = internalAction({
  args: {
    cursor: v.optional(v.string()),
    maxPages: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const maxPages = args.maxPages ?? MAX_SURVEY_PAGES;
    const findings: Finding[] = [];
    const unavailableSources: UnavailableSource[] = [];
    let cursor: string | undefined = args.cursor;
    let orgsScanned = 0;
    let pagesScanned = 0;

    while (pagesScanned < maxPages) {
      const page: {
        findings: Finding[];
        unavailableSources: UnavailableSource[];
        isDone: boolean;
        continueCursor: string;
        orgsScanned: number;
      } = await ctx.runQuery(internal.diagnosePrepaidLedgerIntegrity.surveyPrepaidLedgerIntegrity, { cursor });
      findings.push(...page.findings);
      unavailableSources.push(...page.unavailableSources);
      orgsScanned += page.orgsScanned;
      pagesScanned++;
      cursor = page.continueCursor;
      if (page.isDone) {
        return { complete: unavailableSources.length === 0, surveyComplete: true, sourcesAvailable: unavailableSources.length === 0, unavailableSources, findings, orgsScanned, pagesScanned, resumeCursor: null };
      }
    }

    return { complete: false, surveyComplete: false, sourcesAvailable: unavailableSources.length === 0, unavailableSources, findings, orgsScanned, pagesScanned, resumeCursor: cursor ?? null };
  },
});
