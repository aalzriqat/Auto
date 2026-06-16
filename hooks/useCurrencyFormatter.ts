"use client";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrgSettings } from "@/hooks/useOrgSettings";

export function useCurrencyFormatter() {
  const { isRtl } = useLanguage();
  const orgSettings = useOrgSettings();
  const currency = orgSettings?.currencySymbol ?? "USD";
  const locale = isRtl ? "ar" : "en-US";

  return (amount: number, fractionDigits = 0) => {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: fractionDigits,
      }).format(amount);
    } catch {
      return `${amount.toLocaleString()} ${currency}`;
    }
  };
}
