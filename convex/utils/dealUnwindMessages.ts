/**
 * SCRUM-693: the coded refusals of unwinding a paid finance deal.
 *
 * The English text is the server's own `message`; `lib/i18n/domains/sales.ts`
 * carries the same sentence and its Arabic under `ServerError_<code>`, and
 * `lib/errors.test.ts` holds the two together. Static on purpose: no amounts,
 * no ids, no placeholders.
 */
export const DEAL_UNWIND_MESSAGES = {
  DEAL_CANCEL_USE_UNWIND:
    "This deal has a recorded finance-company payment. Open Unwind deal on this page to reverse it before cancelling.",
  DEAL_UNWIND_ACTIVE:
    "This deal is being unwound. Finish or abandon the unwind on the deal page first. Nothing has been changed.",
  DEAL_UNWIND_NOT_FOUND:
    "The deal or its unwind could not be found. Nothing has been changed.",
  DEAL_UNWIND_NOT_ELIGIBLE:
    "Only a finalized deal whose finance-company payment was received by bank transfer or cash can be unwound here. Nothing has been changed.",
  DEAL_UNWIND_CHEQUE_DEAL:
    "This deal was paid by cheque. Record the returned cheque from the deal page instead. Nothing has been changed.",
  DEAL_UNWIND_DIRECT_ROUTE:
    "The finance company paid the supplier directly on this deal, so it cannot be unwound here. An accountant reviews the deal. Nothing has been changed.",
  DEAL_UNWIND_SALE_NOT_COMPLETED:
    "This deal's sale is not completed, so there is nothing to unwind. An accountant reviews the deal. Nothing has been changed.",
  DEAL_UNWIND_COMMISSION_PAID:
    "The salesperson's commission on this deal has already been paid. Recovering it is not supported yet; an accountant reviews the deal. Nothing has been changed.",
  DEAL_UNWIND_OPEN_CUSTODY:
    "An employee still holds cash custody on this deal. Settle that custody record before unwinding the deal. Nothing has been changed.",
  DEAL_UNWIND_ALREADY_ACTIVE:
    "An unwind of this deal is already in progress. Continue it on the deal page. Nothing has been changed.",
  DEAL_UNWIND_REASON_REQUIRED:
    "Give the reason for this step. Nothing has been changed.",
  DEAL_UNWIND_TEXT_TOO_LONG:
    "One of the entered texts is too long. Shorten it and try again. Nothing has been changed.",
  DEAL_UNWIND_NOT_ACTIVE:
    "This unwind is already finished or abandoned. Nothing has been changed.",
  DEAL_UNWIND_STEP_DONE:
    "This step of the unwind is already recorded. Nothing has been changed.",
  DEAL_UNWIND_FORWARD_NOT_APPLICABLE:
    "Nothing was paid to the finance company on this deal, so there is no return to record. Continue with the refund. Nothing has been changed.",
  DEAL_UNWIND_FORWARD_UNSETTLED:
    "The payment to the finance company is not settled on the books. An accountant resolves it before the unwind can continue. Nothing has been changed.",
  DEAL_UNWIND_FORWARD_REVERSAL_UNPROVEN:
    "The return of the payment to the finance company could not be confirmed as posted on the books, so it was not recorded. Nothing has been changed. An accountant reviews the deal.",
  DEAL_UNWIND_PERIOD_NOT_OPEN:
    "Today's accounting period is not open, so the reversal cannot be posted now. An accountant opens the period first. Nothing has been changed.",
  DEAL_UNWIND_FORWARD_FIRST:
    "Record and settle the finance company's return of the forwarded payment before continuing.",
  DEAL_UNWIND_EVIDENCE_REQUIRED:
    "Enter the required reference: the bank reference for a transfer, or the voucher number and the recipient's acknowledgement for cash. Nothing has been changed.",
  DEAL_UNWIND_INVALID_DATE:
    "The date must be a real date and cannot be in the future. Nothing has been changed.",
  DEAL_UNWIND_REFUND_METHOD_MISMATCH:
    "The refund must go back the same way the finance company's payment was received (bank transfer or cash). Nothing has been changed.",
  DEAL_UNWIND_STALE:
    "The deal's recorded payment changed since this unwind started. Abandon this unwind and start again. Nothing has been changed.",
  DEAL_UNWIND_CHAIN_MISMATCH:
    "The finance company's payment does not match the deal's recorded receipt (amount, date, currency or payer). Nothing has been changed. An accountant reviews the deal.",
  DEAL_UNWIND_ALLOCATION_SHAPE:
    "The finance company's payment is not allocated exactly to this deal's receivable, so it cannot be reversed safely. Nothing has been changed. An accountant reviews the deal.",
  DEAL_UNWIND_REVERSAL_UNPROVEN:
    "The finance company's receipt could not be confirmed as reversed on the books, so the refund was not recorded. Nothing has been changed. An accountant reviews the deal.",
  DEAL_UNWIND_DISPOSITION_REQUIRED:
    "Choose what happens to the customer's payment (refund or keep as credit) and fill in the credit note and the vehicle return. Nothing has been changed.",
} as const;

export type DealUnwindRefusalCode = keyof typeof DEAL_UNWIND_MESSAGES;
