import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";

async function hasHeldQuoteDeposit(
  ctx: QueryCtx,
  quoteId: Id<"quotes">,
): Promise<boolean> {
  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_quote_status", (q) =>
      q.eq("quoteId", quoteId).eq("status", "HELD"),
    )) {
    if (deposit.isDeleted !== true) return true;
  }
  return false;
}

/**
 * Whether this deal is holding customer money that nobody has decided about.
 *
 * A deposit taken on a deal that was then rejected or cancelled stays HELD
 * until somebody refunds or forfeits it: real cash in a liability with no
 * owner. It is the state the applications LIST surfaces as the synthetic
 * `DEPOSIT_PENDING` badge.
 *
 * Extracted so the list and the deal cockpit answer it with ONE rule. The
 * cockpit previously did not answer it at all — a held deposit read as plain
 * "Rejected" on the deal screen while the list said "Deposit Pending" — and the
 * review dialog computes a third version from a different input entirely.
 * Retiring the list before the cockpit could see this would silently delete a
 * live operational state.
 */
export async function pendingDepositResolution(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
): Promise<boolean> {
  if (app.status !== "REJECTED" && app.status !== "CANCELLED") return false;
  return hasHeldQuoteDeposit(ctx, app.quoteId);
}

export async function getQuoteDeposits(
  ctx: QueryCtx,
  quoteId: Id<"quotes">,
): Promise<Array<Doc<"deposits">>> {
  const deposits: Array<Doc<"deposits">> = [];
  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))) {
    if (deposit.isDeleted !== true) {
      deposits.push(deposit);
    }
  }
  return deposits;
}
