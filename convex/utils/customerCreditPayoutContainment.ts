import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-724 / SCRUM-795: pilot containment of the NEW customer-credit payout.
 *
 * Owner SCRUM-795 c22479 (2026-10-08): keep the existing, supported deposit and
 * collection refund-recording paths; do not activate a new retained-credit payout
 * authority during the pilot. Sol ruling Q7 (2026-10-12): the customer REFUND
 * disposition of a deal unwind (`dealUnwind.finishDealUnwind`) and of a cash-sale
 * cancellation (`sales.update`) is such a new payout. Both reach the one shared
 * boundary `disposeActiveSaleInvoiceReceipts`, which reads this switch.
 *
 * To re-enable (a reviewed code change plus a manual Convex deploy, never an
 * env var): set this to `false`. Before doing so, every payout door must keep
 * requiring MANAGE_FINANCE (deal-cancel permissions are additional, not
 * substitutes) and CASH must first get a linked collectionPayments OUT row bound
 * to `collections.readCashierDayCashPayments` and SCRUM-396 (see
 * `assertCustomerCreditPayoutMethodSupported`).
 *
 * LEAF MODULE: imports only `./errors`.
 */
export const CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED = true as const;

export const CUSTOMER_CREDIT_PAYOUT_REFUSALS = {
  CUSTOMER_CREDIT_PAYOUT_DISABLED:
    "Paying customer credit out is not available during the pilot. Keep it as customer credit instead. Nothing has been changed.",
  CUSTOMER_CREDIT_CASH_PAYOUT_UNSUPPORTED:
    "A cash payout of customer credit is not supported yet. Use a bank transfer. Nothing has been changed.",
} as const satisfies Record<string, string>;

export function refuseCustomerCreditPayout(
  code: keyof typeof CUSTOMER_CREDIT_PAYOUT_REFUSALS
): never {
  return throwAppError(AppErrorCode[code], CUSTOMER_CREDIT_PAYOUT_REFUSALS[code]);
}

/** Refuses any positive payout while the pilot switch is on. `disabled` is for tests of the pure guard only. */
export function assertCustomerCreditPayoutAllowed(
  disabled: boolean = CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED
): void {
  if (disabled) refuseCustomerCreditPayout("CUSTOMER_CREDIT_PAYOUT_DISABLED");
}

/**
 * Defence in depth that survives the switch being turned off. A CASH payout
 * writes only a canonicalPayments OUT row and the RETAINED_CREDIT_REFUNDED
 * journal: no collectionPayments row, so cashier-day reconciliation
 * (`collections.readCashierDayCashPayments`) would silently omit the cash that
 * left the drawer. Do not call hookCollectionRefund to fix this: its DR AR rule
 * is wrong for the 2110 liability.
 */
export function assertCustomerCreditPayoutMethodSupported(method: string): void {
  if (method !== "BANK_TRANSFER") refuseCustomerCreditPayout("CUSTOMER_CREDIT_CASH_PAYOUT_UNSUPPORTED");
}
