/**
 * The closed vocabulary of closing-readiness reasons (SCRUM-414).
 *
 * `applications.getClosingReadiness` and a refused `finalizeDeal` name WHY a
 * deal is not ready with one of these codes plus its params; the deal screen
 * translates the code (`ClosingReason_<CODE>` in `lib/i18n/domains/sales.ts`)
 * and fills the params. The server never authors Arabic, and the client never
 * translates the server's English: the English sentence still travels as a
 * diagnostic, and is what the screen shows for a code it does not know.
 *
 * ONE list, shared by the server and the dictionary test, so a code the
 * server can emit cannot ship without both translations.
 */
export const CLOSING_READINESS_REASON_CODES = [
  // REMITTANCE_KNOWN
  "REMITTANCE_APPROVAL_MISSING",
  "REMITTANCE_UNKNOWN",
  // The one bounded read of the deal's cost lines and custody records.
  "DEAL_ROWS_TOO_MANY_COST_LINES", // {max}
  "DEAL_ROWS_TOO_MANY_CUSTODY_RECORDS", // {max}
  // CONFIGURED_FEES_RECORDED
  "CONFIGURED_FEES_POLICY_OVER_CAPACITY", // {templateCount, max}
  "CONFIGURED_FEES_MISSING", // {count}
  // CUSTODY_ON_LEDGER — deliberately coarse: the ledger proof has many
  // refusals whose detail (keys, versions, outbox errors) stays in the diagnostic.
  "CUSTODY_NOT_ON_LEDGER",
  "CUSTODY_LEDGER_UNVERIFIABLE",
  // CUSTODY_SETTLED
  "CUSTODY_OPEN",
  "CUSTODY_NO_LONGER_BALANCES",
  "CUSTODY_CURRENCY_MISMATCH", // {lineCurrency, custodyCurrency}
  "CUSTODY_AMOUNT_UNREADABLE",
  // COSTS_CLOSABLE
  "COSTS_NONE",
  "COSTS_FOREIGN_CURRENCY", // {count, currency}
  "COSTS_AMOUNT_UNREADABLE",
  "COSTS_AWAITING_ACTUAL", // {count}
  "COSTS_AWAITING_RECONCILIATION", // {count}
  "COSTS_NOT_RECONCILED",
  "COSTS_TREATMENT_UNMAPPED", // {feeLabel, treatment}
  // FIRST_PAYMENT_RECORDED
  "FIRST_PAYMENT_MISSING",
  // LEGAL_INVOICE_RECORDED
  "LEGAL_INVOICE_MISSING",
  "LEGAL_INVOICE_UNUSABLE",
  "LEGAL_INVOICE_WRONG_RECIPIENT",
  // A check refused for a reason the evaluator does not classify.
  "CHECK_REFUSED",
  // No verdict could be formed (`getClosingReadiness.unavailableReason`).
  "READINESS_CURRENCY_DRIFT", // {recordedCurrency, orgCurrency}
  "READINESS_INPUTS_UNAVAILABLE",
  // `finalizeDeal` refused with no unmet check named.
  "NOT_READY",
  // Below the finance tier: the verdict is served, the detail and every param are not.
  "WITHHELD_REMITTANCE_KNOWN",
  "WITHHELD_CONFIGURED_FEES_RECORDED",
  "WITHHELD_CUSTODY_ON_LEDGER",
  "WITHHELD_CUSTODY_SETTLED",
  "WITHHELD_COSTS_CLOSABLE",
  "WITHHELD_FIRST_PAYMENT_RECORDED",
  "WITHHELD_LEGAL_INVOICE_RECORDED",
  "WITHHELD_UNAVAILABLE",
] as const;

export type ClosingReadinessReasonCode = (typeof CLOSING_READINESS_REASON_CODES)[number];

/** Values interpolated into a translated reason. Never money for a caller below the finance tier. */
export type ClosingReadinessReasonParams = Record<string, string | number>;

/**
 * A readiness reason as the server states it: the code the screen translates,
 * its params, and the English sentence kept as the diagnostic and fallback.
 */
export interface ClosingReadinessReason {
  code: ClosingReadinessReasonCode;
  params?: ClosingReadinessReasonParams;
  message: string;
}

const KNOWN = new Set<string>(CLOSING_READINESS_REASON_CODES);

export function isClosingReadinessReasonCode(value: unknown): value is ClosingReadinessReasonCode {
  return typeof value === "string" && KNOWN.has(value);
}

/** The dictionary key a code is translated under. */
export function closingReasonMessageKey(code: ClosingReadinessReasonCode): `ClosingReason_${ClosingReadinessReasonCode}` {
  return `ClosingReason_${code}`;
}
