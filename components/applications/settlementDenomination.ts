import { denominationOf } from "@/convex/utils/money";

/**
 * The currency boundary on a financed deal, as the server enforces it
 * (SCRUM-241, merged with the Accounting RC at main `4dd8a0ad8`), mirrored so
 * the two UI surfaces withhold exactly the actions the backend refuses and
 * name the reason — instead of offering a button whose only outcome is a
 * refusal.
 *
 * Two different rules at two different moments, and they are NOT symmetric:
 *
 *  - BEFORE the sale exists, `finalizeDeal` refuses a deal whose pinned
 *    economics currency (`financeApplications.economicsCurrency`) differs
 *    from the organisation's CURRENT currency: the plan and the receivable
 *    take the pinned currency while the sale's own journal posts in the
 *    org's, so finalizing would recognise the plan's integers under the
 *    wrong label. Nothing is converted, relabelled or clipped; restoring the
 *    org setting makes the same deal finalize. The rule holds for every
 *    pinned deal, financier or not.
 *
 *  - AFTER the sale exists, `confirmDisbursement` settles the finance-company
 *    receivable in the RECEIVABLE'S OWN denomination — the org's current
 *    currency is not consulted again. A later drift of the org setting is
 *    therefore not a refusal on the receipt, and this gate must not withhold
 *    it. What the server still refuses there is a denomination it does not
 *    recognise at all.
 *
 * Both halves are reproduced against the real mutations in
 * `convex/sn31CurrencyMismatchRepro.test.ts`; this module reasons about none
 * of the money, only about which refusal the server would give.
 */
export type FinalizeDenominationRefusal = "MISMATCH" | "UNSUPPORTED";
export type DisbursementDenominationRefusal = "UNSUPPORTED";

/**
 * Why the close would be refused — or `undefined` when it would not.
 *
 * An ABSENT pin is not a refusal: every writer resolves it as
 * `app.economicsCurrency ?? org`, so such a row is in the org currency by
 * construction. That is the server's rule, not a guess made here.
 */
export function finalizeDenominationRefusal(
  pinnedCurrency: string | undefined,
  orgCurrencyCode: string
): FinalizeDenominationRefusal | undefined {
  if (pinnedCurrency === undefined) return undefined;
  // Canonical spelling only — the same rule the writers assert. "JD", "jod"
  // and "" are all PRESENT and meaningless, and would scale by a guessed
  // fallback.
  if (denominationOf(pinnedCurrency) === null) return "UNSUPPORTED";
  return pinnedCurrency === orgCurrencyCode ? undefined : "MISMATCH";
}

/**
 * Why the dealership receipt would be refused — or `undefined` when it would
 * not. The org's current currency is deliberately not an input: the receipt
 * settles the receivable in the denomination it was opened in.
 */
export function disbursementDenominationRefusal(
  pinnedCurrency: string | undefined
): DisbursementDenominationRefusal | undefined {
  if (pinnedCurrency === undefined) return undefined;
  return denominationOf(pinnedCurrency) === null ? "UNSUPPORTED" : undefined;
}

/** Why the dealership receipt is withheld, one key per refusal. */
export const DISBURSEMENT_DENOMINATION_REASON: Record<DisbursementDenominationRefusal, string> = {
  UNSUPPORTED: "DisbursementCurrencyUnsupported",
};

/** Why the close is withheld, one key per refusal. */
export const FINALIZE_DENOMINATION_REASON: Record<FinalizeDenominationRefusal, string> = {
  MISMATCH: "FinalizeCurrencyMismatch",
  UNSUPPORTED: "FinalizeCurrencyUnsupported",
};
