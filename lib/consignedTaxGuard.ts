/**
 * Whether the sale form must refuse a deal before it reaches the server.
 *
 * Agency sales have no agreed tax treatment yet, so `consignedAgentSaleLines`
 * refuses to post one — deliberately, because every available posting either
 * misstates money or invents tax policy (the rule states the full reasoning).
 *
 * Left to the server alone, an operator meets that refusal as a save that
 * fails, on a form whose only fix is clearing a tax field they have no reason
 * to suspect. Worse, the refusal is not always a refusal: sale completion
 * posts through `postOrEnqueue`, which posts immediately when an open period
 * exists and otherwise enqueues to the outbox. With no open period the sale is
 * recorded, the journal dead-letters on the next drain, and nobody is told —
 * so this guard is the only thing standing between a taxed consigned deal and
 * a sale on the books with no accounting behind it.
 *
 * A code rather than a sentence: the form renders it in Arabic or English.
 */
export type ConsignedTaxRefusal = "CONSIGNED_TAX_UNSUPPORTED";

export function consignedTaxRefusal(input: {
  /** The selected vehicle's basis. Unknown (still loading) is not a refusal. */
  isSourced: boolean | undefined;
  taxAmount: number | undefined;
  /** A draft posts nothing, so a draft has nothing to refuse. */
  status: "PENDING" | "COMPLETED";
}): ConsignedTaxRefusal | null {
  if (input.status !== "COMPLETED") return null;
  if (input.isSourced !== true) return null;
  const tax = input.taxAmount;
  // `Number.isFinite` rather than `> 0` alone: an empty numeric input reads
  // back as NaN, and NaN fails every comparison, so a bare `tax > 0` would let
  // it through here and Convex would accept it as a `v.number()` downstream.
  if (typeof tax !== "number" || !Number.isFinite(tax) || tax <= 0) return null;
  return "CONSIGNED_TAX_UNSUPPORTED";
}
