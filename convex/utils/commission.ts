/**
 * The commission state of a sale. Derived from the sale row rather than stored,
 * so it cannot drift out of step with the fields it summarizes:
 *  - NOT_SET        — nobody has decided yet (`commissionAmount == null`).
 *  - NO_COMMISSION  — reviewed and deliberately set to zero. Unset is NOT zero:
 *                     one is an open task, the other is a closed decision.
 *  - UNPAID         — a positive amount is owed and not yet settled.
 *  - PAID           — settled, directly or through a payroll run.
 *  - VOID           — the sale was cancelled. Cancellation reverses the GL
 *                     accrual but deliberately leaves `commissionAmount` on the
 *                     row as history, so the amount alone would keep reading as
 *                     owed forever.
 */
export type CommissionStatus = "NOT_SET" | "NO_COMMISSION" | "UNPAID" | "PAID" | "VOID";

/** The fields every commission rule reads. Narrow on purpose: anything that
 *  needs more than this is not a rule about the commission itself. */
export interface CommissionSaleFields {
  status: "PENDING" | "COMPLETED" | "CANCELLED";
  commissionAmount?: number;
  commissionPaidAt?: number;
  isDeleted?: boolean;
}

export function deriveCommissionStatus(sale: CommissionSaleFields): CommissionStatus {
  if (sale.commissionPaidAt != null) return "PAID";
  // A paid commission blocks cancellation outright (see saleCancellation), so
  // PAID is checked first and VOID can never hide a real payment.
  if (sale.status === "CANCELLED") return "VOID";
  if (sale.commissionAmount == null) return "NOT_SET";
  return sale.commissionAmount > 0 ? "UNPAID" : "NO_COMMISSION";
}

/**
 * The single definition of "this sale still owes a commission". Used by the
 * commissions page, the Commission Payable GL-vs-subledger reconciliation, and
 * (with its own extra period and membership rules on top) the payroll sweep —
 * so those three can never quietly disagree about what is outstanding.
 *
 * Cancellation reverses the GL accrual via hookCommissionReversed but never
 * clears `commissionAmount`, so without the status check a cancelled sale would
 * count as owed on every one of those surfaces while the ledger says zero.
 */
export function isCommissionOwed<T extends CommissionSaleFields>(
  sale: T
): sale is T & { commissionAmount: number } {
  return (
    sale.isDeleted !== true &&
    sale.status !== "CANCELLED" &&
    sale.commissionAmount != null &&
    sale.commissionAmount > 0 &&
    sale.commissionPaidAt == null
  );
}

export interface CommissionTier {
  minProfitAmount: number;
  commissionPct: number;
}

export function calculateCommissionFromTiers(
  grossProfit: number,
  tiers: CommissionTier[]
): number {
  if (tiers.length === 0 || grossProfit <= 0) return 0;
  const sorted = [...tiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount);
  let pct = 0;
  for (const tier of sorted) {
    if (grossProfit >= tier.minProfitAmount) pct = tier.commissionPct;
  }
  return (grossProfit * pct) / 100;
}
