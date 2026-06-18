"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { Locale, dictionaries } from "@/lib/i18n/dictionaries";

type LanguageContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  // Accept any string key; keyof typeof dictionaries.en gets autocomplete, unknowns return the key itself
  t: (key: keyof typeof dictionaries.en | (string & {})) => string;
  isRtl: boolean;
};

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // Default to Arabic everywhere for a first-time visitor (no saved
  // preference yet) — our primary audience. Start with "ar" on both SSR and
  // the initial client render so they agree; the saved-preference check
  // below (English or Arabic) only overrides it after mount, once we can
  // actually read localStorage.
  const [locale, setLocaleState] = useState<Locale>("ar");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("autoflow-locale") as Locale | null;
    if (saved === "en" || saved === "ar") setLocaleState(saved);
    setMounted(true);
  }, []);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem("autoflow-locale", newLocale);
  };

  const isRtl = locale === "ar";

  useEffect(() => {
    if (mounted) {
      document.documentElement.dir = isRtl ? "rtl" : "ltr";
      document.documentElement.lang = locale;
      // Font class lives on <body> (set there in app/layout.tsx), so toggle
      // it there too — switching it on <html> alone has no visual effect
      // since body's own font-* class always wins over an inherited one.
      if (isRtl) {
        document.body.classList.add("font-cairo");
        document.body.classList.remove("font-inter");
      } else {
        document.body.classList.add("font-inter");
        document.body.classList.remove("font-cairo");
      }
    }
  }, [locale, mounted, isRtl]);

  const t = (key: keyof typeof dictionaries.en | (string & {})) => {
    const k = key as keyof typeof dictionaries.en;
    return dictionaries[locale][k] || dictionaries["en"][k] || key;
  };

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t, isRtl }}>
      <div dir={isRtl ? "rtl" : "ltr"} className="h-full w-full">
        {children}
      </div>
    </LanguageContext.Provider>
  );
}

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
};
