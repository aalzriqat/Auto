/**
 * The closed vocabulary of closing-readiness reasons (SCRUM-414).
 *
 * `applications.getClosingReadiness` and a refused `finalizeDeal` name WHY a
 * deal is not ready with one of these codes plus its params; the deal screen
 * translates the code (`ClosingReason_<CODE>` in `lib/i18n/domains/sales.ts`)
 * and fills the params. The server never authors Arabic, and the client never
 * translates the server's English: the English sentence still travels as a
 * diagnostic.
 *
 * ONE list, shared by the server and the dictionary test, so a code the
 * server can emit cannot ship without both translations — each with exactly
 * the placeholders declared for it here.
 */

/** The accounting conditions a financed deal must meet before it can be finalized. */
export const CLOSING_READINESS_CHECK_KEYS = [
  "REMITTANCE_KNOWN",
  "CONFIGURED_FEES_RECORDED",
  "CUSTODY_ON_LEDGER",
  "CUSTODY_SETTLED",
  "COSTS_CLOSABLE",
  "HANDOVER_COSTS_PAID",
  "FIRST_PAYMENT_RECORDED",
  "LEGAL_INVOICE_RECORDED",
] as const;

export type ClosingReadinessCheckKey = (typeof CLOSING_READINESS_CHECK_KEYS)[number];

/** Every code the evaluator can state, with the names of the params its translation is filled with. */
export const CLOSING_READINESS_REASON_PARAMS = {
  // REMITTANCE_KNOWN
  REMITTANCE_APPROVAL_MISSING: [],
  REMITTANCE_UNKNOWN: [],
  // The one bounded read of the deal's cost lines and custody records.
  DEAL_ROWS_TOO_MANY_COST_LINES: ["max"],
  DEAL_ROWS_TOO_MANY_CUSTODY_RECORDS: ["max"],
  // CONFIGURED_FEES_RECORDED
  CONFIGURED_FEES_POLICY_OVER_CAPACITY: ["templateCount", "max"],
  CONFIGURED_FEES_MISSING: ["count"],
  // CUSTODY_ON_LEDGER — deliberately coarse: the ledger proof has many
  // refusals whose detail (keys, versions, outbox errors) stays in the diagnostic.
  CUSTODY_NOT_ON_LEDGER: [],
  CUSTODY_LEDGER_UNVERIFIABLE: [],
  // CUSTODY_SETTLED
  CUSTODY_OPEN: [],
  CUSTODY_NO_LONGER_BALANCES: [],
  CUSTODY_CURRENCY_MISMATCH: ["lineCurrency", "custodyCurrency"],
  CUSTODY_AMOUNT_UNREADABLE: [],
  // COSTS_CLOSABLE
  COSTS_NONE: [],
  COSTS_FOREIGN_CURRENCY: ["count", "currency"],
  COSTS_AMOUNT_UNREADABLE: [],
  COSTS_AWAITING_ACTUAL: ["count"],
  COSTS_AWAITING_RECONCILIATION: ["count"],
  COSTS_NOT_RECONCILED: [],
  COSTS_TREATMENT_UNMAPPED: ["feeLabel", "treatment"],
  // HANDOVER_COSTS_PAID (SCRUM-443) — every dealer-borne handover cost is
  // either charged to the employee custody that paid it or paid directly by
  // the dealership. Which lines is served beside the reason (`feeIds`).
  HANDOVER_COSTS_NO_ACTUAL: ["count"],
  HANDOVER_COSTS_UNPAID: ["count"],
  HANDOVER_COSTS_CONFLICT: ["count"],
  // A REAL dealer-borne cost no supported source can pay (SCRUM-443 v6): its
  // treatment posts nowhere, or it is withheld from a settlement no configured
  // plan recognises. It would reach no ledger account, so it blocks closing.
  HANDOVER_COSTS_UNSUPPORTED_TREATMENT: ["count"],
  HANDOVER_COSTS_DEDUCTION_NOT_RECOGNISED: ["count"],
  // A direct payment is recorded on the line but is not (yet) on the ledger:
  // its posting is queued (no open accounting period), failed, or an earlier
  // version's reversal has not landed.
  HANDOVER_DIRECT_NOT_ON_LEDGER: ["count"],
  // A direct payment that was TAKEN BACK on its line (removed, set to zero,
  // replaced) is still on the ledger: its reversal is waiting for an accounting
  // period to open. The row no longer says it was paid; the ledger does.
  HANDOVER_DIRECT_REVERSAL_PENDING: ["count"],
  // The ledger could not be read completely, so "on the books" cannot be proven.
  HANDOVER_DIRECT_LEDGER_UNVERIFIABLE: [],
  // FIRST_PAYMENT_RECORDED
  FIRST_PAYMENT_MISSING: [],
  // LEGAL_INVOICE_RECORDED
  LEGAL_INVOICE_MISSING: [],
  LEGAL_INVOICE_UNUSABLE: [],
  LEGAL_INVOICE_WRONG_RECIPIENT: [],
  // A check refused for a reason the evaluator does not classify.
  CHECK_REFUSED: [],
  // No verdict could be formed (`getClosingReadiness.unavailableReason`).
  READINESS_CURRENCY_DRIFT: ["recordedCurrency", "orgCurrency"],
  READINESS_INPUTS_UNAVAILABLE: [],
  // `finalizeDeal` refused with no unmet check named.
  NOT_READY: [],
} as const satisfies Record<string, readonly string[]>;

