import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { assertSupportedDenomination, supportedCurrencyScale } from "./money";

/**
 * A caller-stated denomination, validated against server authority BEFORE any
 * write (SCRUM-319). The client says what currency and scale it believes it is
 * sending minor units in; the server refuses anything it cannot vouch for —
 * an unrecognised code, a non-canonical spelling, an empty string — rather than
 * comparing it later against a stored value and calling the mismatch "wrong
 * currency" when the real fault is that the input never named one.
 */
export function assertExpectedCurrency(expectedCurrency: string, action: string): void {
  // An empty string falls out of the scale lookup like any other unknown code.
  if (
    expectedCurrency !== expectedCurrency.toUpperCase() ||
    supportedCurrencyScale(expectedCurrency) === null
  ) {
    throw new ConvexError(
      `The currency this request was entered in ("${expectedCurrency}") is not one AutoFlow can use, so ${action} would store an amount at a scale nobody verified. Reload the deal and try again.`
    );
  }
}

/** The denominations carried by a deal's live money facts: cost lines and custody records. */
export async function dealMoneyFactCurrencies(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Set<string>> {
  const [fees, custody] = await Promise.all([
    ctx.db
      .query("financeDealFees")
      .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
      .collect(),
    ctx.db
      .query("financeDealCustody")
      .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
      .collect(),
  ]);
  const currencies = new Set<string>();
  for (const fee of fees) if (fee.voidedAt === undefined) currencies.add(fee.currency);
  for (const row of custody) currencies.add(row.currency);
  return currencies;
}

/**
 * The denomination a deal's money is recorded in, proven rather than guessed.
 *
 * The pinned `economicsCurrency` wins when present. Before the pin exists the
 * organization's verified currency is the only authority — and the FIRST money
 * fact recorded against it (an early licensing estimate, a custody advance)
 * fixes it: `orgSettings.upsert` refuses a currency change once any such row
 * exists, and every later pin has to agree with those rows. So "no pin yet" is
 * not "free to reinterpret"; it is "denominated by what was already written".
 *
 * Refuses when the facts already on the deal disagree with the currency about
 * to be used. That state is unreachable through the product (the lock closes
 * every ordering) and reachable through a raw edit, and a raw edit is exactly
 * when a write that silently picks one side would turn a visible contradiction
 * into a quiet mis-scaling.
 */
export async function resolveDealCurrency(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  action: string
): Promise<string> {
  assertSupportedDenomination(app.economicsCurrency, action);
  const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, app.orgId));
  const facts = await dealMoneyFactCurrencies(ctx, app._id);
  const contradicting = [...facts].filter((code) => code !== currency);
  if (contradicting.length > 0) {
    throw new ConvexError(
      `This deal already has costs or custody recorded in ${contradicting.join(", ")}, but ${action} would use ${currency}. A deal's money is kept in one currency; restore the organization's currency to ${contradicting[0]} or correct the records before continuing.`
    );
  }
  return currency;
}

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
 *
 * A row in another DENOMINATION is not ignored — it refuses (SCRUM-319). Each
 * line carries its own `currency`, and an integer recorded as fils cannot be
 * subtracted from a remittance in cents. Ignoring it would understate what the
 * company withholds; summing it would misstate it by an order of magnitude.
 * Neither is a settlement anybody agreed to, so the caller has to say which
 * currency it is settling in, and every line has to be in it.
 */
export function settlementDeductedActualMinor(
  fees: Array<Doc<"financeDealFees">>,
  currency: string
): number {
  const foreign = fees.filter((fee) => fee.currency !== currency);
  if (foreign.length > 0) {
    const codes = [...new Set(foreign.map((fee) => fee.currency))].join(", ");
    throw new ConvexError(
      `${foreign.length} settlement-deducted cost line(s) on this deal are recorded in ${codes}, but the settlement is in ${currency}. Costs cannot be deducted across currencies; correct the lines before continuing.`
    );
  }
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
  applicationId: Id<"financeApplications">,
  currency: string
): Promise<number> {
  return settlementDeductedActualMinor(await settlementDeductedFees(ctx, applicationId), currency);
}
