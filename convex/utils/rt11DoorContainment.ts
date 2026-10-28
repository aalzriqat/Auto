import { AppErrorCode, throwAppError } from "./errors";

/**
 * RT11-DOORS / SCRUM-760#c23862 (owner, 2026-10-28).
 * Refuse BEFORE writes, including idempotency claims. Conditional doors call
 * this only at the ruled branch. Posting rules are unchanged. Each door needs
 * its own certification, owner approval and reviewed deployment to reopen.
 * Leaf module; Arabic lives under ServerError_<code> in common.ts.
 */
export const RT11_DOORS_PILOT_DISABLED = {
  CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED: true, // 1: finalized REVERSAL / REIMBURSED
  CUSTODY_WRITEOFF_PILOT_DISABLED: true, // 2: shortage only
  CUSTODY_MIGRATION_PILOT_DISABLED: true, // 3: migrateLegacyCustodyToLedger
  CUSTODY_REOPEN_PILOT_DISABLED: true, // 4: reopenDealCustody
  MANUAL_FINANCE_APPROVAL_PILOT_DISABLED: true, // 5: recordManualFinanceApproval
  EXPECTED_PAYMENT_PAID_PILOT_DISABLED: true, // 6: after payout only
  SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED: true, // 7: amendSupplierDisbursementAdvice
  DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED: true, // 8: payroll stays allowed
  // 9: cashDrawer.approveVariance remains allowed with its existing approval.
  VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED: true, // 10: buyout / conversion
  PAID_LANDED_COST_CHANGE_PILOT_DISABLED: true, // 11: edit / remove / move, not additions
} as const;
export type Rt11DoorCode = keyof typeof RT11_DOORS_PILOT_DISABLED;

export const RT11_DOOR_REFUSALS = {
  CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED: "Reversing or reimbursing custody on a finalized deal is not available during the pilot. Nothing has been changed.",
  CUSTODY_WRITEOFF_PILOT_DISABLED: "Writing off a custody shortage is not available during the pilot. Resolve the shortage before closing the custody record. Nothing has been changed.",
  CUSTODY_MIGRATION_PILOT_DISABLED: "Migrating legacy custody to the ledger is not available during the pilot. Nothing has been changed.",
  CUSTODY_REOPEN_PILOT_DISABLED: "Reopening custody is not available during the pilot. Nothing has been changed.",
  MANUAL_FINANCE_APPROVAL_PILOT_DISABLED: "Manual finance approval is not available during the pilot. Use a configured financier. Nothing has been changed.",
  EXPECTED_PAYMENT_PAID_PILOT_DISABLED: "Correcting an expected payment after payout is not available during the pilot. Nothing has been changed.",
  SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED: "Amending supplier disbursement advice is not available during the pilot. Nothing has been changed.",
  DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED: "Direct commission payout is not available during the pilot. Pay commissions through payroll. Nothing has been changed.",
  VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED: "Changing vehicle ownership is not available during the pilot. Ordinary vehicle edits remain available. Nothing has been changed.",
  PAID_LANDED_COST_CHANGE_PILOT_DISABLED: "Editing, removing or moving a paid landed cost is not available during the pilot. You can add a new cost. Nothing has been changed.",
} as const satisfies Record<Rt11DoorCode, string>;

/** Read-only availability for screens; enforcement remains in the mutation. */
export function isRt11DoorDisabled(code: Rt11DoorCode): boolean {
  return RT11_DOORS_PILOT_DISABLED[code];
}

export function assertRt11DoorAllowed(code: Rt11DoorCode): void {
  if (isRt11DoorDisabled(code)) throwAppError(AppErrorCode[code], RT11_DOOR_REFUSALS[code]);
}
