import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * The custody family's ledger identity and its two causal guards.
 *
 * ## The payable reclassification chain (Codex AF-CUST-01 / final round A)
 *
 * EMPLOYEE_REIMBURSEMENTS_PAYABLE carries a custody record's out-of-pocket
 * position as a chain of signed deltas, one `CUSTODY_PAYABLE_RECLASSIFIED`
 * event per version. The chain only states the right balance if it posts IN
 * ORDER: version 2 (say, the release when the employee is reimbursed) debits
 * the payable that version 1 credited, so version 2 landing first — because
 * version 1 was dated into a closed month and is still waiting in the outbox
 * while version 2 is dated today — puts a DEBIT on a liability that nothing
 * has credited yet, and a period snapshot taken in between reports it.
 *
 * So version N is held behind version N−1 at BOTH ends: the hook queues it
 * rather than posting it when its predecessor is not yet POSTED, and the
 * outbox worker re-proves the same thing before it posts a queued one. The
 * custody row keeps the TARGET the chain converges on; what is actually on
 * the books is answered here, from the ledger, never from the row.
 *
 * Mirrors `payrollSourceLedger` (PAYROLL_PAID behind its accruals) and
 * `prepaidPostingBlockedReason`, and is wired into the same worker chain.
 */

export const custodyPayableReclassKey = (custodyId: Id<"financeDealCustody">, version: number): string =>
  `custody_payable_reclass_${custodyId}_v${version}`;

/**
 * Whether a domain event with this idempotency key is actually on the books.
 * POSTED only: `accountingEvents.status` also admits PENDING and FAILED, and
 * either would let a release debit a payable whose credit never landed. The
 * key names one forward event; the bounded page is read in full rather than
 * `.first()`-ed, because a reversal shares the source key (ACC-4).
 */
async function eventPosted(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  const rows = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .take(8);
  return rows.some((row) => row.status === "POSTED");
}

/** Whether version `version` of a record's payable reclassification is POSTED. */
export async function custodyPayableReclassPosted(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  custodyId: Id<"financeDealCustody">,
  version: number
): Promise<boolean> {
  return eventPosted(ctx, orgId, custodyPayableReclassKey(custodyId, version));
}

/**
 * Why a queued custody event must NOT post yet, or `null` when it may.
 *
 * `CUSTODY_PAYABLE_RECLASSIFIED` version N waits for version N−1. Every
 * other custody event carries its own complete journal and has no
 * predecessor to wait for. Fails closed on a payload it cannot read: a
 * reclassification whose custody reference does not normalize cannot prove
 * its predecessor posted, and skipping the check is an ALLOW.
 */
export async function custodyPostingBlockedReason(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    eventType?: string;
    eventVersion?: number;
    payload?: unknown;
  }
): Promise<string | null> {
  if (entry.eventType !== "CUSTODY_PAYABLE_RECLASSIFIED") return null;
  const version = entry.eventVersion ?? 1;
  if (version <= 1) return null;
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const raw = typeof payload.custodyId === "string" ? payload.custodyId : null;
  const custodyId = raw ? ctx.db.normalizeId("financeDealCustody", raw) : null;
  if (!custodyId) {
    return "it carries no readable custody reference, so the payable reclassification it follows cannot be traced";
  }
  if (!(await custodyPayableReclassPosted(ctx, entry.orgId, custodyId, version - 1))) {
    return `custody payable reclassification v${version - 1} behind it has not posted to the ledger yet, so this would move an Employee Reimbursements Payable balance the ledger does not carry`;
  }
  return null;
}

/**
 * ## The canonical family boundary (final round B)
 *
 * A custody record is on the books as a FAMILY: the record's marker
 * (`ledgerPosting: "CANONICAL"`, set only by a writer that posts), every cash
 * leg, and every custody-paid cost line at its current actual
 * (`custodyPosted`). A deal is classified and finalized on the strength of
 * those postings — the sale's journal treats the handover costs as already
 * expensed out of the employee's cash. A record from before posting existed,
 * or a linked line whose posting is absent or does not match the row, would
 * let a deal close with cash movements the ledger never saw. Such a family is
 * refused every gate until `migrateLegacyCustodyToLedger` has posted it
 * completely; nothing here infers what those postings would have been.
 *
 * Pure over the same bounded rows the gates already read, so classification
 * and finalization cannot disagree about it.
 */
export function custodyLedgerFamilyRefusal(
  custodyRows: ReadonlyArray<Doc<"financeDealCustody">>,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): string | null {
  const byId = new Map(custodyRows.map((row) => [row._id, row]));
  for (const row of custodyRows) {
    if (row.ledgerPosting !== "CANONICAL") {
      return `A custody record on this deal predates ledger posting, so its cash movements are not on the books; ${action} is refused until the custody accounting migration has posted it.`;
    }
  }
  for (const fee of liveFees) {
    if (fee.voidedAt !== undefined || fee.custodyId === undefined) continue;
    if (!byId.has(fee.custodyId)) {
      return `A cost on this deal is charged to a custody record that is not on this deal, so ${action} is refused until the line is corrected.`;
    }
    const charged =
      fee.actualAmountMinor !== undefined && Number.isSafeInteger(fee.actualAmountMinor) && fee.actualAmountMinor > 0;
    const posted = fee.custodyPosted;
    if (!charged) {
      if (posted !== undefined) {
        return `A cost on this deal carries a custody posting for an actual it no longer records, so ${action} is refused until the line is corrected.`;
      }
      continue;
    }
    if (posted === undefined || posted.custodyId !== fee.custodyId || posted.amountMinor !== fee.actualAmountMinor) {
      return `A cost paid out of an employee's custody on this deal is not on the books at its recorded amount, so ${action} is refused until the custody accounting migration has posted it.`;
    }
  }
  return null;
}

/** Throws the family refusal, if any — the mutation-boundary form of the predicate above. */
export function assertCustodyLedgerFamilyComplete(
  custodyRows: ReadonlyArray<Doc<"financeDealCustody">>,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): void {
  const refusal = custodyLedgerFamilyRefusal(custodyRows, liveFees, action);
  if (refusal !== null) throw new ConvexError(refusal);
}
