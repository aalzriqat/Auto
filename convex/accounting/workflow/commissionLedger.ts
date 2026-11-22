import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { checkPostingAllowed } from "../../utils/postingPeriod";
import { queuedEntryStatus, isEventQueued } from "./posting";

/**
 * The accounting date every commission entry for a sale must use — accrual and
 * correction alike. Living here rather than in each caller is the point: when
 * the accrual used a different rule from the correction, a correction could post
 * into an open period while the accrual it corrected was still queued behind a
 * closed one, leaving a naked delta in Commission Payable.
 *
 * The rule is the sale's own date, unconditionally, so the expense lands in the
 * period that recognized the revenue it was earned against. There are no
 * exceptions; the body records the two that used to exist and why both were
 * retired.
 *
 * This is the date for RECOGNITION only. A PAYMENT is dated when the cash
 * actually moves, not at the sale — see `hookCommissionPaid`'s callers. Reading
 * this docstring as if it covered payment too is what produced a regression
 * that blocked paying any commission whose month had since closed.
 */
export async function commissionAccountingDate(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">,
  saleDate: number
): Promise<number> {
  // The sale's date, unconditionally — and that is the whole rule.
  //
  // This began as "sale date, or today if the sale's period is closed", to stop
  // an accrual stranding in the outbox. Two things retired that fallback:
  //
  // 1. It was wrong. A commission belongs in the period that recognized the
  //    revenue it was earned against, and SALE_COMPLETED has no such fallback —
  //    so falling back moved the expense to a month the sale was not in, and
  //    separated it from its own revenue. payroll.test.ts has asserted since
  //    before this work that a commission for a closed month must wait for that
  //    month rather than be recognized in a later one.
  // 2. It was the last place callers could disagree. Payroll approval passed the
  //    run's period end and the backfill passed wall-clock time, so a backlog
  //    sale was recognized in whichever period first claimed the shared
  //    idempotency key. Making every caller route through one function is not
  //    enough while the function still takes an answer from them.
  //
  // The hazard the fallback guarded against is now covered where it belongs: the
  // drain-side guards refuse to settle a commission whose accrual has not posted,
  // so a queued accrual can no longer drive Commission Payable negative, and an
  // unposted entry is a period-close blocker an accountant is shown rather than a
  // silent stall. Queuing until the month opens is the designed behaviour, not a
  // failure — it is exactly what the sale's own entry does.
  //
  // Kept as a function, and every caller kept on it, so the rule has one home
  // if it ever needs to be conditional again.
  return saleDate;
}

/**
 * True once this sale's commission has been recognized in the ledger — either a
 * posted COMMISSION_ACCRUED journal entry or a still-queued accrual in the
 * outbox. Both AUTO and MANUAL accrue as soon as the amount is measurable on a
 * completed sale, so this decides whether a new amount is a FIRST accrual or a
 * correction to one already on the books (setCommissionAmount), whether
 * recalculateCommission's one-shot fix-up still applies, and — via
 * `commissionAccrualStrandedReason` below — whether a closed sale period is
 * actually an obstacle or an irrelevance.
 */
export async function hasCommissionAccrual(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<boolean> {
  // Only an ACTIVE accrual counts. A REVERSED event means the accrual was
  // backed out (e.g. the sale was voided), which must genuinely unlock the
  // amount again.
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
  // Outbox rows persist after being processed (status POSTED) — a processed
  // row's accrual is already covered by the accountingEvents check above, so
  // only a still-queued (PENDING/FAILED) row counts as an accrual here.
  const pending = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", `commission_accrued_${saleId}`)
    )
    .filter((q) => q.neq(q.field("status"), "POSTED"))
    .first();
  return pending !== null;
}

