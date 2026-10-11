import type { AppErrorCode } from "./errors";

/**
 * SCRUM-724: operator-facing refusals for cancelled-sale cheque credit and its
 * standalone refund. The same text lives in `lib/i18n/domains/sales.ts` as
 * `ServerError_<code>` (EN + AR); callers must throw it through `throwAppError`.
 */
export const RETAINED_CREDIT_MESSAGES = {
  CHEQUE_SALE_CANCELLED_RETURN_TO_CUSTOMER:
    "This cheque belongs to a cancelled sale and was not presented to the bank. Return it to the customer. Nothing has been changed.",
  CHEQUE_RETURN_AFTER_CREDIT_REFUND:
    "Part of this cheque's credit has already been refunded to the customer, so the cheque cannot be returned after clearing. Nothing has been changed. An accountant reviews the case.",
  RETAINED_CREDIT_REFUND_INVALID_AMOUNT:
    "Enter a refund amount greater than zero, in whole minor currency units. Nothing has been changed.",
  RETAINED_CREDIT_REFUND_INSUFFICIENT:
    "The refund is larger than the customer credit that is still available (credit reserved for a sale invoice or already requested is not available). Nothing has been changed.",
  RETAINED_CREDIT_REFUND_NOT_FOUND:
    "Refund request or customer credit not found. Nothing has been changed.",
  RETAINED_CREDIT_REFUND_NOT_PENDING:
    "This refund request has already been decided. Nothing has been changed.",
  RETAINED_CREDIT_REFUND_NOT_APPROVED:
    "This refund request is not approved, or has already been paid. Nothing has been changed.",
  RETAINED_CREDIT_REFUND_RECEIPT_UNPOSTED:
    "The original receipt has not reached the general ledger yet, so its credit cannot be refunded. Nothing has been changed.",
  RETAINED_CREDIT_REFUND_PAYOUT_INVALID:
    "Enter the payout reference (at most 120 characters) and a payout date that is not in the future. Nothing has been changed.",
  RETAINED_CREDIT_REFUND_POSTING_FAILED:
    "The refund could not be posted to the general ledger, so nothing was paid or changed.",
} as const satisfies Partial<Record<AppErrorCode, string>>;

export type RetainedCreditMessageCode = keyof typeof RETAINED_CREDIT_MESSAGES;
