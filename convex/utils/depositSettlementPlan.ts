import { dealershipCollectsGross, type ConsignedSettlementRoute } from "./vehicleOwnership";
import type { DepositApplicationTreatment } from "./depositApplications";

/**
 * Where a reservation deposit lands when the operator says it forms part of the
 * settlement of this deal — and whether it may land there at all.
 *
 * ## Why this is one function and not two
 *
 * The operator is asked one question: *does this عربون form part of the final
 * settlement of this deal?* They are deliberately NOT asked which account it
 * hits, because that answer is not theirs to give — it follows from the
 * settlement route, the supplier's entitlement and the dealership's margin,
 * every one of which the server already knows and the salesperson does not.
 *
 * The same answer has to be reached twice: once by `consignedSalePreview`, to
 * show what confirming would do, and once by `resolveReservationDeposits`, to
 * actually do it. Computing it in two places is how a preview comes to promise
 * something the posting then refuses — the exact failure `ConsignedSettlementSection`
 * already warns about ("a preview that can disagree with the posting is worse
 * than no preview"). So the rule lives here and both call it.
 *
 * ## The two destinations
 *
 * The intent is route-independent; the accounting is not.
 *
 *  - **THROUGH_DEALERSHIP** — the dealership collected the gross from the buyer,
 *    so the عربون is part of what the CUSTOMER paid IT. It comes off the
 *    customer's bill (`CUSTOMER_RECEIVABLE`). It must NOT touch the supplier's
 *    entitlement: that was credited to AP-Suppliers in full when the sale
 *    posted, and crediting it again would inflate the debt by the deposit and
 *    leave an excess nothing can ever clear.
 *
 *  - **DIRECT_TO_SUPPLIER** — the buyer paid the supplier, so the dealership
 *    invoiced nothing for the car and the customer owes it nothing for it. What
 *    the dealership has is a claim on the supplier for its own margin, and the
 *    عربون is margin it is already holding in cash. It therefore opens that
 *    claim net of the deposit (`SUPPLIER_SETTLEMENT`) — reflected exactly once,
 *    via `openSupplierReceivable`'s `alreadyReceivedAmount`.
 *
 * Neither destination lets the same dinar be credited twice, and that is the
 * whole point of deriving it rather than offering it as a choice.
 */

export type DepositSettlementPlan =
  | {
      ok: true;
      destination: DepositApplicationTreatment;
      /**
       * What the deposit leaves owing once applied. `supplierReceivable` is the
       * dealership's remaining claim on the supplier; `customerReceivable` is
       * what the customer still owes the dealership. The route decides which of
       * them the deposit moved — the other is reported unchanged so a caller
       * can render both sides without knowing the rule.
       */
      customerReceivableAfterMinor: number;
      supplierReceivableAfterMinor: number;
    }
  | { ok: false; reason: string };

export interface DepositSettlementInput {
  /** SOURCED (consigned/agent) stock. Owned stock has no supplier settlement. */
  isSourced: boolean;
  settlementRoute: ConsignedSettlementRoute;
  /** This vehicle's stored share of the quote's deposit. Never the quote total. */
  depositMinor: number;
  /** What the DEALERSHIP billed the customer on this sale, in minor units. */
  customerBillableMinor: number;
  /**
   * Sale price less capitalized cost, in minor units. `null` when the vehicle
   * has no recorded supplier cost, which makes the margin unknowable rather
   * than zero — those are different facts and only one of them is safe to post.
   */
  marginMinor: number | null;
}

/**
 * The refusals are returned rather than thrown so the preview can render them
 * as a reason the option is unavailable, instead of the operator discovering it
 * by having the sale rejected. `resolveReservationDeposits` throws whichever
 * reason comes back, so the wording an operator sees is identical either way.
 */
export function planDepositSettlementApplication(
  input: DepositSettlementInput
): DepositSettlementPlan {
  const { isSourced, settlementRoute, depositMinor, customerBillableMinor, marginMinor } = input;

  // Two cases, one destination.
  //
  // THROUGH_DEALERSHIP: the dealership collected the gross, so the عربون is
  // part of what the customer paid IT.
  //
  // Owned stock: there is no supplier and the route is meaningless — the
  // customer owes the dealership the whole price, so "part of this deal's
  // settlement" has exactly one possible meaning. This used to refuse, and
  // refusing protected nothing: `completeFromQuote` takes ONE treatment for the
  // whole quote and forwards it to every line, so a quote mixing a consigned
  // car with owned stock had no completable state at all — state the treatment
  // and the owned line threw, withhold it and the consigned line threw.
  const againstTheCustomersBill = (): DepositSettlementPlan => {
    // Capped at what the dealership actually billed: applying more would credit
    // a receivable past zero and show the customer in credit for money nobody
    // billed them.
    if (depositMinor > customerBillableMinor) {
      return {
        ok: false,
        reason:
          "The reservation deposit exceeds what the dealership billed this customer on this sale, so it cannot all be applied against it. Refund or forfeit the excess instead.",
      };
    }
    return {
      ok: true,
      destination: "CUSTOMER_RECEIVABLE",
      customerReceivableAfterMinor: customerBillableMinor - depositMinor,
      // No claim on a supplier arises on either of these paths. Reported as
      // zero rather than "unchanged" because zero is what it is.
      supplierReceivableAfterMinor: 0,
    };
  };

  if (!isSourced) return againstTheCustomersBill();
  // Written as two returns rather than one `||` so the compiler can see that
  // `marginMinor` is non-null past this point.
  if (marginMinor === null) {
    return {
      ok: false,
      reason:
        "This vehicle has no recorded supplier cost, so the dealership's margin cannot be determined and a deposit cannot be applied against it.",
    };
  }
  if (dealershipCollectsGross(settlementRoute)) return againstTheCustomersBill();

  // DIRECT_TO_SUPPLIER on a consigned car.
  //
  // Deposits run 5-10% of the price and consignment margins are often smaller,
  // so a deposit exceeding the margin is ordinary rather than exotic — and
  // applying it whole would drive Receivable from Suppliers to a credit
  // balance: an asset account holding what is really the supplier's money,
  // which nothing in the system can discharge.
  if (depositMinor > marginMinor) {
    return {
      ok: false,
      reason:
        "The reservation deposit exceeds the dealership's margin on this consigned sale, so it cannot all be applied to the supplier settlement — the excess is the supplier's money, not the dealership's. Refund the excess to the customer before completing.",
    };
  }

  return {
    ok: true,
    destination: "SUPPLIER_SETTLEMENT",
    // Nothing was invoiced to the customer for the car on this route, so the
    // deposit cannot reduce a bill that was never raised.
    customerReceivableAfterMinor: customerBillableMinor,
    supplierReceivableAfterMinor: marginMinor - depositMinor,
  };
}