/**
 * Non-null when raising a commission accrual for this sale RIGHT NOW would
 * produce an entry the ledger can never accept — a new accrual dated into a
 * CLOSED or LOCKED period. Such an entry is not merely delayed: it burns every
 * retry and dead-letters into a row that blocks both payment and every future
 * period close, and a LOCKED period cannot be reopened to rescue it.
 *
 * The condition that matters is whether a NEW accrual has to be created, not
 * whether the sale's period happens to be closed. Getting that backwards is a
 * real regression this branch shipped and had to withdraw: the guard was applied
 * unconditionally in `markCommissionPaid`, which refused the ordinary flow of
 * closing a month and then paying the commissions earned in it. When the accrual
 * is already on the books the accrual hook is an idempotent no-op, nothing is
 * dated into the closed period at all, and the payment is dated today — so the
 * closed period is simply irrelevant to that operation.
 *
 * `waiting: true` (no period exists yet) is deliberately allowed through. That
 * entry queues harmlessly, burns no attempts, and posts when the month opens —
 * which is exactly what the sale's own entry does, and what an org that has not
 * set up its accounting yet depends on.
 *
 * Callers that ALWAYS write an entry dated at the sale (setCommissionAmount and
 * recalculateCommission, which post a correction) must check the period
 * unconditionally instead; for them there is no no-op case.
 */
export async function commissionAccrualStrandedReason(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">,
  saleDate: number,
): Promise<"CLOSED_PERIOD" | null> {
  if (await hasCommissionAccrual(ctx, orgId, saleId)) return null;
  const check = await checkPostingAllowed(ctx, orgId, saleDate);
  // Only a CLOSED or LOCKED period. `waiting: true` — no period covers the sale
  // yet — deliberately passes: that accrual queues at the sale's own date and
  // posts when someone creates and opens the month, which is the whole of
  // earned-time recognition for an org still setting up its books.
  //
  // A round-11 review proposed refusing that case too, because payroll can
  // approve a run whose accrual is queued and then payRun refuses it. Rejected:
  // payroll.test.ts "#2 re-accruing a queued commission does not recognize it in
  // a later period" pins the opposite as a deliberate invariant, and refusing
  // would silently drop the commission out of payroll rather than defer it —
  // recognising it late in the wrong month is exactly what this branch exists to
  // stop. That situation has a real exit (create and open the period covering
  // the sale); it needed to be SAID, not prevented, so the close checklist now
  // reports those sales separately and payRun names the remedy.
  return !check.ok && !check.waiting ? "CLOSED_PERIOD" : null;
}

/** The worst outstanding state across a sale's commission entries and its sale posting. */
export async function commissionEntriesOutstandingStatus(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sale: { _id: Id<"sales">; commissionAdjustmentSeq?: number }
): Promise<"PENDING" | "FAILED" | null> {
  const keys = [`sale_completed_${sale._id}`, `commission_accrued_${sale._id}`];
  const seq = safeAdjustmentSeq(sale.commissionAdjustmentSeq);
  if (seq === null) return "PENDING";
  for (let sequence = 1; sequence <= seq; sequence++) {
    keys.push(`commission_adjusted_${sale._id}_${sequence}`);
  }
  let worst: "PENDING" | "FAILED" | null = null;
  for (const key of keys) {
    const status = await queuedEntryStatus(ctx, orgId, key);
    if (status === "FAILED") return "FAILED";
    if (status === "PENDING") worst = "PENDING";
  }
  return worst;
}

/**
 * A correction credits Commission Payable exactly as the accrual does, so any
 * settlement that clears the payable must wait for the CORRECTIONS to post too,
 * not just the accrual. Checking only the accrual let a payment debit the full
 * corrected amount against a GL that held only the original — see the payroll
 * and direct-payment guards, which both call this so they cannot drift apart.
 *
 * The loop is clamped: commissionAdjustmentSeq is a plain number field and
 * `sales` rows are editable through the admin raw-JSON editor, so an implausible
 * value must not be able to make settlement unrunnable.
 */
export const MAX_COMMISSION_ADJUSTMENTS = 1000;

/**
 * The correction count, or null when it cannot be trusted.
 *
 * `Math.min(NaN, MAX)` is NaN and `1 <= NaN` is false, so clamping a corrupt
 * counter makes every walk over it quietly do nothing — the settlement guard
 * sees no corrections, the reversal leaves their deltas on the books, and both
 * report success. `sales` rows are writable through the admin raw-JSON editor,
 * so this is the threat model the ceiling exists for. Every caller that walks
 * the counter uses this, and each decides for itself whether null means refuse
 * or fail closed.
 */
export function safeAdjustmentSeq(adjustmentSeq: number | undefined): number | null {
  const seq = adjustmentSeq ?? 0;
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > MAX_COMMISSION_ADJUSTMENTS) return null;
  return seq;
}

