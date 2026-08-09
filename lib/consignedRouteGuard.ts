/**
 * Whether the sale form must refuse a consigned deal's settlement route.
 *
 * Paying the supplier directly has no representation on the finance company's
 * side of the settlement yet, so `saleCompletion` refuses `DIRECT_TO_SUPPLIER`
 * on a financed deal at the mutation boundary.
 *
 * This guard exists because the screen once resolved that refusal by itself.
 * The financing control sits below the settlement section in the same form, so
 * an operator could choose DIRECT on a cash deal and then switch it to FINANCED
 * — and an effect rewrote the route to THROUGH_DEALERSHIP off-screen, with no
 * toast and no field error. The server refusal never fired, because by submit
 * time the value was the one route the server accepts.
 *
 * What posted instead was not a smaller mistake than a failed save: a supplier
 * payable for the whole entitlement the dealership does not owe, a customer
 * receivable at the gross it will never collect, and no supplier receivable for
 * the margin the supplier owes it. A settlement route is never chosen by an
 * effect. The operator changes it, or the deal does not go in.
 *
 * A code rather than a sentence: the form renders it in Arabic or English.
 */
export type ConsignedRouteRefusal = "DIRECT_UNSUPPORTED_ON_FINANCED";

export function consignedRouteRefusal(input: {
  /**
   * FINANCED or LEASE, or an application already attached. Mirrors the server's
   * definition in `saleCompletion` — a lease is financed for this purpose.
   */
  financed: boolean;
  /** Unknown (still loading) is not a refusal. */
  route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER" | undefined;
  /**
   * Only a consigned car has a supplier to settle with. Unknown is not a
   * refusal — the preview has not answered yet.
   */
  isConsigned: boolean | undefined;
}): ConsignedRouteRefusal | null {
  if (input.isConsigned !== true) return null;
  if (!input.financed) return null;
  if (input.route !== "DIRECT_TO_SUPPLIER") return null;
  return "DIRECT_UNSUPPORTED_ON_FINANCED";
}
