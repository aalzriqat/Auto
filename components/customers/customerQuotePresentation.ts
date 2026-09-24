export type CustomerQuotePresentationInput = {
  mode?: string;
  companyId?: unknown;
  totalFinancedAmount?: number;
  vehiclePrice?: number;
};

/**
 * Legacy cash quotes predate the explicit mode field and have no companyId.
 * Every explicit non-CASH mode is financed, including manual finance where
 * companyId is intentionally absent.
 */
export function isCashQuotePresentation(
  quote: CustomerQuotePresentationInput
): boolean {
  return quote.mode === "CASH" || (quote.mode === undefined && !quote.companyId);
}

export function isFinancedQuotePresentation(
  quote: CustomerQuotePresentationInput
): boolean {
  return !isCashQuotePresentation(quote);
}

/**
 * Never invent a financed total from vehiclePrice. Configured/manual Murabaha
 * persist an authoritative total; unsupported or legacy financed modes without
 * one must surface "unavailable" rather than a false amount.
 */
export function customerQuoteTotalAmount(
  quote: CustomerQuotePresentationInput
): number | undefined {
  return isCashQuotePresentation(quote)
    ? quote.vehiclePrice
    : quote.totalFinancedAmount;
}

export function customerQuotePaymentType(
  quote: CustomerQuotePresentationInput
): "CASH" | "INSTALLMENT" {
  return isCashQuotePresentation(quote) ? "CASH" : "INSTALLMENT";
}
