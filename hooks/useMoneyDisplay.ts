"use client";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrgCurrencyState } from "@/hooks/useOrgCurrencyState";
import { formatMoneyAmount, formatMoneyDisplay, moneyDisplayLabel } from "@/lib/moneyDisplay";

/**
 * The sales wizard's money formatter (SCRUM-684): Western digits, whole amounts
 * without decimals, otherwise the currency's full scale, always suffixed.
 * Defaults to the org's STORED currency; pass a record's own currency when it has
 * one. With no stored currency (SCRUM-85) there is no default: `code` is null and
 * a figure without a currency of its own renders as "currency not configured",
 * never as a number labelled with a guessed code.
 */
export function useMoneyDisplay() {
  const { locale, t } = useLanguage();
  const state = useOrgCurrencyState();
  const lang = locale === "ar" ? "ar" : "en";
  const code = state.status === "configured" ? state.code : null;
  const notConfigured = state.status === "unconfigured" ? t("CurrencyNotConfigured") : "";

  return {
    code,
    /** The suffix alone, e.g. for a field label: "JOD" / "د.أ". Empty until the currency is known. */
    label: code === null ? notConfigured : moneyDisplayLabel(code, lang),
    format: (amount: number, currency: string | null = code, scale?: number) =>
      currency === null ? notConfigured : formatMoneyDisplay(amount, currency, lang, scale),
    /** The number alone, for text that places the currency itself. */
    amount: (amount: number, currency: string | null = code, scale?: number) =>
      currency === null ? notConfigured : formatMoneyAmount(amount, currency, scale),
  };
}
