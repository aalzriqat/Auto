"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Languages } from "lucide-react";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useLanguage();

  const toggleLanguage = () => {
    setLocale(locale === "en" ? "ar" : "en");
  };

  return (
    <Button variant="ghost" size="sm" onClick={toggleLanguage} className="gap-2 px-2" title={t("SwitchLanguage" as any)}>
      <Languages className="h-4 w-4" />
      <span className="font-semibold text-sm uppercase">{locale}</span>
    </Button>
  );
}
