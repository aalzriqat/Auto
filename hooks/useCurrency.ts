"use client";
import { useOrgCurrencyState } from "./useOrgCurrencyState";
import { useLanguage } from "@/components/providers/LanguageProvider";

interface CurrencyUtils {
  /** The stored ISO code, or null while loading / when the org chose none (SCRUM-85: never "JOD"). */
  code: string | null;
  /** The stored symbol, or null when the owner stored none. */
  symbol: string | null;
  /** True once the organization's currency is known and stored. */
  configured: boolean;
  /** "loading" until the stored currency is known; "unconfigured" when the org chose none. */
  status: "loading" | "unconfigured" | "configured";
  /** The code, or the "currency not configured" text when there is no stored code. */
  displayLabel: string;
  /** The amount with its currency, or "currency not configured" instead of a number. */
  format: (amount: number) => string;
  formatCompact: (amount: number) => string;
  /** The amount in the given locale and number options, with the currency, or "currency not configured". */
  formatLocale: (amount: number, localeCode: string, options?: Intl.NumberFormatOptions) => string;
}

export function useCurrency(): CurrencyUtils {
  const state = useOrgCurrencyState();
  const { locale, t } = useLanguage();
  const code = state.status === "configured" ? state.code : null;
  const symbol = state.status === "configured" ? state.symbol : null;

  const notConfigured = state.status === "unconfigured" ? t("CurrencyNotConfigured") : "";
  const displayLabel = code === null ? notConfigured : locale === "ar" && code === "JOD" ? "دينار اردني" : code;

  function format(amount: number): string {
    if (code === null) return notConfigured;
    return `${amount.toLocaleString()} ${displayLabel}`;
  }

  function formatCompact(amount: number): string {
    if (code === null) return notConfigured;
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M ${displayLabel}`;
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K ${displayLabel}`;
    return format(amount);
  }

  function formatLocale(amount: number, localeCode: string, options?: Intl.NumberFormatOptions): string {
    if (code === null) return notConfigured;
    return `${amount.toLocaleString(localeCode, options)} ${displayLabel}`;
  }

  return { code, symbol, configured: code !== null, status: state.status, displayLabel, format, formatCompact, formatLocale };
}
