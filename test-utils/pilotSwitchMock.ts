/**
 * Test-only handle on the two pilot containment switches
 * (`convex/utils/customerCreditPayoutContainment.ts`). The shipped values are
 * `true` and no client input reaches them; a test flips these to prove both the
 * refusal (switch on) and the underlying behavior (switch off).
 *
 * Usage in a test file:
 *   const pilot = vi.hoisted(() => ({ payoutDisabled: true, invoiceDoorsDisabled: true }));
 *   vi.mock("./utils/customerCreditPayoutContainment", async (importOriginal) =>
 *     (await import("../test-utils/pilotSwitchMock")).pilotSwitchModule(await importOriginal(), pilot));
 */
export type PilotSwitchState = { payoutDisabled: boolean; invoiceDoorsDisabled: boolean };

type Original = typeof import("../convex/utils/customerCreditPayoutContainment");

export function pilotSwitchModule(original: Original, state: PilotSwitchState): Original {
  return {
    ...original,
    get CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED() { return state.payoutDisabled as true; },
    get SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED() { return state.invoiceDoorsDisabled as true; },
    assertCustomerCreditPayoutAllowed: (disabled: boolean = state.payoutDisabled) =>
      original.assertCustomerCreditPayoutAllowed(disabled),
    isCustomerCreditPayoutDisabled: (disabled: boolean = state.payoutDisabled) =>
      original.isCustomerCreditPayoutDisabled(disabled),
    areSaleInvoiceReceiptDoorsDisabled: (disabled: boolean = state.invoiceDoorsDisabled) =>
      original.areSaleInvoiceReceiptDoorsDisabled(disabled),
    assertSaleInvoiceReceiptDoorsAllowed: (disabled: boolean = state.invoiceDoorsDisabled) =>
      original.assertSaleInvoiceReceiptDoorsAllowed(disabled),
  };
}
