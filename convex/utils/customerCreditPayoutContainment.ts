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

/** Read-only form of the payout switch, for availability flags shown to the UI. */
export function isCustomerCreditPayoutDisabled(
  disabled: boolean = CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED
): boolean {
  return disabled;
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

/**
 * SCRUM-724 Sol 6 (c22938) Q1: the NEW public sale-invoice receipt doors stay
 * dark during the pilot. This is deliberately a SEPARATE switch from
 * `CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED`: one gates money leaving 2110, this
 * gates new claims on 2110 credit (PENDING invoice reservations), and the two
 * are re-enabled by independent, reviewed decisions.
 *
 * Gated: `collections.registerSaleInvoiceCheque`, `reserveSaleInvoiceReceipt`,
 * `activateSaleInvoiceReceipt`, and `recordPayment` WHEN it carries
 * `invoiceSaleId`. `collections.clearCheque` is an existing door and is never
 * refused by this switch (the bank has already moved the money); while it is on,
 * a clearing sale-invoice cheque books unreserved 2110 credit and creates no
 * PENDING reservation.
 *
 * Before turning it off: PENDING invoiceReceiptApplications need an operator
 * release door, and the reservation bound must stay equal to the reversal bound
 * (`MAX_PENDING_APPLICATIONS` = the 100-row return plan).
 */
export const SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED = true as const;

export const SALE_INVOICE_RECEIPT_DOOR_REFUSALS = {
  SALE_INVOICE_RECEIPT_DOORS_DISABLED:
    "Recording or applying customer credit against a sale invoice is not available during the pilot. Nothing has been changed.",
} as const satisfies Record<string, string>;

/** True while the sale-invoice receipt doors are dark. `disabled` is for tests of the pure guard only. */
export function areSaleInvoiceReceiptDoorsDisabled(
  disabled: boolean = SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED
): boolean {
  return disabled;
}

/** Refuses a new sale-invoice receipt producer while the pilot switch is on. Call BEFORE any write. */
export function assertSaleInvoiceReceiptDoorsAllowed(
  disabled: boolean = SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED
): void {
  if (disabled) {
    throwAppError(
      AppErrorCode.SALE_INVOICE_RECEIPT_DOORS_DISABLED,
      SALE_INVOICE_RECEIPT_DOOR_REFUSALS.SALE_INVOICE_RECEIPT_DOORS_DISABLED
    );
  }
}
