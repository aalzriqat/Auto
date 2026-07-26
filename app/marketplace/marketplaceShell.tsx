"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Globe2, Store } from "lucide-react";

export type Lang = "en" | "ar";

/**
 * Per-key translations for the public marketplace pages.
 *
 * Deliberately keyed string-first (`{ title: { en, ar } }`) rather than as two
 * parallel `{ en: {...}, ar: {...} }` blocks: the parallel shape repeats the
 * entire key list once per language, so a translation is easy to add on one
 * side and forget on the other. Here both languages for a string sit on the
 * same line and the type makes omitting one a compile error.
 */
export type Translations = Record<string, Record<Lang, string>>;

/** Flattens a Translations map down to the single active language. */
export function translate<T extends Translations>(strings: T, lang: Lang): Record<keyof T, string> {
  const out = {} as Record<keyof T, string>;
  (Object.keys(strings) as (keyof T)[]).forEach((key) => {
    out[key] = strings[key as string][lang];
  });
  return out;
}

/**
 * Language state for the public marketplace pages, which are outside the
 * dashboard's LanguageProvider and so pick their own initial language from the
 * browser (matching what app/marketplace/cars/page.tsx already does).
 */
export function useMarketplaceLang(): {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  dir: "rtl" | "ltr";
} {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    const browserLang = typeof navigator !== "undefined" ? navigator.language : "en";
    if (browserLang.toLowerCase().startsWith("ar")) setLang("ar");
  }, []);
  return {
    lang,
    setLang,
    toggleLang: () => setLang(lang === "en" ? "ar" : "en"),
    dir: lang === "ar" ? "rtl" : "ltr",
  };
}

/** Shared page frame (RTL-aware main + branded header with the language toggle). */
export function MarketplacePageShell({
  dir,
  toggleLabel,
  onToggleLang,
  children,
}: {
  readonly dir: "rtl" | "ltr";
  readonly toggleLabel: string;
  readonly onToggleLang: () => void;
  readonly children: ReactNode;
}) {
  return (
    <main dir={dir} className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-3xl px-4 py-4 flex items-center justify-between">
          <Link href="/marketplace/cars" className="flex items-center gap-2 font-semibold">
            <Store className="h-5 w-5" />
            AutoFlow
          </Link>
          <button
            type="button"
            onClick={onToggleLang}
            className="text-sm text-slate-600 hover:text-slate-950"
          >
            <Globe2 className="h-4 w-4 inline me-1" />
            {toggleLabel}
          </button>
        </div>
      </header>
      {children}
    </main>
  );
}
