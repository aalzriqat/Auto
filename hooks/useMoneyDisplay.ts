"use client";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { formatMoneyAmount, formatMoneyDisplay, moneyDisplayLabel } from "@/lib/moneyDisplay";

/**
 * The sales wizard's money formatter (SCRUM-684): Western digits, whole amounts
 * without decimals, otherwise the currency's full scale, always suffixed.
 * Defaults to the org's currency; pass a record's own currency when it has one.
 */
export function useMoneyDisplay() {
  const { locale } = useLanguage();
  const orgSettings = useOrgSettings();
  const lang = locale === "ar" ? "ar" : "en";
  const code = orgSettings?.currency ?? "JOD";

  return {
    code,
    /** The suffix alone, e.g. for a field label: "JOD" / "د.أ". */
    label: moneyDisplayLabel(code, lang),
    format: (amount: number, currency: string = code, scale?: number) =>
      formatMoneyDisplay(amount, currency, lang, scale),
    /** The number alone, for text that places the currency itself. */
    amount: (amount: number, currency: string = code, scale?: number) => formatMoneyAmount(amount, currency, scale),
  };
}
