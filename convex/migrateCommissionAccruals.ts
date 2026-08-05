import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { commissionAccountingDate, getOrgCurrency, hookCommissionAccrued, isEventQueued } from "./accounting/workflowHooks";
import { isCommissionOwed } from "./utils/commission";
import { isSystemOwnerRole } from "./utils/permissions";
import { toMinorUnits } from "./utils/money";

/**
 * Sales read per invocation. Bounded deliberately: `sales` has no status index,
 * so the population has to be filtered after the read, and each owed sale costs
 * two further indexed lookups plus a posting. One org at a time, one page at a
 * time, so a dealership with a long history cannot blow the per-mutation read
 * limit — the same hazard migrateExpenseReversals documents.
 */
const SALES_PAGE_SIZE = 100;

/** Postings per invocation, so a page dense with owed sales still stays bounded. */
const MAX_ACCRUALS_PER_INVOCATION = 25;

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
 * RUN THIS ONCE PER DEPLOYMENT, right after deploying. Until it runs, the close
 * checklist reports the backlog as "not recognized in the ledger at all".
 *
 *   npx convex run migrateCommissionAccruals:backfillCommissionAccruals '{"dryRun":true}'
 *   npx convex run migrateCommissionAccruals:backfillCommissionAccruals '{}'
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
 *
 * Progress is logged per page rather than only returned: the self-reschedule
 * makes every page after the first invisible to the caller.
 */
export const backfillCommissionAccruals = internalMutation({
  args: {
    orgCursor: v.optional(v.string()),
    saleCursor: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // One org per invocation. Batching organizations multiplied an already
    // unbounded per-org read by five.
    const orgPage = await ctx.db
      .query("organizations")
      .paginate({ cursor: args.orgCursor ?? null, numItems: 1 });
    const org = orgPage.page[0];

    if (!org) {
      console.log("[commission-backfill] complete: no further organizations");
      return { done: true as const, salesScanned: 0, accruedCount: 0, accruedMinor: 0, skippedAlreadyRecognized: 0, skippedNoOwner: 0 };
    }

    const salePage = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .paginate({ cursor: args.saleCursor ?? null, numItems: SALES_PAGE_SIZE });

    // The same shared predicate the commissions page, the payroll sweep and the
    // reconciliation use, so the backlog this accrues is exactly the population
    // they call outstanding — no third opinion about what is owed.
    const owed = salePage.page.filter(isCommissionOwed);

    let accruedCount = 0;
    let accruedMinor = 0;
    let skippedAlreadyRecognized = 0;
    let skippedNoOwner = 0;
    let capped = false;
    const now = Date.now();

    if (owed.length > 0) {
      const actorId = await resolveOrgOwnerUserId(ctx, org._id);
      if (!actorId) {
        // Fail closed, exactly as the depreciation and deferral crons do when no
        // owner resolves. The alternative — attributing the posting to whoever
        // happens to be on the row — writes a false human actor into
        // accountingEvents.createdBy, journalEntries.postedBy and the immutable
        // POST_EVENT audit log, and the one person who must never appear as the
        // author of a commission posting is its beneficiary.
        skippedNoOwner = owed.length;
        console.warn(
          `[commission-backfill] org ${org._id}: ${owed.length} owed commission(s) skipped — no OWNER-role member to attribute the posting to`
        );
      } else {
        const currency = await getOrgCurrency(ctx, org._id);
        for (const sale of owed) {
          // A dry run writes nothing, so it has no posting cost to bound — and
          // capping it would strand the walk at a page it can never make
          // progress past, because there is nothing committed to skip next time.
          if (!args.dryRun && accruedCount >= MAX_ACCRUALS_PER_INVOCATION) {
            capped = true;
            break;
          }
          if (await hasCommissionRecognition(ctx, org._id, sale._id)) {
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
            actorId,
            occurredAt: await commissionAccountingDate(ctx, org._id, sale.saleDate, now),
          });
        }
      }
    }

    console.log(
      `[commission-backfill] org ${org._id}: scanned ${salePage.page.length}, owed ${owed.length}, accrued ${accruedCount}, skipped ${skippedAlreadyRecognized}, noOwner ${skippedNoOwner}${args.dryRun ? " (dry run)" : ""}`
    );

    // Advance within the org until its sales are exhausted, then move on to the
    // next org. A capped page is re-entered at the SAME sale cursor: the
    // accruals already written are committed, so the next pass skips them as
    // already-recognized and works through the remainder. That makes forward
    // progress guaranteed — each pass either accrues something or advances.
    const done = !capped && salePage.isDone && orgPage.isDone;
    const nextArgs = capped
      ? { orgCursor: args.orgCursor, saleCursor: args.saleCursor, dryRun: args.dryRun }
      : salePage.isDone
        ? { orgCursor: orgPage.continueCursor, saleCursor: undefined, dryRun: args.dryRun }
        : { orgCursor: args.orgCursor, saleCursor: salePage.continueCursor, dryRun: args.dryRun };

    if (!done) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrateCommissionAccruals.backfillCommissionAccruals,
        nextArgs
      );
    }

    return {
      done,
      salesScanned: salePage.page.length,
      accruedCount,
      accruedMinor,
      skippedAlreadyRecognized,
      skippedNoOwner,
    };
  },
});

/** A posted (non-reversed) or still-queued accrual — either means recognition exists. */
async function hasCommissionRecognition(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<boolean> {
  const posted = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "sales").eq("sourceId", `commission_${saleId}`)
    )
    .filter((q) =>
      q.and(q.eq(q.field("eventType"), "COMMISSION_ACCRUED"), q.neq(q.field("status"), "REVERSED"))
    )
    .first();
  if (posted) return true;
  return await isEventQueued(ctx, orgId, `commission_accrued_${saleId}`);
}

/**
 * The org's OWNER-role member — the actor a system-initiated posting is
 * attributed to throughout this codebase (see crons.ts's depreciation and
 * deferral jobs, which skip the posting outright when none resolves).
 */
async function resolveOrgOwnerUserId(
  ctx: MutationCtx,
  orgId: Id<"organizations">
): Promise<Id<"users"> | null> {
  const roles = await ctx.db
    .query("roles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const ownerRoleIds = new Set(
    roles.filter((r: Doc<"roles">) => isSystemOwnerRole(r)).map((r) => r._id.toString())
  );
  if (ownerRoleIds.size === 0) return null;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const owner = memberships.find(
    (m) => ownerRoleIds.has(m.roleId.toString()) && !m.offboardingStatus
  );
  return owner?.userId ?? null;
}
