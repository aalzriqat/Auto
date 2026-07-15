/**
 * Locale-aware currency formatting core, shared by both variants of
 * useCurrencyFormatter (org-default and explicit-currency). Kept dependency-free
 * (no Next.js/React imports) so it's directly unit-testable, same as
 * lib/financing.ts.
 */
export function formatInCurrency(locale: string, currency: string, amount: number, fractionDigits: number): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString(locale, { minimumFractionDigits: fractionDigits })} ${currency}`;
  }
}
