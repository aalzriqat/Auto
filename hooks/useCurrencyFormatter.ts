"use client";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { formatInCurrency } from "@/lib/currencyFormat";

/** Formats amounts in the ORG's current currency — the default for most accounting UI. */
export function useCurrencyFormatter() {
  const { isRtl } = useLanguage();
  const orgSettings = useOrgSettings();
  const currency = orgSettings?.currencySymbol ?? "USD";
  const locale = isRtl ? "ar" : "en-US";

  return (amount: number, fractionDigits = 0) => formatInCurrency(locale, currency, amount, fractionDigits);
}

/**
 * Formats amounts in an EXPLICIT currency rather than defaulting to the org's
 * current one — for records that carry their own currency independently
 * (e.g. a prepaid schedule created before the org's currency changed, or one
 * capitalized in a currency other than the org's own). Same locale and
 * fallback logic as useCurrencyFormatter, just parameterized per call.
 */
export function useCurrencyFormatterInCurrency() {
  const { isRtl } = useLanguage();
  const locale = isRtl ? "ar" : "en-US";

  return (amount: number, currency: string, fractionDigits = 0) => formatInCurrency(locale, currency, amount, fractionDigits);
}
