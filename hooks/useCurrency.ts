"use client";
import { useOrgSettings } from "./useOrgSettings";

interface CurrencyUtils {
  code: string;
  symbol: string;
  format: (amount: number) => string;
  formatCompact: (amount: number) => string;
}

export function useCurrency(): CurrencyUtils {
  const settings = useOrgSettings();
  const code = settings?.currency ?? "JOD";
  const symbol = settings?.currencySymbol ?? "د.أ";

  function format(amount: number): string {
    return `${amount.toLocaleString()} ${code}`;
  }

  function formatCompact(amount: number): string {
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M ${code}`;
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K ${code}`;
    return format(amount);
  }

  return { code, symbol, format, formatCompact };
}
