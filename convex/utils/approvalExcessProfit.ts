import { AppErrorCode, throwAppError } from "./errors";
import type { ManagementProfitLine } from "./financingEconomics";

/**
 * SCRUM-613: no financed posting plan has a leg for an approval excess (they forward the whole deposit plus
 * the contribution), so a deal that carries one must not post or record money. Every door that builds the
 * financed plan (`resolveFinancedSalePlan`, so the forward payment, the readiness plan and finalize) calls this.
 */
export function assertApprovalExcessPostable(app: { approvalExcessMinor?: number }): void {
  if ((app.approvalExcessMinor ?? 0) > 0) {
    throwAppError(
      AppErrorCode.APPROVAL_EXCESS_NOT_POSTABLE,
      "This approval pays the dealership more than the approved purchase amount (an excess). Posting that excess is not available yet, so the deal cannot be finalized until the approved financing amount is corrected.",
    );
  }
}

/**
 * SCRUM-613: the management-profit line for an approval excess (financing plus customer money above the
 * approved value). It is dealer income by default, and absent when there is none so existing profit lines
 * and totals are unchanged.
 */
export function approvalExcessLines(excessMinor: number | undefined): ManagementProfitLine[] {
  const amountMinor = excessMinor ?? 0;
  return amountMinor > 0 ? [{ key: "APPROVAL_EXCESS", sign: 1, amountMinor }] : [];
}
