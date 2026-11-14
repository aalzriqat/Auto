"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { formatExactMinorAmount, moneyDisplayLabel } from "@/lib/moneyDisplay";

export function Money({ minor, currency }: Readonly<{ minor: number; currency: string }>) {
  const { locale } = useLanguage();
  return (
    <bdi className="tabular-nums">
      {formatExactMinorAmount(minor, currency)} {moneyDisplayLabel(currency, locale === "ar" ? "ar" : "en")}
    </bdi>
  );
}