/** A code the evaluator states (as opposed to one the redaction substitutes). */
export type StatedClosingReadinessReasonCode = keyof typeof CLOSING_READINESS_REASON_PARAMS;

/**
 * Below the finance tier: the verdict is served, the detail and every param
 * are not. One per check, plus one for a verdict that could not be formed.
 */
export const WITHHELD_CLOSING_READINESS_REASON_CODES = [
  ...CLOSING_READINESS_CHECK_KEYS.map((key) => `WITHHELD_${key}` as const),
  "WITHHELD_UNAVAILABLE",
] as const;

export type WithheldClosingReadinessReasonCode = (typeof WITHHELD_CLOSING_READINESS_REASON_CODES)[number];

export type ClosingReadinessReasonCode = StatedClosingReadinessReasonCode | WithheldClosingReadinessReasonCode;

export const CLOSING_READINESS_REASON_CODES: readonly ClosingReadinessReasonCode[] = [
  ...(Object.keys(CLOSING_READINESS_REASON_PARAMS) as StatedClosingReadinessReasonCode[]),
  ...WITHHELD_CLOSING_READINESS_REASON_CODES,
];

/** The withheld code standing in for one check's reason. */
export function withheldReasonCode<K extends ClosingReadinessCheckKey>(key: K): `WITHHELD_${K}` {
  return `WITHHELD_${key}`;
}

/** The param names a code's translation is filled with (none for a withheld code). */
export function closingReasonParamNames(code: ClosingReadinessReasonCode): readonly string[] {
  return code in CLOSING_READINESS_REASON_PARAMS
    ? CLOSING_READINESS_REASON_PARAMS[code as StatedClosingReadinessReasonCode]
    : [];
}

/** Values interpolated into a translated reason. Never money for a caller below the finance tier. */
export type ClosingReadinessReasonParams = Record<string, string | number>;

/**
 * A readiness reason as the server states it: the code the screen translates,
 * its params, and the English sentence kept as the diagnostic. Structurally an
 * `AppErrorData` (`convex/utils/errors.ts`) plus `params`, so a refused
 * finalize throws it as-is.
 */
export type ClosingReadinessReason = {
  code: ClosingReadinessReasonCode;
  params?: ClosingReadinessReasonParams;
  message: string;
};

type ParamNamesOf<C extends ClosingReadinessReasonCode> = C extends StatedClosingReadinessReasonCode
  ? (typeof CLOSING_READINESS_REASON_PARAMS)[C][number]
  : never;

