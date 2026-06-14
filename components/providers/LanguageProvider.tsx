"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { Locale, dictionaries } from "@/lib/i18n/dictionaries";

type LanguageContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: keyof typeof dictionaries.en) => string;
  isRtl: boolean;
};

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof window === "undefined") return "en";
    const saved = localStorage.getItem("autoflow-locale") as Locale;
    return saved === "en" || saved === "ar" ? saved : "en";
  });
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
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
      // Add font class based on locale
      if (isRtl) {
        document.documentElement.classList.add("font-cairo");
        document.documentElement.classList.remove("font-inter");
      } else {
        document.documentElement.classList.add("font-inter");
        document.documentElement.classList.remove("font-cairo");
      }
    }
  }, [locale, mounted, isRtl]);

  const t = (key: keyof typeof dictionaries.en) => {
    return dictionaries[locale][key] || dictionaries["en"][key] || key;
  };

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t, isRtl }}>
      <div dir={mounted ? (isRtl ? "rtl" : "ltr") : "ltr"} className="h-full w-full">
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
