import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-858 S1 (owner ruling SCRUM-858 c23884): a named opening deposit is
 * customer money that was received before the books opened. The cash is already
 * inside the opening cash/bank lines, so a refund, forfeiture or void would move
 * money the system never recorded receiving. During the narrowed pilot an opening
 * deposit can only be APPLIED to the customer's sale.
 *
 * This is a server-side block, not a UI affordance. It is separate from the
 * switches in `customerCreditPayoutContainment.ts`, which are not edited.
 *
 * LEAF MODULE (SCRUM-302): imports only `./errors`, so any convex module may
 * import it without creating a cycle.
 */

// English text equals `ServerError_OPENING_DEPOSIT_PAYOUT_REFUSED` in lib/i18n/domains/common.ts.
export const OPENING_DEPOSIT_PAYOUT_REFUSED_MESSAGE =
  "This opening deposit cannot be refunded in the pilot. Apply it to the customer's sale. Nothing has been changed.";

/** True for a deposit created from an approved opening balance. */
export function isOpeningDeposit(deposit: { origin?: "OPENING" }): boolean {
  return deposit.origin === "OPENING";
}

export function refuseOpeningDepositPayout(): never {
  return throwAppError(
    AppErrorCode.OPENING_DEPOSIT_PAYOUT_REFUSED,
    OPENING_DEPOSIT_PAYOUT_REFUSED_MESSAGE
  );
}

// English text equals `ServerError_OPENING_DEPOSIT_REVERSAL_REFUSED` in lib/i18n/domains/common.ts.
export const OPENING_DEPOSIT_REVERSAL_REFUSED_MESSAGE =
  "This sale applied a customer's opening deposit, and reversing that application is not available in the pilot. Nothing has been changed.";

/**
 * Reversing the sale would put the deposit back as customer money awaiting a refund-or-forfeit
 * decision, and both are refused for an opening deposit. Refused instead of stranding the money.
 */
export function refuseOpeningDepositReversal(): never {
  return throwAppError(
    AppErrorCode.OPENING_DEPOSIT_REVERSAL_REFUSED,
    OPENING_DEPOSIT_REVERSAL_REFUSED_MESSAGE
  );
}

/** Call BEFORE any read-for-write or patch of a payout, forfeiture or void. */
export function assertNotOpeningDepositPayout(deposit: { origin?: "OPENING" }): void {
  if (isOpeningDeposit(deposit)) refuseOpeningDepositPayout();
}
