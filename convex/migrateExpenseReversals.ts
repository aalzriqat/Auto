import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/** Organizations per invocation — see the header on why the per-org read is itself small. */
const BACKFILL_ORG_BATCH_SIZE = 5;

/**
 * Backfills `expenses.reversedAt` for rows reversed before that field existed.
 *
 * expenses.reverseExpense now stamps reversedAt so the operational P&L can tell
 * a reversed expense (real GL history, must keep reporting in the month it
 * posted) from one deleted before it ever posted (no GL footprint, correctly
 * invisible). Without this backfill an already-reversed expense keeps looking
 * like the latter: its original month stays retroactively restated to zero in
 * the Expenses Report while the income statement still reports it.
 *
 * The reversal's own accountingDate is the authority — deliberately not
 * deletedAt, which is merely when the row was soft-deleted and can land in a
 * different month than the GL's reversing entry.
 *
 * Walks organizations a page at a time and self-reschedules until done (the same
 * shape as changelog.broadcastNewEntry), reading each org's reversals through
 * `by_org_eventType`. That index matters more than the pagination does: it
 * restricts reads to the org's JOURNAL_REVERSAL rows — reversals are exceptional
 * corrections, a tiny slice — instead of scanning the whole accountingEvents
 * table, which is the largest in the system and would blow the read limit on a
 * mature deployment.
 *
 * Idempotent: skips expenses that already carry a reversedAt, so it's safe to
 * re-run. Run once per deployment after shipping the field.
 */
export const backfillExpenseReversedAt = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("organizations")
      .paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_ORG_BATCH_SIZE });

    let updatedCount = 0;
    let skippedAlreadySet = 0;
    let skippedMissingExpense = 0;
    let skippedNotExpensePosting = 0;
    let reversalsScanned = 0;

    for (const org of page.page) {
      const reversals = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_eventType", (q) => q.eq("orgId", org._id).eq("eventType", "JOURNAL_REVERSAL"))
        .filter((q) => q.and(q.eq(q.field("sourceType"), "expenses"), q.eq(q.field("status"), "POSTED")))
        .collect();
      reversalsScanned += reversals.length;

      for (const reversal of reversals) {
        // VEHICLE_PREP_EXPENSE_RECLASSIFIED shares sourceType "expenses" AND the
        // same sourceId as EXPENSE_POSTED, so sourceType alone would let a
        // reclassification's reversal mark the expense itself as reversed —
        // erasing a live expense from the P&L. Only a reversal of the expense's
        // own posting counts.
        const originalEventType = (reversal.payload as { originalEventType?: string } | undefined)?.originalEventType;
        if (originalEventType !== "EXPENSE_POSTED") {
          skippedNotExpensePosting++;
          continue;
        }

        // A reversal's sourceId is its original event's sourceId — for an
        // EXPENSE_POSTED reversal that's the expense's own id.
        const expenseId = reversal.sourceId as Id<"expenses">;
        const expense = await ctx.db.get(expenseId);
        if (!expense) {
          skippedMissingExpense++;
          continue;
        }
        if (expense.reversedAt !== undefined) {
          skippedAlreadySet++;
          continue;
        }
        await ctx.db.patch(expenseId, { reversedAt: reversal.accountingDate });
        updatedCount++;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrateExpenseReversals.backfillExpenseReversedAt, {
        cursor: page.continueCursor,
      });
    }

    return {
      updatedCount,
      skippedAlreadySet,
      skippedMissingExpense,
      skippedNotExpensePosting,
      reversalsScanned,
      isDone: page.isDone,
    };
  },
});
