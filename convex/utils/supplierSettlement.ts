import { Doc } from "../_generated/dataModel";

/**
 * The settlement state of a supplier payable, derived from the money rather
 * than stored alongside it.
 *
 * A stored status and a payment history are two records of the same fact, and
 * the one people read is not always the one the money agrees with. Deriving it
 * means a partial payment cannot leave a row reading PAID, and a reversal
 * cannot leave one reading PARTIALLY_PAID with nothing paid.
 *
 * Two states are genuinely stored rather than derived, because no amount
 * implies them: DISPUTED (somebody disagrees with a figure that is otherwise
 * perfectly payable) and CANCELLED (the sale behind it went away).
 */
export type SupplierSettlementStatus =
  | "NOT_YET_DUE"
  | "DUE_ON_SALE"
  | "PARTIALLY_PAID"
  | "PAID"
  | "DISPUTED"
  | "CANCELLED";

export interface SettlementView {
  status: SupplierSettlementStatus;
  amountDue: number;
  amountPaid: number;
  /** Never stored — see the schema note on `amountPaid`. */
  remainingAmount: number;
  overpaidAmount: number;
}

/**
 * Whether the supplier's entitlement has fallen due.
 *
 * The economic owner of a consigned vehicle is the supplier until it sells and
 * he is paid, so nothing is due before the sale exists.
 */
function isDue(payable: Doc<"vehicleSupplierPayables">): boolean {
  switch (payable.paymentDueTrigger) {
    case "FIXED_DATE":
      return payable.paymentDueDate !== undefined && Date.now() >= payable.paymentDueDate;
    case "ON_DEMAND":
      return false;
    case "ON_SETTLEMENT_RECEIPT":
    case "ON_SALE":
      return payable.saleId !== undefined;
    default:
      // Legacy rows carry no trigger. They were only ever created at sale
      // completion, so the sale is what made them due.
      return payable.saleId !== undefined;
  }
}

export function deriveSettlementStatus(
  payable: Doc<"vehicleSupplierPayables">
): SupplierSettlementStatus {
  if (payable.status === "CANCELLED") return "CANCELLED";
  if (payable.status === "DISPUTED") return "DISPUTED";

  const amountPaid = payable.amountPaid ?? 0;
  // A row marked PAID before partial payments existed carries no amountPaid.
  // Reading it as unpaid would resurrect a settled debt, so the stored flag is
  // honoured where the history cannot contradict it.
  if (payable.status === "PAID" && amountPaid === 0) return "PAID";

  if (amountPaid >= payable.amountDue && payable.amountDue > 0) return "PAID";
  if (amountPaid > 0) return "PARTIALLY_PAID";
  return isDue(payable) ? "DUE_ON_SALE" : "NOT_YET_DUE";
}

export function settlementView(payable: Doc<"vehicleSupplierPayables">): SettlementView {
  const status = deriveSettlementStatus(payable);
  const amountPaid =
    // Same legacy case: PAID with no recorded payments means the whole amount
    // went out before the field existed.
    payable.status === "PAID" && (payable.amountPaid ?? 0) === 0
      ? payable.amountDue
      : payable.amountPaid ?? 0;
  return {
    status,
    amountDue: payable.amountDue,
    amountPaid,
    remainingAmount: Math.max(0, payable.amountDue - amountPaid),
    // Surfaced rather than clamped away: paying a supplier twice is a real
    // event, and a report showing zero remaining tells nobody it happened.
    overpaidAmount: Math.max(0, amountPaid - payable.amountDue),
  };
}
