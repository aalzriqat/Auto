import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

/**
 * Outbox posting guard for commission events, the drain-side twin of the
 * mutation-side checks in sales.ts.
 *
 * A mutation can only refuse to post an entry that would post RIGHT NOW. When
 * an entry queues instead, nothing about the outbox keeps it behind its own
 * prerequisites: drainEntries walks the org's PENDING rows and holds each one
 * only on its OWN period, then continues. Open the period covering a queued
 * payment while the period covering its accrual stays shut, and the payment
 * posts alone — Commission Payable goes negative by the full amount and stays
 * there until someone opens a period nobody knows to look for.
 *
 * That is not hypothetical for this system: initializing a chart of accounts
 * creates no periods at all, so a dealership's first commissions routinely
 * queue, and the first period it opens is usually the current month rather than
 * the month the sale happened in.
 *
 * Two dependencies are enforced:
 *  - COMMISSION_PAID must not clear a payable before the accrual that created
 *    it, and before every correction that changed it, are on the books.
 *  - COMMISSION_ACCRUED must not recognize commission expense before the sale
 *    that earned it posts. The sale's own entry is dated at the sale date with
 *    no fallback, while a commission decided later falls back to the current
 *    period, so the commission can otherwise land in an open period while the
 *    revenue and COGS behind it wait in a closed one.
 *
 * Held (not failed) entries stay PENDING and retry once the prerequisite posts.
 */
const COMMISSION_SOURCE_DEPENDENT_EVENT_TYPES = new Set([
  "COMMISSION_PAID",
  "COMMISSION_ACCRUED",
]);

/**
 * Whether a domain event with this idempotency key is actually on the books.
 * POSTED specifically — `accountingEvents.status` also admits PENDING and
 * FAILED, and treating either as posted would defeat the entire guard.
 */
async function prereqPosted(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  const event = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();
  return event !== null;
}

/**
 * Every commission entry for a sale that must already be posted before a
 * settlement clears the payable: the accrual, plus one per correction.
 *
 * Shared with payrollSourceLedger so the two settlement paths cannot drift —
 * that drift is exactly what left payroll checking the accrual alone while
 * paying the corrected amount.
 */
export async function commissionPrereqUnpostedReason(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">,
  adjustmentSeq: number
): Promise<string | null> {
  if (!(await prereqPosted(ctx, orgId, `commission_accrued_${saleId}`))) {
    return "the commission accrual behind it has not posted to the ledger yet, so this would clear a Commission Payable that was never accrued";
  }
  for (let sequence = 1; sequence <= adjustmentSeq; sequence++) {
    if (!(await prereqPosted(ctx, orgId, `commission_adjusted_${saleId}_${sequence}`))) {
      return "a commission correction behind it has not posted to the ledger yet, so this would clear more Commission Payable than was ever accrued";
    }
  }
  return null;
}

/**
 * Resolves the sale a queued commission entry refers to, or explains why it
 * cannot be. Fails closed on every unverifiable case: skipping a check is an
 * ALLOW, and the thing being allowed is a debit against a payable that may not
 * exist.
 */
async function resolveSale(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  payload: Record<string, unknown>
): Promise<{ saleId: Id<"sales">; adjustmentSeq: number } | { reason: string }> {
  const rawSaleId = typeof payload.saleId === "string" ? payload.saleId : null;
  if (!rawSaleId) {
    return { reason: "it carries no sale reference, so the Commission Payable it touches cannot be traced to an accrual" };
  }
  const saleId = ctx.db.normalizeId("sales", rawSaleId);
  const sale = saleId ? await ctx.db.get(saleId) : null;
  if (!saleId || !sale || sale.orgId !== orgId) {
    return { reason: "its sale could not be resolved in this organization, so the commission entries behind it cannot be verified" };
  }
  return { saleId, adjustmentSeq: sale.commissionAdjustmentSeq ?? 0 };
}

export async function commissionPostingBlockedReason(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    eventType?: string;
    payload?: unknown;
  }
): Promise<string | null> {
  if (!entry.eventType || !COMMISSION_SOURCE_DEPENDENT_EVENT_TYPES.has(entry.eventType)) return null;
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const resolved = await resolveSale(ctx, entry.orgId, payload);
  if ("reason" in resolved) return resolved.reason;

  if (entry.eventType === "COMMISSION_ACCRUED") {
    // Expense before the revenue it was earned against is not a smaller
    // problem than a negative payable — it is the same period mismatch this
    // work exists to remove, pointing the other way.
    if (!(await prereqPosted(ctx, entry.orgId, `sale_completed_${resolved.saleId}`))) {
      return "the sale behind it has not posted to the ledger yet, so this would recognize commission expense before the revenue that earned it";
    }
    return null;
  }

  return commissionPrereqUnpostedReason(ctx, entry.orgId, resolved.saleId, resolved.adjustmentSeq);
}
