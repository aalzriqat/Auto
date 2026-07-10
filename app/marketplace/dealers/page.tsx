"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { Car, Globe2, MapPin, Phone, ShieldCheck, Store } from "lucide-react";

type Lang = "en" | "ar";

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    title: "Dealer Network",
    subtitle: "Browse verified dealers on the AutoFlow marketplace.",
    activeVehicles: "vehicles available",
    visitSite: "Visit dealership site",
    call: "Call",
    empty: "No dealers are listed yet — check back soon.",
    loading: "Loading dealers...",
    toggleLang: "العربية",
  },
  ar: {
    title: "شبكة المعارض",
    subtitle: "تصفّح المعارض الموثوقة على منصة أوتوفلو.",
    activeVehicles: "سيارة متاحة",
    visitSite: "زيارة موقع المعرض",
    call: "اتصال",
    empty: "لا يوجد معارض مُدرجة بعد — تحقق لاحقاً.",
    loading: "جاري تحميل المعارض...",
    toggleLang: "English",
  },
};

export default function MarketplaceDealersPage() {
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    const browserLang = typeof navigator !== "undefined" ? navigator.language : "en";
    if (browserLang.toLowerCase().startsWith("ar")) setLang("ar");
  }, []);

  const dealers = useQuery(api.marketplaceDealers.listPublicDirectory, {});
  const t = STRINGS[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

  return (
    <main dir={dir} className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Store className="h-5 w-5" />
            AutoFlow
          </Link>
          <button
            type="button"
            onClick={() => setLang(lang === "en" ? "ar" : "en")}
            className="text-sm text-slate-600 hover:text-slate-950"
          >
            <Globe2 className="h-4 w-4 inline me-1" />
            {t.toggleLang}
          </button>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="text-2xl sm:text-3xl font-bold">{t.title}</h1>
        <p className="mt-2 text-slate-600">{t.subtitle}</p>

        {dealers === undefined && (
          <p className="mt-8 text-slate-500">{t.loading}</p>
        )}

        {dealers !== undefined && dealers.length === 0 && (
          <p className="mt-8 text-slate-500">{t.empty}</p>
        )}

        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(dealers ?? []).map((dealer) => (
            <div
              key={dealer.orgId}
              className="rounded-xl border border-slate-200 bg-white p-5 flex flex-col gap-3 shadow-sm"
            >
              <div className="flex items-center gap-3">
                {dealer.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={dealer.logoUrl}
                    alt={dealer.dealershipName}
                    className="h-10 w-10 rounded-full object-cover border border-slate-200"
                  />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center">
                    <Store className="h-5 w-5 text-slate-400" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-semibold truncate">{dealer.dealershipName}</p>
                  {dealer.address && (
                    <p className="text-xs text-slate-500 flex items-center gap-1 truncate">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {dealer.address}
                    </p>
                  )}
                </div>
              </div>

              {dealer.badges.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {dealer.badges.map((badge) => (
                    <span
                      key={badge}
                      className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-medium px-2 py-0.5"
                    >
                      <ShieldCheck className="h-3 w-3" />
                      {badge.replaceAll("_", " ")}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-1.5 text-sm text-slate-700">
                <Car className="h-4 w-4 text-slate-400" />
                {dealer.activeVehicleCount} {t.activeVehicles}
              </div>

              <div className="mt-auto flex items-center gap-2 pt-2">
                {dealer.siteUrl && (
                  <a
                    href={dealer.siteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 text-center text-sm font-medium rounded-lg bg-slate-950 text-white py-2 hover:bg-slate-800"
                  >
                    {t.visitSite}
                  </a>
                )}
                {dealer.phone && (
                  <a
                    href={`tel:${dealer.phone}`}
                    className="flex items-center justify-center rounded-lg border border-slate-200 p-2 text-slate-700 hover:bg-slate-50"
                    aria-label={t.call}
                  >
                    <Phone className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
