"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "./LanguageProvider";

// Mirrors the client's locale toggle into users.locale so server-initiated
// notification email/WhatsApp can be localized — LanguageProvider itself
// can't call Convex hooks since it sits above ConvexClientProvider in the
// provider tree (see app/layout.tsx), so this small sync component lives
// inside the dashboard tree instead, where both contexts are reachable.
export function LocaleSync() {
  const { locale } = useLanguage();
  const updateProfile = useMutation(api.users.updateMyNotificationProfile);
  const lastSynced = useRef<string | null>(null);

  useEffect(() => {
    if (lastSynced.current === locale) return;
    lastSynced.current = locale;
    updateProfile({ locale }).catch(() => {});
  }, [locale, updateProfile]);

  return null;
}
