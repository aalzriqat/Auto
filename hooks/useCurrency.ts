"use client";
import { useOrgSettings } from "./useOrgSettings";
import { useLanguage } from "@/components/providers/LanguageProvider";

interface CurrencyUtils {
  code: string;
  symbol: string;
  displayLabel: string;
  format: (amount: number) => string;
  formatCompact: (amount: number) => string;
}

export function useCurrency(): CurrencyUtils {
  const settings = useOrgSettings();
  const { locale } = useLanguage();
  const code = settings?.currency ?? "JOD";
  const symbol = settings?.currencySymbol ?? "د.أ";

  const displayLabel = locale === "ar" && code === "JOD" ? "دينار اردني" : code;

  function format(amount: number): string {
    return `${amount.toLocaleString()} ${displayLabel}`;
  }

  function formatCompact(amount: number): string {
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M ${displayLabel}`;
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K ${displayLabel}`;
    return format(amount);
  }

  return { code, symbol, displayLabel, format, formatCompact };
}
