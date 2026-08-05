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
  "COMMISSION_ADJUSTED",
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

/**
 * Whether the sale's own SALE_COMPLETED entry still owes the ledger.
 *
 * "Not posted" is not the same as "outstanding". Sales completed before the
 * accounting hooks existed, and sales brought over by the accounting cutover
 * (which posts under `migrate_<txId>`, not `sale_completed_<saleId>`), have no
 * such event and never will. Blocking on those would hold their commission
 * accrual forever: a held entry never increments `attempts`, so it never
 * dead-letters into the FAILED list that `retryFailed` can act on, and nothing
 * in the product can post or delete it. It would sit as a permanent unposted
 * blocker on every period close.
 *
 * So this blocks only when the sale's entry demonstrably still owes something —
 * it is sitting in the outbox — and treats "no trace of it at all" as a legacy
 * sale the dependency does not apply to.
 */
async function salePostingOutstanding(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<boolean> {
  if (await prereqPosted(ctx, orgId, `sale_completed_${saleId}`)) return false;
  const queued = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", `sale_completed_${saleId}`)
    )
    .filter((q) => q.neq(q.field("status"), "POSTED"))
    .first();
  return queued !== null;
}

/** The sequence a queued correction carries, read from its own key. */
function adjustmentSequenceOf(idempotencyKey: string): number | null {
  const match = /^commission_adjusted_.+_(\d+)$/.exec(idempotencyKey);
  return match ? Number(match[1]) : null;
}

export async function commissionPostingBlockedReason(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    eventType?: string;
    idempotencyKey?: string;
    payload?: unknown;
  }
): Promise<string | null> {
  if (!entry.eventType || !COMMISSION_SOURCE_DEPENDENT_EVENT_TYPES.has(entry.eventType)) return null;
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const resolved = await resolveSale(ctx, entry.orgId, payload);
  if ("reason" in resolved) return resolved.reason;

  // Expense before the revenue it was earned against is not a smaller problem
  // than a negative payable — it is the same period mismatch this work exists
  // to remove, pointing the other way. Every commission entry waits on it.
  if (await salePostingOutstanding(ctx, entry.orgId, resolved.saleId)) {
    return "the sale behind it has not posted to the ledger yet, so this would recognize commission before the revenue that earned it";
  }

  if (entry.eventType === "COMMISSION_ACCRUED") return null;

  if (entry.eventType === "COMMISSION_ADJUSTED") {
    // Prerequisites read from THIS entry's own sequence, never from the sale's
    // current commissionAdjustmentSeq: that counter has already advanced past
    // this correction, so checking against it would make the entry wait for
    // itself — and for corrections raised after it — and hold forever.
    const sequence = entry.idempotencyKey ? adjustmentSequenceOf(entry.idempotencyKey) : null;
    if (sequence === null) {
      return "its correction sequence could not be read, so the corrections it must follow cannot be verified";
    }
    return commissionPrereqUnpostedReason(ctx, entry.orgId, resolved.saleId, sequence - 1);
  }

  // COMMISSION_PAID: everything that built the payable must be posted, and the
  // amount being paid must equal what those entries actually recognized.
  const unposted = await commissionPrereqUnpostedReason(
    ctx,
    entry.orgId,
    resolved.saleId,
    resolved.adjustmentSeq
  );
  if (unposted) return unposted;

  // The mutation-side recognition check is skipped whenever the payment would
  // queue, so without this a payment frozen at a divergent amount replays
  // unchecked: an accrual of 25,000 and a raw sale edit to 90,000 settles 90,000
  // against a 25,000 credit. Compared against the payload as queued, which is
  // what will actually post.
  const paying = typeof payload.amountMinor === "number" ? payload.amountMinor : null;
  if (paying === null) {
    return "it carries no amount, so what it clears cannot be checked against what was recognized";
  }
  const recognized = await recognizedCommissionForSale(
    ctx,
    entry.orgId,
    resolved.saleId,
    resolved.adjustmentSeq
  );
  if (paying !== recognized) {
    return "the amount it clears does not match what the ledger recognized for this commission, so it would leave Commission Payable wrong";
  }
  return null;
}

/**
 * What the ledger has recognized for one sale's commission — posted accrual
 * plus posted corrections. Kept here rather than imported from workflowHooks so
 * the outbox guard does not depend on the hook layer it exists to police.
 */
export async function recognizedCommissionForSale(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">,
  adjustmentSeq: number
): Promise<number> {
  const postedAmount = async (idempotencyKey: string, field: "amountMinor" | "deltaMinor") => {
    const event = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .first();
    const value = event?.payload?.[field];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  let total = await postedAmount(`commission_accrued_${saleId}`, "amountMinor");
  for (let sequence = 1; sequence <= adjustmentSeq; sequence++) {
    total += await postedAmount(`commission_adjusted_${saleId}_${sequence}`, "deltaMinor");
  }
  return total;
}