/**
 * What the ledger has actually recognized for this sale's commission — the
 * posted accrual plus every posted correction, in minor units.
 *
 * Settlement debits the payable by the amount the SALE says is owed, while the
 * GL carries the amount the ENTRIES recognized. Those are normally identical
 * because every change posts a delta — but `sales` rows are writable through
 * the admin raw-JSON editor, and a bug in the delta arithmetic would produce
 * the same split. Paying against the difference drives Commission Payable
 * negative, and the next correction computes its delta from the already-wrong
 * row, so the normal workflow cannot repair it.
 */
export async function recognizedCommissionMinor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sale: { _id: Id<"sales">; commissionAdjustmentSeq?: number },
  currency: string
): Promise<number | null> {
  const postedAmount = async (
    idempotencyKey: string,
    field: "amountMinor" | "deltaMinor"
  ): Promise<{ minor: number; currency: string } | "ABSENT" | "MALFORMED"> => {
    const event = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .first();
    if (!event) return "ABSENT";
    const value = event.payload?.[field];
    // ABSENT and MALFORMED are NOT the same answer. Both used to return null
    // and the caller skipped either one, so a POSTED correction whose payload
    // could not be read was dropped from the total — while it had really moved
    // Commission Payable. That is the exact partial total the counter check
    // below refuses to produce, arrived at by another route.
    if (typeof value !== "number" || !Number.isFinite(value)) return "MALFORMED";
    return { minor: value, currency: event.currency };
  };

  // Only entries posted in the currency being settled. Minor units are
  // meaningless without their scale — JOD/KWD/BHD/OMR are scale 3 against USD's
  // 2 — so summing across currencies and comparing to one number is how a
  // legitimate settlement gets refused after an org changes its currency.
  // `null` means "recognized, but not in this currency", which is a different
  // problem from a wrong amount and deserves its own message.
  // Unreadable counter ⇒ recognition cannot be computed. Returning a partial
  // total would let a settlement compare against a number that silently omits
  // corrections, which is the same failure as not checking at all.
  const seq = safeAdjustmentSeq(sale.commissionAdjustmentSeq);
  if (seq === null) return null;
  let total = 0;
  let sawAny = false;
  let sawCurrency = false;
  for (const key of [
    { k: `commission_accrued_${sale._id}`, f: "amountMinor" as const },
    ...Array.from({ length: seq }, (_, i) => ({
      k: `commission_adjusted_${sale._id}_${i + 1}`,
      f: "deltaMinor" as const,
    })),
  ]) {
    const entry = await postedAmount(key.k, key.f);
    // Refuse, do not omit: this entry posted and moved the payable by an
    // amount that cannot be read here.
    if (entry === "MALFORMED") return null;
    if (entry === "ABSENT") continue;
    sawAny = true;
    if (entry.currency !== currency) continue;
    sawCurrency = true;
    total += entry.minor;
  }
  if (sawAny && !sawCurrency) return null;
  return total;
}

export async function commissionEntriesStillQueued(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sale: { _id: Id<"sales">; commissionAdjustmentSeq?: number }
): Promise<boolean> {
  // The sale's own posting counts. Inheriting its accounting date keeps the two
  // in the same PERIOD, but that is not the same as enforcing the order: once
  // that period opens while the sale's entry is still sitting in the outbox —
  // or has dead-lettered to FAILED and will never drain — a commission raised
  // now posts immediately, ahead of the revenue that earned it. The drain guard
  // covers entries that queue; nothing covered entries that post directly.
  if (await isEventQueued(ctx, orgId, `sale_completed_${sale._id}`)) return true;
  if (await isEventQueued(ctx, orgId, `commission_accrued_${sale._id}`)) return true;
  const seq = safeAdjustmentSeq(sale.commissionAdjustmentSeq);
  // A counter this code cannot read is treated as "something is outstanding".
  // Reporting "nothing queued" on unreadable evidence is an ALLOW, and what it
  // would allow is a settlement clearing corrections nobody could enumerate.
  if (seq === null) return true;
  for (let sequence = 1; sequence <= seq; sequence++) {
    if (await isEventQueued(ctx, orgId, `commission_adjusted_${sale._id}_${sequence}`)) return true;
  }
  return false;
}
