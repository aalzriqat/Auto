import { Doc, Id } from "../_generated/dataModel";

/**
 * SCRUM-373 D2 — applying the originating quote's down payment to an approved
 * financed deal whose stored customer first payment is a confident zero.
 *
 * ONE predicate, read by the mutation that refuses and by the cockpit that
 * decides whether to offer the action, so the screen cannot offer what the
 * server refuses (or hide what it would accept).
 *
 * The population is deliberately narrow: an APPROVED deal (so the split exists
 * and would be recomputed) whose stored first payment is EXACTLY zero, before
 * handover, on a non-terminal application. Everything else already has a path
 * — before approval, `recordSubmittedQuotation`; after handover, cancel and
 * re-open — and widening this writer would make it a second, free-valued way to
 * move a financing term.
 */

/**
 * The reconciliation reason `recomputeAndPatchEconomics` appends while the
 * first payment is UNKNOWN. A later re-record can store a zero without clearing
 * it, so the correction removes exactly this sentence and nothing else.
 */
export const FIRST_PAYMENT_NOT_RECORDED_REASON =
  "The customer's first payment is not recorded on this deal. Record it before relying on the funding split.";

export type FirstPaymentCorrectionBlock =
  | "NOT_PERMITTED"
  | "OWN_APPLICATION"
  | "TERMINAL"
  | "HANDED_OVER"
  | "NOT_APPROVED"
  | "NOT_ZERO"
  | "NO_QUOTE_DOWN_PAYMENT"
  | "SPLIT_UNKNOWN"
  | "EXCEEDS_UNFINANCED";

export function firstPaymentCorrectionBlock(input: {
  app: Pick<
    Doc<"financeApplications">,
    | "status"
    | "vehicleHandoverAt"
    | "approvedDealerPurchaseAmountMinor"
    | "customerFirstPaymentMinor"
    | "unfinancedPortionMinor"
    | "salespersonId"
  >;
  actorId: Id<"users">;
  mayApprove: boolean;
  /** The owned originating quote's down payment in the deal's minor units, or undefined when unreadable. */
  quoteDownPaymentMinor: number | undefined;
}): FirstPaymentCorrectionBlock | null {
  const { app } = input;
  if (!input.mayApprove) return "NOT_PERMITTED";
  if (input.actorId === app.salespersonId) return "OWN_APPLICATION";
  if (app.status === "CLOSED" || app.status === "CANCELLED") return "TERMINAL";
  if (app.vehicleHandoverAt) return "HANDED_OVER";
  if (app.approvedDealerPurchaseAmountMinor === undefined) return "NOT_APPROVED";
  if (app.customerFirstPaymentMinor !== 0) return "NOT_ZERO";
  if (input.quoteDownPaymentMinor === undefined || input.quoteDownPaymentMinor <= 0) {
    return "NO_QUOTE_DOWN_PAYMENT";
  }
  // Independent of the first payment (computeFundingComposition), so the stored
  // figure is the one the new payment is judged against.
  if (app.unfinancedPortionMinor === undefined) return "SPLIT_UNKNOWN";
  // The dealer ruled the case payment ≤ unfinanced only: above it the formula
  // reduces the financier's funded portion, which is a different deal.
  if (input.quoteDownPaymentMinor > app.unfinancedPortionMinor) return "EXCEEDS_UNFINANCED";
  return null;
}

export const FIRST_PAYMENT_CORRECTION_REFUSALS: Record<FirstPaymentCorrectionBlock, string> = {
  NOT_PERMITTED:
    "Applying the quote's down payment needs both finance visibility and approval authority.",
  OWN_APPLICATION:
    "You cannot correct the first payment on your own application. A manager or the dealership owner corrects it.",
  TERMINAL: "This application is closed. Its first payment can no longer be corrected here.",
  HANDED_OVER:
    "The vehicle has already been handed over on this deal, so its first payment can no longer be corrected here.",
  NOT_APPROVED:
    "This deal has no approved purchase amount yet. Record the first payment with the quotation instead.",
  NOT_ZERO:
    "This deal's first payment is not recorded as exactly zero, so there is nothing to apply the quote's down payment onto.",
  NO_QUOTE_DOWN_PAYMENT: "The originating quote does not carry a down payment to apply.",
  SPLIT_UNKNOWN:
    "This deal's funding split is not established, so the down payment cannot be checked against it.",
  EXCEEDS_UNFINANCED:
    "The quote's down payment is larger than the part of the approved amount the finance company does not fund. Ask the finance manager how this deal was agreed.",
};

