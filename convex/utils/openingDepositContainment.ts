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

/**
 * Row-validation refusals for a named opening deposit (SCRUM-858 LOW, Seat 1). Each is a coded
 * AppError so the screen shows it in the user's language. English text equals the matching
 * `ServerError_<code>` entry in lib/i18n/domains/common.ts (lib/errors.test.ts pins that).
 */
export const OPENING_DEPOSIT_ROW_MESSAGES = {
  OPENING_DEPOSIT_CUSTOMER_NOT_FOUND: "Opening customer not found in this organization.",
  OPENING_DEPOSIT_CUSTOMER_UNAVAILABLE: "Opening customer is unavailable.",
  OPENING_DEPOSIT_SECURITY_NAMES_VEHICLE:
    "Only a reservation deposit can name a vehicle; a security deposit is held against the customer.",
  OPENING_DEPOSIT_VEHICLE_NOT_FOUND: "Opening deposit vehicle not found in this organization.",
  OPENING_DEPOSIT_VEHICLE_NOT_HOLDABLE:
    "An opening reservation deposit must name a live vehicle that the dealership can hold.",
  OPENING_DEPOSIT_DUPLICATE_RESERVATION:
    "An opening reservation deposit may be named only once per customer and vehicle.",
} as const;

export type OpeningDepositRowRefusal = keyof typeof OPENING_DEPOSIT_ROW_MESSAGES;

export function refuseOpeningDepositRow(code: OpeningDepositRowRefusal): never {
  return throwAppError(AppErrorCode[code], OPENING_DEPOSIT_ROW_MESSAGES[code]);
}

// English text equals `ServerError_OPENING_DEPOSIT_DIRECT_POST_REFUSED` in lib/i18n/domains/common.ts.
export const OPENING_DEPOSIT_DIRECT_POST_REFUSED_MESSAGE =
  "Named customer deposits cannot be posted without a second approver. Save the opening balance for approval and ask an accountant to approve it. Nothing has been changed.";

/** True when an opening allocation list names a customer's deposit. */
export function hasNamedOpeningDeposit(
  allocations: ReadonlyArray<{ kind: string }> | undefined
): boolean {
  return allocations?.some((row) => row.kind === "CUSTOMER_DEPOSIT") === true;
}

/**
 * Owner ruling SCRUM-858 c23884: named deposits are real dealer balances and post only after an
 * accountant approves them. The owner's direct route skips the second approver, so it refuses
 * them. Call BEFORE any write: a caught exception in a Convex mutation still commits earlier
 * writes, so this must run ahead of the draft insert.
 */
export function refuseOpeningDepositDirectPost(): never {
  return throwAppError(
    AppErrorCode.OPENING_DEPOSIT_DIRECT_POST_REFUSED,
    OPENING_DEPOSIT_DIRECT_POST_REFUSED_MESSAGE
  );
}
