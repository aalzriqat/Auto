import {
  DEFAULT_LOCALE,
  getMobileFoundationString,
  isRtlLocale,
  type Locale,
  type MobileFoundationStringKey,
  normalizeLocale,
} from "@autoflow/shared";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { I18nManager } from "react-native";

interface LocaleContextValue {
  locale: Locale;
  isRtl: boolean;
  textDirection: "rtl" | "ltr";
  setLocale: (locale: Locale) => Promise<void>;
  t: (key: MobileFoundationStringKey) => string;
}

const LOCALE_STORAGE_KEY = "autoflow-mobile-locale";
const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    I18nManager.allowRTL(true);
    SecureStore.getItemAsync(LOCALE_STORAGE_KEY)
      .then((stored) => {
        if (stored) {
          setLocaleState(normalizeLocale(stored));
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to load mobile locale preference", error);
      });
  }, []);

  const setLocale = useCallback(async (nextLocale: Locale) => {
    setLocaleState(nextLocale);
    try {
      await SecureStore.setItemAsync(LOCALE_STORAGE_KEY, nextLocale);
    } catch (error) {
      console.error("Failed to save mobile locale preference", error);
    }
  }, []);

  const value = useMemo<LocaleContextValue>(() => {
    const isRtl = isRtlLocale(locale);
    return {
      locale,
      isRtl,
      textDirection: isRtl ? "rtl" : "ltr",
      setLocale,
      t: (key) => getMobileFoundationString(locale, key),
    };
  }, [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider");
  }

  return context;
}
