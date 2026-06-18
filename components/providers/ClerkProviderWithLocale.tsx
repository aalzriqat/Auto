"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { arSA, enUS } from "@clerk/localizations";
import { useLanguage } from "./LanguageProvider";

export function ClerkProviderWithLocale({ children }: { children: React.ReactNode }) {
  const { locale, isRtl } = useLanguage();
  
  return (
    <ClerkProvider 
      localization={locale === "ar" ? arSA : enUS} 
      dynamic
    >
      {children}
    </ClerkProvider>
  );
}
