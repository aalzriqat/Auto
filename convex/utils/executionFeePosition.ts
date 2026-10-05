import type { Doc, Id } from "../_generated/dataModel";
import { reasonOf, type ClosingReadinessReason } from "../../lib/closingReadinessReasonCodes";
import { CUSTODY_POSTABLE_TREATMENTS } from "./dealCustodyPosting";
import { isMinorAmount } from "./financingEconomics";
import { toMinorUnits } from "./money";

/**
 * The finance company's EXECUTION FEE as one position (SCRUM-690 F-PNTR-1,
 * rulings c22113 / c22119).
 *
 * A deal whose frozen economics carry an execution fee — `adminFees` on the
 * configured company snapshot, or on the manual finance snapshot — owes that
 * fee to the finance company as a SEPARATE dealership payment (the company
 * remits the full approved amount, c21888). The position is:
 *
 *   ONE expected amount (frozen), at most ONE bound actual line, and the gate,
 *   the checklist and both profit headlines read that same position.
 *
 * The actual is bound EXPLICITLY, by line id (`executionFeeBinding`), never
 * inferred from a fee type and a payer: an unrelated dealership cost must not
 * retire the expectation (the #pntr defect: a 550 ownership transfer hid an
 * unrecorded 700). A bound actual — any amount, an explicit 0 included —
 * retires the whole expectation; unbinding or voiding it makes the position
 * unrecorded again.
 *
 * Pure: no database, no Convex function.
 */

type App = Pick<
  Doc<"financeApplications">,
  "companyRuleSnapshot" | "manualFinanceSnapshot" | "quoteModeAtSubmission" | "estimatedDealerBorneExpensesMinor"
>;

type FeeLine = Pick<
  Doc<"financeDealFees">,
  | "_id"
  | "voidedAt"
  | "feeType"
  | "paidBy"
  | "currency"
  | "deductedFromSettlement"
  | "accountingTreatment"
  | "actualAmountMinor"
  | "executionFeeBinding"
>;

/**
 * The frozen expected execution fee, in minor units of `currency`.
 *
 *  - `applies: false` — the deal's economics carry no execution fee: no
 *    snapshot amount, a zero one, or a legacy template-only snapshot (which
 *    keeps the per-template machinery in `settlementDeductions`).
 *  - `expectedMinor: null` — a fee is configured but its frozen amount cannot
 *    be read at this currency's scale. The position still applies and fails
 *    closed: nothing may treat an unreadable fee as zero.
 */
export type ExecutionFeeExpectation =
  | { applies: false }
  | { applies: true; source: "CONFIGURED" | "MANUAL"; expectedMinor: number | null };

export function executionFeeExpectation(app: App, currency: string): ExecutionFeeExpectation {
  const configured = app.companyRuleSnapshot?.adminFees;
  // Same precedence as `resolveExpectedExecutionFeesMinor`: the configured
  // snapshot's single fee authority first; manual only on a manual deal.
  const [source, major] =
    configured !== undefined
      ? (["CONFIGURED", configured] as const)
      : app.quoteModeAtSubmission === "MANUAL_FINANCE_COMPANY" && app.manualFinanceSnapshot?.adminFees !== undefined
        ? (["MANUAL", app.manualFinanceSnapshot.adminFees] as const)
        : ([null, undefined] as const);
  if (source === null || major === undefined) return { applies: false };
  let expectedMinor: number | null;
  try {
    expectedMinor = toMinorUnits(major, currency);
  } catch {
    expectedMinor = null;
  }
  if (expectedMinor !== null && !isMinorAmount(expectedMinor)) expectedMinor = null;
  // A configured fee of zero is not a position: there is nothing to record.
  if (expectedMinor === 0) return { applies: false };
  return { applies: true, source, expectedMinor };
}

/**
 * Why `line` cannot be the execution fee's actual, or null when it can.
 * Compatible means: live; a finance-company fee; borne by the dealership
 * (paid by it, or by an employee from custody); not withheld from the
 * settlement (the fee is a separate payment, c22119 Q1); of a treatment a
 * custody or direct payment can post; in the deal's currency; and carrying a
 * readable actual — an explicit 0 included.
 */
