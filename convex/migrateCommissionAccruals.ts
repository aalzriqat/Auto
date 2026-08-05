import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { commissionAccountingDate, getOrgCurrency, hookCommissionAccrued, isEventQueued } from "./accounting/workflowHooks";
import { isCommissionOwed } from "./utils/commission";
import { toMinorUnits } from "./utils/money";

/** Organizations per invocation — each org's read is one indexed sales scan. */
const BACKFILL_ORG_BATCH_SIZE = 5;

/**
 * Accrues the commission backlog left behind by the switch to earned-time
 * recognition.
 *
 * MANUAL commission mode used to defer its GL accrual to PAYMENT. Recognition
 * now happens as soon as the amount is measurable on a completed sale — but
 * only going forward: the new accrual fires when a sale completes or when an
 * amount is set, and for an already-completed sale carrying an already-decided
 * amount both of those moments are in the past. Without this, that backlog
 * keeps recognizing on the old cash timing, and the Commission Payable the
 * dealership actually owes stays understated until each one is paid.
 *
 * Accrues every non-deleted, COMPLETED, unpaid sale with a positive commission
 * that has no commission accrual on the books. AUTO-mode sales are included by
 * the same rule rather than by mode: an AUTO sale that completed before its
 * accrual existed, or one whose accrual was skipped for a missing cost basis
 * and later filled in by hand, is the same backlog and needs the same fix.
 *
 * Dated by the shared commissionAccountingDate rule, so a sale whose own period
 * has closed is recognized in the current one as a prior-period item rather
 * than queued behind a closed month forever. Expect prior-period movement in
 * Commission Expense and Commission Payable for any org with a backlog — that
 * is the correction, not a side effect.
 *
 * Idempotent twice over: it skips any sale that already has a posted or queued
 * accrual, and `hookCommissionAccrued` dedupes on `commission_accrued_<saleId>`
 * anyway. Safe to re-run, and safe to run while payroll runs are in flight —
 * approveRun's own accrual call collapses onto the same key.
 */
export const backfillCommissionAccruals = internalMutation({
  args: { cursor: v.optional(v.string()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("organizations")
      .paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_ORG_BATCH_SIZE });

    let accruedCount = 0;
    let accruedMinor = 0;
    let skippedAlreadyRecognized = 0;
    let salesScanned = 0;
    const now = Date.now();

    for (const org of page.page) {
      const sales = await ctx.db
        .query("sales")
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .filter((q) => q.eq(q.field("status"), "COMPLETED"))
        .collect();
      salesScanned += sales.length;

      // The same shared predicate the commissions page, the payroll sweep and
      // the reconciliation use, so the backlog this accrues is exactly the
      // population they call outstanding — no third opinion about what is owed.
      const owed = sales.filter(isCommissionOwed);
      if (owed.length === 0) continue;

      const currency = await getOrgCurrency(ctx, org._id);

      for (const sale of owed) {
        const posted = await ctx.db
          .query("accountingEvents")
          .withIndex("by_org_source", (q) =>
            q.eq("orgId", org._id).eq("sourceType", "sales").eq("sourceId", `commission_${sale._id}`)
          )
          .filter((q) =>
            q.and(
              q.eq(q.field("eventType"), "COMMISSION_ACCRUED"),
              q.neq(q.field("status"), "REVERSED")
            )
          )
          .first();
        if (posted || (await isEventQueued(ctx, org._id, `commission_accrued_${sale._id}`))) {
          skippedAlreadyRecognized++;
          continue;
        }

        const amountMinor = toMinorUnits(sale.commissionAmount, currency);
        accruedCount++;
        accruedMinor += amountMinor;
        if (args.dryRun) continue;

        await hookCommissionAccrued(ctx, {
          orgId: org._id,
          saleId: sale._id,
          salespersonId: sale.salespersonId,
          amountMinor,
          currency,
          // The sale's own creator is not necessarily still a member, and this
          // is a system correction rather than anyone's decision, so it is
          // attributed to the salesperson the commission belongs to — the only
          // user this row is guaranteed to reference.
          actorId: sale.salespersonId,
          occurredAt: await commissionAccountingDate(ctx, org._id, sale.saleDate, now),
        });
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrateCommissionAccruals.backfillCommissionAccruals, {
        cursor: page.continueCursor,
        dryRun: args.dryRun,
      });
    }

    return {
      salesScanned,
      accruedCount,
      accruedMinor,
      skippedAlreadyRecognized,
      isDone: page.isDone,
      dryRun: args.dryRun ?? false,
    };
  },
});
