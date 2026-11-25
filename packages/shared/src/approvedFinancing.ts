/**
 * Approved financing amount (SCRUM-613 / SCRUM-993).
 *
 * The finance company approves an amount of money. That entered amount (F) is
 * the authority; every percentage is derived from it for display and is never
 * used to recompute it. Money is integer minor units in the organisation
 * currency.
 *
 * Composition identity once F is entered (A = approved purchase value):
 *   funded(F) + customer applied + dealer contribution - excess = A
 * The excess is what the finance company and the customer together pay above
 * A. It is never negative and never created by rounding.
 */

export interface ApprovedFinancingSplit {
  financeCompanyFundedPortionMinor: number;
  unfinancedPortionMinor: number;
  customerFirstPaymentAppliedMinor: number;
  dealerContributionMinor: number;
  excessMinor: number;
}

/**
 * Splits A around the entered F. The caller has already validated F against A
 * (see validateApprovedFinancingAmount); F is clamped to A defensively so the
 * unfinanced portion can never go negative on a corrupt row.
 */
export function splitAroundApprovedFinancing(input: {
  approvedPurchaseAmountMinor: number;
  customerFirstPaymentMinor: number;
  approvedFinancingMinor: number;
}): ApprovedFinancingSplit {
  const approved = input.approvedPurchaseAmountMinor;
  const funded = Math.min(input.approvedFinancingMinor, approved);
  const applied = Math.min(input.customerFirstPaymentMinor, approved);
  const covered = funded + applied;
  return {
    financeCompanyFundedPortionMinor: funded,
    unfinancedPortionMinor: approved - funded,
    customerFirstPaymentAppliedMinor: applied,
    dealerContributionMinor: Math.max(0, approved - covered),
    excessMinor: Math.max(0, covered - approved),
  };
}

export type ApprovedFinancingValidation =
  | { ok: true }
  | { ok: false; reason: "MISSING" | "NOT_POSITIVE_INTEGER" | "ABOVE_APPROVED_VALUE" };

/** Mutation-boundary check: a positive integer no larger than the approved value. */
export function validateApprovedFinancingAmount(
  value: unknown,
  approvedPurchaseAmountMinor: number
): ApprovedFinancingValidation {
  if (value === undefined || value === null) return { ok: false, reason: "MISSING" };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, reason: "NOT_POSITIVE_INTEGER" };
  }
  if (value > approvedPurchaseAmountMinor) return { ok: false, reason: "ABOVE_APPROVED_VALUE" };
  return { ok: true };
}

export interface ApprovedFinancingFigures {
  percentOfApprovedValue: number;
  percentOfQuotation: number;
  /** Display only (ruling c25968): quotation - F - customer pays, floored at 0. */
  contributionFromQuotationMinor: number;
  excessMinor: number;
  /** F + customer pays - A when positive; what the dealer receives = A + excess. */
  dealerReceivesMinor: number;
}

function ratioPercent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  // 6-decimal half-up via integer maths (no float drift on money-sized values).
  const scaled = (BigInt(part) * 100_000_000n * 2n + BigInt(whole)) / (BigInt(whole) * 2n);
  return Number(scaled) / 1_000_000;
}

/** Read-only figures for the decision card and the deal summary. */
export function deriveApprovedFinancingFigures(input: {
  approvedFinancingMinor: number;
  approvedPurchaseAmountMinor: number;
  quotationMinor: number;
  customerPaysMinor: number;
}): ApprovedFinancingFigures {
  const { excessMinor } = splitAroundApprovedFinancing({
    approvedPurchaseAmountMinor: input.approvedPurchaseAmountMinor,
    customerFirstPaymentMinor: input.customerPaysMinor,
    approvedFinancingMinor: input.approvedFinancingMinor,
  });
  return {
    percentOfApprovedValue: ratioPercent(input.approvedFinancingMinor, input.approvedPurchaseAmountMinor),
    percentOfQuotation: ratioPercent(input.approvedFinancingMinor, input.quotationMinor),
    contributionFromQuotationMinor: Math.max(
      0,
      input.quotationMinor - input.approvedFinancingMinor - input.customerPaysMinor
    ),
    excessMinor,
    dealerReceivesMinor: input.approvedPurchaseAmountMinor + excessMinor,
  };
}
