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
 *  - PENDING_SALE   — an amount was entered on a draft. Supported (it survives
 *                     completion by design) but nothing is earned or accrued
 *                     until the sale completes.
 *
 * This and `isCommissionOwed` below must never disagree about whether a row
 * owes money — PR 2 derives `salePayables` from these, and a backfill written
 * against the wrong one would mint payables for drafts and cancelled sales.
 * UNPAID is therefore defined AS `isCommissionOwed`, not alongside it.
 */
export type CommissionStatus =
  | "NOT_SET"
  | "NO_COMMISSION"
  | "UNPAID"
  | "PAID"
  | "VOID"
  | "PENDING_SALE";

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
  if (sale.commissionAmount <= 0) return "NO_COMMISSION";
  // A positive amount on a sale that has not completed is a pre-decision, not a
  // payable. Reading it as UNPAID here while isCommissionOwed says otherwise is
  // exactly the disagreement the doc comment above forbids.
  return isCommissionOwed(sale) ? "UNPAID" : "PENDING_SALE";
}

/**
 * The single definition of "this sale still owes a commission". Used by the
 * commissions page, the Commission Payable GL-vs-subledger reconciliation, and
 * (with its own extra period and membership rules on top) the payroll sweep —
 * so those three can never quietly disagree about what is outstanding.
 *
 * Only a COMPLETED sale can owe anything:
 *  - CANCELLED — cancellation reverses the GL accrual via hookCommissionReversed
 *    but never clears `commissionAmount`, so without this the amount alone would
 *    read as owed on every surface while the ledger already says zero.
 *  - PENDING — an amount may be entered on a draft before completion (it
 *    survives completion by design), but nothing has been earned or accrued yet.
 *    Counting a draft made the subledger exceed a GL liability that does not
 *    exist, and offered a payment the mutation refuses.
 */
export function isCommissionOwed<T extends CommissionSaleFields>(
  sale: T
): sale is T & { commissionAmount: number } {
  return (
    sale.isDeleted !== true &&
    sale.status === "COMPLETED" &&
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
