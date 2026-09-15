import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { isMinorAmount } from "./financingEconomics";

/**
 * The pure summary of a deal's cost lines — status per line, totals kept
 * strictly apart, and the readable-total contract — in a module with no
 * database and no Convex function, so that both the cost module and the
 * finalization path (`financedSaleRecognition`) can read the SAME verdict
 * without importing each other.
 */
/**
 * The state of one cost line, derived rather than stored.
 *
 * A stored status drifts from the fields it summarises the first time one is
 * patched without the other. Note that RECORDED and RECONCILED are genuinely
 * different claims: somebody typed a number, versus somebody checked it against
 * evidence. Only the second may close a deal.
 */
export function deriveFeeStatus(
  fee: Doc<"financeDealFees">
): "VOID" | "RECONCILED" | "ACTUAL_RECORDED" | "ESTIMATED_ONLY" | "UNQUANTIFIED" {
  if (fee.voidedAt !== undefined) return "VOID";
  if (fee.reconciledAt !== undefined) return "RECONCILED";
  if (fee.actualAmountMinor !== undefined) return "ACTUAL_RECORDED";
  if (fee.estimatedAmountMinor !== undefined) return "ESTIMATED_ONLY";
  // A line that names a cost without quantifying it. Legitimate while a deal is
  // in flight — "there will be a transfer fee, amount unknown" — and precisely
  // the state that must not be read as zero.
  return "UNQUANTIFIED";
}

/**
 * Totals for a deal's costs, with estimated and actual kept strictly apart.
 *
 * `actualTotalMinor` sums ONLY the lines that have an actual. It is never
 * topped up with estimates for the lines that do not, because a total that
 * silently mixes the two answers neither "what did this cost" nor "what did we
 * think it would cost" — and reads as complete when it is not. `linesAwaiting*`
 * is how a caller knows which one it is holding.
 */
export function summarizeFees(fees: Array<Doc<"financeDealFees">>) {
  // Every line carries its own `currency`, and the totals below are integers
  // in ONE of them. Summing fils with cents produces a number that looks like
  // a total and is not one, so a mixed set refuses here rather than at some
  // caller that forgot to check (SCRUM-319). `listDealCosts` pre-checks and
  // reports the condition instead of throwing; any other caller that reaches
  // this with mixed rows is a bug and should hear about it.
  const currencies = new Set(fees.filter((fee) => fee.voidedAt === undefined).map((fee) => fee.currency));
  if (currencies.size > 1) {
    throw new ConvexError(
      `Deal costs are recorded in more than one currency (${[...currencies].join(", ")}); their totals cannot be summed.`
    );
  }
  let estimatedTotalMinor = 0;
  let actualTotalMinor = 0;
  let dealerBorneActualMinor = 0;
  let linesAwaitingActual = 0;
  let linesAwaitingReconciliation = 0;

  for (const fee of fees) {
    // Belt as well as braces. Every caller filters first, but this function is
    // exported — and the first caller that passes raw rows would sum voided
    // actuals into the total and count voided lines as awaiting one.
    if (fee.voidedAt !== undefined) continue;
    if (fee.estimatedAmountMinor !== undefined) {
      estimatedTotalMinor += fee.estimatedAmountMinor;
    }
    if (fee.actualAmountMinor !== undefined) {
      actualTotalMinor += fee.actualAmountMinor;
      if (fee.paidBy === "DEALER" || fee.paidBy === "EMPLOYEE") {
        dealerBorneActualMinor += fee.actualAmountMinor;
      }
    } else {
      linesAwaitingActual += 1;
    }
    if (fee.actualAmountMinor !== undefined && fee.reconciledAt === undefined) {
      linesAwaitingReconciliation += 1;
    }
  }

  const liveCount = fees.filter((fee) => fee.voidedAt === undefined).length;
  const amountsUnreadable = unreadableFeeAmounts(fees);
  return {
    lineCount: liveCount,
    estimatedTotalMinor,
    actualTotalMinor,
    /** What the dealership itself ended up out of pocket, on recorded actuals only. */
    dealerBorneActualMinor,
    linesAwaitingActual,
    linesAwaitingReconciliation,
    /**
     * Why the three totals above are NOT figures, when they are not. The
     * accumulation is unchecked — `v.number()` admits NaN, Infinity, fractions,
     * negatives and unsafe values, and a stored row carries whatever it was
     * given — so a caller that publishes a total reads this first and serves
     * the reason instead. `null` is the readable case.
     */
    amountsUnreadable,
    /**
     * True only when every line has a checked actual. Estimates never satisfy
     * this, and neither does an actual nobody can read: a corrupt amount is
     * not a reconciled one.
     */
    fullyReconciled:
      liveCount > 0 &&
      linesAwaitingActual === 0 &&
      linesAwaitingReconciliation === 0 &&
      amountsUnreadable === null,
  };
}

/** Why a deal's cost totals cannot be stated from its live lines. */
export type FeeAmountsUnreadableReason = "UNSAFE_AMOUNT";

/**
 * The readable-total contract: every live line's recorded amounts are safe
 * non-negative integers, and the totals built from them stay in the safe
 * range. Anything else — NaN, Infinity, a fraction of a minor unit, a
 * negative, an unsafe integer, or an overflow between safe operands — is
 * reported here so a publisher serves `null` with this reason rather than a
 * total that is not one. Checked positively, because NaN passes every
 * negative comparison.
 */
export function unreadableFeeAmounts(
  fees: ReadonlyArray<Pick<Doc<"financeDealFees">, "voidedAt" | "estimatedAmountMinor" | "actualAmountMinor">>
): FeeAmountsUnreadableReason | null {
  let estimatedTotalMinor = 0;
  let actualTotalMinor = 0;
  for (const fee of fees) {
    if (fee.voidedAt !== undefined) continue;
    if (fee.estimatedAmountMinor !== undefined) {
      if (!isMinorAmount(fee.estimatedAmountMinor)) return "UNSAFE_AMOUNT";
      estimatedTotalMinor += fee.estimatedAmountMinor;
    }
    if (fee.actualAmountMinor !== undefined) {
      if (!isMinorAmount(fee.actualAmountMinor)) return "UNSAFE_AMOUNT";
      actualTotalMinor += fee.actualAmountMinor;
    }
  }
  // Safe operands can still overflow between them. The dealer-borne subtotal
  // is bounded by the actual total, so the two sums cover all three.
  if (!Number.isSafeInteger(estimatedTotalMinor) || !Number.isSafeInteger(actualTotalMinor)) {
    return "UNSAFE_AMOUNT";
  }
  return null;
}
