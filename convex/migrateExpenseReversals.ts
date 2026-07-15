import { internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

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
 * Idempotent: skips expenses that already carry a reversedAt, so it's safe to
 * re-run. Run once per deployment after shipping the field.
 */
export const backfillExpenseReversedAt = internalMutation({
  args: {},
  handler: async (ctx) => {
    const reversals = await ctx.db
      .query("accountingEvents")
      .filter((q) =>
        q.and(
          q.eq(q.field("eventType"), "JOURNAL_REVERSAL"),
          q.eq(q.field("sourceType"), "expenses"),
          q.eq(q.field("status"), "POSTED")
        )
      )
      .collect();

    let updatedCount = 0;
    let skippedAlreadySet = 0;
    let skippedMissingExpense = 0;
    let skippedNotExpensePosting = 0;

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

    return {
      updatedCount,
      skippedAlreadySet,
      skippedMissingExpense,
      skippedNotExpensePosting,
      reversalsScanned: reversals.length,
    };
  },
});
