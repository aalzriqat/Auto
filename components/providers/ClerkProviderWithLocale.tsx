"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { arSA, enUS } from "@clerk/localizations";
import { useLanguage } from "./LanguageProvider";

// @clerk/localizations' ar-SA locale leaves several form field placeholders
// untranslated (no Arabic key defined), so Clerk silently falls back to the
// English default — e.g. labels render in Arabic but the input placeholder
// underneath says "First name" / "Create a password". Patched here rather
// than upstream since this is the first screen a new self-serve signup sees.
const arSAPatched = {
  ...arSA,
  formFieldInputPlaceholder__firstName: "الاسم الأول",
  formFieldInputPlaceholder__lastName: "الاسم الأخير",
  formFieldInputPlaceholder__emailAddress: "أدخل بريدك الإلكتروني",
  formFieldInputPlaceholder__username: "أدخل اسم المستخدم",
  formFieldInputPlaceholder__password: "أدخل كلمة المرور",
  formFieldInputPlaceholder__signUpPassword: "أنشئ كلمة مرور",
  formFieldInputPlaceholder__phoneNumber: "أدخل رقم هاتفك",
};

export function ClerkProviderWithLocale({ children }: { children: React.ReactNode }) {
  const { locale, isRtl } = useLanguage();

  return (
    <ClerkProvider
      localization={locale === "ar" ? arSAPatched : enUS}
      dynamic
    >
      {children}
    </ClerkProvider>
  );
}
