"use client";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrgCurrencyState } from "@/hooks/useOrgCurrencyState";
import { formatInCurrency } from "@/lib/currencyFormat";

/**
 * Formats amounts in the ORG's current currency — the default for most accounting UI.
 *
 * SCRUM-85: the currency is the one the owner stored, never a guess. While it is
 * unknown the formatter returns an empty string (a skeleton is showing); when the
 * organization has none it returns "currency not configured" instead of a number.
 */
export function useCurrencyFormatter() {
  const { isRtl, t } = useLanguage();
  const state = useOrgCurrencyState();
  const locale = isRtl ? "ar" : "en-US";

  return (amount: number, fractionDigits = 0) => {
    if (state.status === "unconfigured") return t("CurrencyNotConfigured");
    if (state.status !== "configured") return "";
    return formatInCurrency(locale, state.symbol ?? state.code, amount, fractionDigits);
  };
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
