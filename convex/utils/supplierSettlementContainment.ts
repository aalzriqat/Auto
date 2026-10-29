import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-869 S1 / owner ruling SCRUM-869#c23881 (2026-10-29).
 * Supplier payable payment, consignment margin receipt and cost-recovery receipt are IN the pilot.
 * No reversal of them is indispensable for launch, so every reversal, unwind or correction door for
 * these three flows refuses server-side. Hiding a button is not a block.
 *
 * The refusal runs BEFORE any read-for-write or write, including the idempotency claim. Posting rules
 * are unchanged. Reopening a door needs its own implementation, review, certification, deployment and
 * separate owner approval. Leaf module (no Convex imports) so the historical lifecycle suites can open
 * the door with `vi.mock` plus `test-utils/supplierSettlementSwitches.ts`; Arabic lives under
 * `ServerError_<code>` in lib/i18n/domains/common.ts.
 */
export const SUPPLIER_SETTLEMENT_DOORS_PILOT_DISABLED = {
  /** supplierCostRecoveries.reverseReceipt: the only public reversal in the supplier settlement family. */
  SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED: true,
  /** vehicles.correctAcquisitionCost: only the branch that rewrites an unpaid ON_ACCOUNT supplier payable. */
  SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED: true,
  /** expenses.reverseExpense: only when the expense has a live supplier cost recovery (the supplier owes it). */
  SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED: true,
} as const;
export type SupplierSettlementDoorCode = keyof typeof SUPPLIER_SETTLEMENT_DOORS_PILOT_DISABLED;

export const SUPPLIER_SETTLEMENT_DOOR_REFUSALS = {
  SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED:
    "Reversing a supplier cost-recovery receipt is not available during the pilot. Record any further money received as a new receipt. Nothing has been changed.",
  SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED:
    "Correcting the amount of an unpaid supplier payable is not available during the pilot. Pay the payable as recorded and ask your accountant about any difference. Nothing has been changed.",
  SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED:
    "Reversing an expense the supplier owes the dealership for is not available during the pilot. Record any money received from the supplier as a receipt. Nothing has been changed.",
} as const satisfies Record<SupplierSettlementDoorCode, string>;

/**
 * Methods the consignment margin receipt (`supplierReceivables.recordReceipt`) accepts in the pilot.
 * A cheque posts Dr cheques-in-hand / Cr 1240 but this door creates no `postDatedCheques` custody row, so
 * the instrument has no deposit, clearance or bounce lifecycle (ACC-3); a card receipt has no settlement
 * flow here either. Same scope as `supplierCostRecoveries.recordReceipt`. Not a door switch: reopening
 * cheque receipts needs the custody lifecycle built, certified and approved by the owner.
 */
export const SUPPLIER_RECEIPT_PILOT_METHODS = ["CASH", "BANK_TRANSFER"] as const;
export type SupplierReceiptPilotMethod = (typeof SUPPLIER_RECEIPT_PILOT_METHODS)[number];

export const SUPPLIER_RECEIPT_METHOD_REFUSAL =
  "During the pilot a supplier margin receipt can be recorded in cash or by bank transfer only. Cheque and card receipts are not available. Nothing has been recorded.";

export function isSupplierReceiptPilotMethod(method: string): method is SupplierReceiptPilotMethod {
  return (SUPPLIER_RECEIPT_PILOT_METHODS as readonly string[]).includes(method);
}

/** Refuses a margin receipt method outside the pilot set, before the idempotency claim or any write. */
export function assertSupplierReceiptMethodAllowed(method: string): void {
  if (!isSupplierReceiptPilotMethod(method)) {
    throwAppError(AppErrorCode.SUPPLIER_RECEIPT_METHOD_PILOT_UNSUPPORTED, SUPPLIER_RECEIPT_METHOD_REFUSAL);
  }
}

/** Read-only availability for screens; enforcement remains in the mutation. */
export function isSupplierSettlementDoorDisabled(code: SupplierSettlementDoorCode): boolean {
  return SUPPLIER_SETTLEMENT_DOORS_PILOT_DISABLED[code];
}

export function assertSupplierSettlementDoorAllowed(code: SupplierSettlementDoorCode): void {
  if (isSupplierSettlementDoorDisabled(code)) {
    throwAppError(AppErrorCode[code], SUPPLIER_SETTLEMENT_DOOR_REFUSALS[code]);
  }
}
