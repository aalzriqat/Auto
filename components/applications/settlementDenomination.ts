import { denominationOf } from "@/convex/utils/money";

/**
 * TEMPORARY UI CONTAINMENT — SCRUM-215 SN3-1, blocked on the canonical
 * settlement fix under SCRUM-241 (owner-proxy ruling 2026-09-11 10:50).
 *
 * A financed deal's settlement is recorded in the currency PINNED on the
 * application (`financeApplications.economicsCurrency`), and `orgSettings`
 * does not count a finance application among the rows that lock the org's
 * currency. So an org can pin a deal in JOD, switch to USD, and finalize:
 * `finalizeDeal` opens the finance-company receivable in JOD, while
 * `confirmDisbursement` builds the receipt, payment and allocation in the
 * org's CURRENT currency — and the allocation's currency assertion refuses.
 * Nothing commits (the mutation is atomic), and nothing ever can: the deal
 * is a settlement dead end from either surface.
 *
 * Reproduced, not reasoned: `convex/sn31CurrencyMismatchRepro.test.ts`.
 *
 * Until the backend owner proves one recorded settlement amount+currency
 * drives receipt, payment, allocation and GL, this screen withholds the
 * action that is certain to be refused and says why — and withholds the
 * finalization that would build such a receivable in the first place. It
 * does NOT convert, relabel or guess money, and it does not suggest changing
 * the org currency as a repair (that is refused after posting anyway, and is
 * not a conversion of a recorded debt before it).
 */
export type SettlementDenominationRefusal = "MISMATCH" | "UNSUPPORTED";

/**
 * Why the pinned denomination cannot be settled against the org's current
 * currency — or `undefined` when it can.
 *
 * An ABSENT pin is not a refusal: every writer resolves it as
 * `app.economicsCurrency ?? org`, so a frozen figure on such a row was built
 * in the org currency by construction, and the org currency cannot change
 * after the sale has posted. That is the server's rule, not a guess made here.
 */
export function settlementDenominationRefusal(
  pinnedCurrency: string | undefined,
  orgCurrencyCode: string
): SettlementDenominationRefusal | undefined {
  if (pinnedCurrency === undefined) return undefined;
  // Canonical spelling only — the same rule the writers assert. "JD", "jod"
  // and "" are all PRESENT and meaningless, and would scale by a guessed
  // fallback.
  if (denominationOf(pinnedCurrency) === null) return "UNSUPPORTED";
  return pinnedCurrency === orgCurrencyCode ? undefined : "MISMATCH";
}

/** Why the dealership receipt is withheld, one key per refusal. */
export const DISBURSEMENT_DENOMINATION_REASON: Record<SettlementDenominationRefusal, string> = {
  MISMATCH: "DisbursementCurrencyMismatch",
  UNSUPPORTED: "DisbursementCurrencyUnsupported",
};

/** Why the close is withheld, one key per refusal. */
export const FINALIZE_DENOMINATION_REASON: Record<SettlementDenominationRefusal, string> = {
  MISMATCH: "FinalizeCurrencyMismatch",
  UNSUPPORTED: "FinalizeCurrencyUnsupported",
};
