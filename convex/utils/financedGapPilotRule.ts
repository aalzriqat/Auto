import type { CustomerGapToDealer } from "./financingEconomics";
import { FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED } from "./financedGapPilotSwitch";
import { applicationHasFinancier } from "./manualFinancePayer";
import { refuseSaleDebt } from "./saleDebtContainment";

/**
 * SCRUM-571 ruling 10 (owner ruling c23812 on SCRUM-760), defined ONCE: while `FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED`
 * is on, a financed deal whose customer still owes the dealership a gap R (cash plus instalments to the dealership, in minor
 * units) is uncollectable, because no certified door applies a customer payment to the sale invoice it would open. R is
 * uncollectable when it is anything but exactly zero, so an unreadable gap (NaN, fractional, negative, overflowing) fails
 * closed. A gap the customer pays the finance company, or the dealership absorbs, is not part of R.
 *
 * Every door that sets, seals or completes the customer-gap route asks THIS rule, so the doors cannot drift apart:
 * `resolveAppraisalGap` (the only writer of R) and `registerVehicleHandover` (the seal, through
 * `assertAppraisalGapSettledToAdvance`) refuse early; `finalizeDeal` and the closing-readiness check judge a row that
 * pre-dates the early refusal. `financedGapPilotGate.ts` keeps the completion-side wrappers.
 *
 * A module of its own, importing the switch, so a fixture-only suite that opts out of the switch
 * (`scripts/scrum571FinancedGapOptOutCensus.test.ts`) switches every door off together. It is pure and read-free, and it
 * takes the already-composed gap (`composeCustomerGapToDealer`) as a type-only import so the engine can call it without a
 * runtime import cycle.
 */
export function customerGapToDealerIsUncollectable(gap: CustomerGapToDealer): boolean {
  return FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED && (!gap.readable || gap.amountMinor !== 0);
}

/** Refuses, before any write, a customer gap to the dealership that no certified door can collect. */
export function assertCustomerGapToDealerCollectable(gap: CustomerGapToDealer): void {
  if (customerGapToDealerIsUncollectable(gap)) refuseSaleDebt("FINANCED_CUSTOMER_GAP_UNCOLLECTABLE_REFUSED");
}

/**
 * The same refusal for a door that holds the application row rather than a posting plan. Only a deal with a financier is
 * a plan-governed financed sale (`financedSaleRecognitionApplies`), so a financier-less cash application is not this
 * rule's business.
 */
export function assertApplicationGapCollectable(
  app: Parameters<typeof applicationHasFinancier>[0],
  gap: CustomerGapToDealer
): void {
  if (applicationHasFinancier(app)) assertCustomerGapToDealerCollectable(gap);
}
