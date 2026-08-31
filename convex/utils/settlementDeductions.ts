import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * What a financing company withholds from the money it sends the dealership.
 *
 * One derivation, read by two callers that must never disagree: the economics
 * recompute that stores `expectedDealerRemittanceMinor`, and the posting plan
 * that opens the finance-company receivable from it. When those two were allowed
 * to differ the stored figure was computed as though nothing were ever withheld
 * — the recompute passed a literal zero — so a deal whose company netted a
 * commission out of the settlement recorded a receivable for more than it would
 * ever be paid, and nothing downstream could tell.
 *
 * Lives in its own file rather than in either caller so both can import it
 * without a cycle.
 */

/** Live cost lines on a deal: everything not voided. */
async function activeFees(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"financeDealFees">>> {
  const rows = await ctx.db
    .query("financeDealFees")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .collect();
  return rows.filter((row) => row.voidedAt === undefined);
}

/**
 * The live cost lines the company takes out of the remittance rather than
 * billing separately.
 *
 * `deductedFromSettlement` is recorded per line and is not derivable from who
 * pays or who is paid: a dealership can bear a cost the company still bills it
 * for, and the company can withhold a cost somebody else ultimately owes. Only
 * the flag says whether this particular amount reduces the transfer.
 */
export async function settlementDeductedFees(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"financeDealFees">>> {
  const rows = await activeFees(ctx, applicationId);
  return rows.filter((row) => row.deductedFromSettlement === true);
}

/**
 * What those lines actually withhold, in minor units.
 *
 * Recorded actuals only. A line with no actual amount is an unanswered question
 * — nobody has said what was withheld — and answering it with the estimate
 * would store a remittance the company never agreed to. Contributing nothing is
 * not a claim that nothing was withheld either: `classifyDealAccounting`
 * refuses while any line is still awaiting its actual, and finalization refuses
 * an unclassified deal, so by the time this figure reaches a journal every line
 * behind it has both an actual and a reconciliation.
 *
 * Negative and non-integer amounts are ignored rather than trusted. Every
 * writer validates before storing, so one here would mean the row was written
 * around them, and a settlement that silently grew because a stored amount was
 * negative is worse than one that ignores it and fails the plan's balance check.
 */
export function settlementDeductedActualMinor(
  fees: Array<Doc<"financeDealFees">>
): number {
  let total = 0;
  for (const fee of fees) {
    const amount = fee.actualAmountMinor;
    if (amount === undefined) continue;
    if (!Number.isInteger(amount) || amount <= 0) continue;
    total += amount;
  }
  return total;
}

/** Both steps together, for a caller that only wants the number. */
export async function settlementDeductedTotalMinor(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<number> {
  return settlementDeductedActualMinor(await settlementDeductedFees(ctx, applicationId));
}