/** The params argument `reasonOf` requires for `C`: exactly its declared names, or nothing. */
type ParamsArgOf<C extends ClosingReadinessReasonCode> = [ParamNamesOf<C>] extends [never]
  ? []
  : [params: Record<ParamNamesOf<C>, string | number>];

/** A coded readiness reason with its English diagnostic; params only where the code declares them. */
export function reasonOf<C extends ClosingReadinessReasonCode>(
  code: C,
  message: string,
  ...[params]: ParamsArgOf<C>
): ClosingReadinessReason {
  return params === undefined ? { code, message } : { code, params, message };
}

/**
 * The English that stands in the `reason` field for a withheld reason. The
 * screen always translates the WITHHELD_* code; this is only the diagnostic,
 * and deliberately says nothing about the deal.
 */
export const WITHHELD_READINESS_REASON_FALLBACK = "Detail withheld: finance access is required to see it.";

/**
 * THE redaction of a readiness reason (SCRUM-117, SCRUM-414) — one pure
 * function for every door that states one: `getClosingReadiness` and a refused
 * `finalizeDeal` alike. Below the finance tier a reason becomes `withheldCode`
 * with NO params and none of the evaluator's text: a param can be a currency
 * or an amount, so it is withheld with the sentence it fills. The screen
 * translates the WITHHELD code; the English left in `message` is a fixed
 * sentence that says nothing about the deal.
 */
export function redactClosingReason(
  reason: ClosingReadinessReason,
  mayReadMoney: boolean,
  withheldCode: WithheldClosingReadinessReasonCode
): ClosingReadinessReason;
export function redactClosingReason(
  reason: ClosingReadinessReason | null,
  mayReadMoney: boolean,
  withheldCode: WithheldClosingReadinessReasonCode
): ClosingReadinessReason | null;
export function redactClosingReason(
  reason: ClosingReadinessReason | null,
  mayReadMoney: boolean,
  withheldCode: WithheldClosingReadinessReasonCode
): ClosingReadinessReason | null {
  if (reason === null || mayReadMoney) return reason;
  return { code: withheldCode, message: WITHHELD_READINESS_REASON_FALLBACK };
}

/**
 * A refusal tagged with the check that refused, or `null` when no single check
 * is named (no verdict could be formed). The key picks the WITHHELD code a
 * caller below the finance tier is given instead.
 */
export type TaggedClosingRefusal = {
  key: ClosingReadinessCheckKey | null;
  reason: ClosingReadinessReason;
};

/** The reason a caller may be told for `refusal`: stated in full, or its WITHHELD code. */
export function redactClosingRefusal(refusal: TaggedClosingRefusal, mayReadMoney: boolean): ClosingReadinessReason {
  return redactClosingReason(
    refusal.reason,
    mayReadMoney,
    refusal.key === null ? "WITHHELD_UNAVAILABLE" : withheldReasonCode(refusal.key)
  );
}

const KNOWN = new Set<string>(CLOSING_READINESS_REASON_CODES);

export function isClosingReadinessReasonCode(value: unknown): value is ClosingReadinessReasonCode {
  return typeof value === "string" && KNOWN.has(value);
}

/** The dictionary key a code is translated under. */
export function closingReasonMessageKey(code: ClosingReadinessReasonCode): `ClosingReason_${ClosingReadinessReasonCode}` {
  return `ClosingReason_${code}`;
}

/**
 * The coded reason a refused `finalizeDeal` carries in its `ConvexError.data`,
 * or null when the error is anything else (an older server's plain string, a
 * transport failure, an unknown code).
 */
export function closingReadinessRefusalOf(data: unknown): ClosingReadinessReason | null {
  if (typeof data !== "object" || data === null) return null;
  const { code, message, params } = data as { code?: unknown; message?: unknown; params?: unknown };
  if (!isClosingReadinessReasonCode(code) || typeof message !== "string") return null;
  if (params === undefined) return { code, message };
  if (typeof params !== "object" || params === null) return null;
  return { code, message, params: params as ClosingReadinessReasonParams };
}