export function executionFeeBindRefusal(line: FeeLine, currency: string): string | null {
  if (line.voidedAt !== undefined) return "This cost has been removed, so it cannot be the execution fee.";
  if (line.feeType !== "FINANCE_COMPANY_FEE") return "Only a finance-company fee can be the execution fee.";
  if (line.paidBy !== "DEALER" && line.paidBy !== "EMPLOYEE") {
    return "The execution fee is paid by the dealership (directly or from an employee's custody); this cost was recorded as paid by someone else.";
  }
  if (line.deductedFromSettlement === true) {
    return "This cost was recorded as withheld from the finance company's settlement, but the execution fee is a separate dealership payment.";
  }
  if (!CUSTODY_POSTABLE_TREATMENTS.has(line.accountingTreatment)) {
    return `This cost is treated as ${line.accountingTreatment}, which no payment can be recorded against.`;
  }
  if (line.currency !== currency) return `This cost is in ${line.currency}, but the deal's money is kept in ${currency}.`;
  if (line.actualAmountMinor === undefined || !isMinorAmount(line.actualAmountMinor)) {
    return "Record what this cost actually came to (zero if nothing was charged) before linking it as the execution fee.";
  }
  return null;
}

/**
 * The execution-fee position over a deal's LIVE lines.
 *
 *  - `bound` — the one live bound line, or null.
 *  - `unrecordedMinor` — what of the expectation is not yet covered: the whole
 *    expected amount while nothing is bound, 0 once a line is bound
 *    (whatever its amount — c22119 Q4). Null when unreadable.
 *  - `aggregateConflict` — the deal's frozen expected dealer-borne total
 *    differs from the fee. The difference is neither cost nor revised fee
 *    until somebody classifies it, so an estimate built on either is withheld
 *    (c22119 Q3).
 *  - `ambiguous` — more than one live bound line, or a bound line that is not
 *    compatible. No writer produces either; read as unrecorded, fail closed.
 */
export type ExecutionFeePosition =
  | { applies: false }
  | {
      applies: true;
      source: "CONFIGURED" | "MANUAL";
      expectedMinor: number | null;
      bound: { feeId: Id<"financeDealFees">; actualMinor: number } | null;
      unrecordedMinor: number | null;
      aggregateConflict: boolean;
      ambiguous: boolean;
    };

export function executionFeePosition(
  app: App,
  liveFees: ReadonlyArray<FeeLine>,
  currency: string
): ExecutionFeePosition {
  const expectation = executionFeeExpectation(app, currency);
  if (!expectation.applies) return { applies: false };
  const boundLines = liveFees.filter((fee) => fee.voidedAt === undefined && fee.executionFeeBinding !== undefined);
  const only = boundLines.length === 1 ? boundLines[0] : undefined;
  const usable = only !== undefined && executionFeeBindRefusal(only, currency) === null ? only : undefined;
  const ambiguous = boundLines.length > 1 || (only !== undefined && usable === undefined);
  const bound =
    usable !== undefined && usable.actualAmountMinor !== undefined
      ? { feeId: usable._id, actualMinor: usable.actualAmountMinor }
      : null;
  const { expectedMinor } = expectation;
  const aggregate = app.estimatedDealerBorneExpensesMinor;
  return {
    applies: true,
    source: expectation.source,
    expectedMinor,
    bound,
    unrecordedMinor: bound !== null ? 0 : expectedMinor,
    aggregateConflict: expectedMinor !== null && aggregate !== undefined && aggregate !== expectedMinor,
    ambiguous,
  };
}

/** Whether the position (when it applies) still needs its actual. */
export function executionFeeUnrecorded(position: ExecutionFeePosition): boolean {
  return position.applies && position.bound === null;
}

/**
 * The closing-readiness verdict for the position: the same coded reason the
 * configured-template positions use (`CONFIGURED_FEES_MISSING`), so the
 * checklist and its translations need nothing new.
 */
export function executionFeeRefusal(position: ExecutionFeePosition, action: string): ClosingReadinessReason | null {
  if (!executionFeeUnrecorded(position)) return null;
  return reasonOf(
    "CONFIGURED_FEES_MISSING",
    `The finance company's execution fee has no actual recorded. Record what the dealership actually paid for it — zero if it was not charged — before ${action}.`,
    { count: 1 }
  );
}

/**
 * The execution-fee operand a profit headline needs, or `null` when the
 * position does not apply (the caller keeps its legacy expectation rule).
 *
 *  - `{ unrecordedMinor }` — add this to the recorded actuals: the expected
 *    fee while unbound, 0 once bound. Never `max(expected, all actuals)`,
 *    which let an unrelated cost consume the fee.
 *  - `{ withheld: true }` — the estimate cannot be stated: the fee or its
 *    binding is unreadable, or the frozen aggregate disagrees with the fee.
 */
export type ExecutionFeeHeadline = { unrecordedMinor: number } | { withheld: true };

export function executionFeeWithheld(headline: ExecutionFeeHeadline | null): boolean {
  return headline !== null && "withheld" in headline;
}

export function executionFeeHeadline(position: ExecutionFeePosition): ExecutionFeeHeadline | null {
  if (!position.applies) return null;
  if (position.ambiguous || position.aggregateConflict || position.unrecordedMinor === null) return { withheld: true };
  return { unrecordedMinor: position.unrecordedMinor };
}
