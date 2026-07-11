"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useAction } from "convex/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Script from "next/script";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { TurnstileWidget } from "@/app/dealer-site/[[...slug]]/turnstile-widget";
import { CheckCircle2, Globe2, RefreshCw, Store } from "lucide-react";

type Lang = "en" | "ar";

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    title: "Request a Trade-In Offer",
    subtitle: "Tell us about your current car and this dealer will send you an offer.",
    forDealer: "For",
    firstName: "First name",
    phone: "Phone",
    currentMake: "Your car's make",
    currentModel: "Your car's model",
    currentYear: "Year",
    currentMileage: "Mileage (km)",
    condition: "Condition",
    conditionExcellent: "Excellent",
    conditionGood: "Good",
    conditionFair: "Fair",
    conditionPoor: "Poor",
    notes: "Notes (optional)",
    consent: "By submitting this request, you agree that AutoFlow will share your trade-in details and phone number with this dealer so they can send you an offer.",
    submit: "Request offer",
    submitting: "Submitting...",
    success: "Request sent!",
    successDetail: "The dealer was notified and will send you an offer soon.",
    error: "Something went wrong. Please try again.",
    consentRequired: "Please accept the consent notice to continue.",
    verifying: "Please complete the verification challenge.",
    missingDealer: "This trade-in link is missing a dealer — go back to Browse Cars and try again.",
    toggleLang: "العربية",
    backHome: "Back to AutoFlow",
  },
  ar: {
    title: "اطلب عرض استبدال",
    subtitle: "أخبرنا عن سيارتك الحالية وسيرسل لك هذا المعرض عرضاً.",
    forDealer: "لـ",
    firstName: "الاسم الأول",
    phone: "رقم الهاتف",
    currentMake: "ماركة سيارتك",
    currentModel: "موديل سيارتك",
    currentYear: "سنة الصنع",
    currentMileage: "الممشى (كم)",
    condition: "الحالة",
    conditionExcellent: "ممتازة",
    conditionGood: "جيدة",
    conditionFair: "متوسطة",
    conditionPoor: "ضعيفة",
    notes: "ملاحظات (اختياري)",
    consent: "بإرسالك الطلب، أنت توافق أن AutoFlow يشارك تفاصيل سيارتك ورقمك مع هذا المعرض ليرسل لك عرضاً.",
    submit: "اطلب العرض",
    submitting: "جاري الإرسال...",
    success: "تم إرسال الطلب!",
    successDetail: "تم إشعار المعرض وسيرسل لك عرضاً قريباً.",
    error: "حدث خطأ ما. الرجاء المحاولة مرة أخرى.",
    consentRequired: "الرجاء الموافقة على إشعار الخصوصية للمتابعة.",
    verifying: "الرجاء إكمال تحدي التحقق.",
    missingDealer: "رابط الاستبدال هذا لا يحدد معرضاً — ارجع لتصفح السيارات وحاول مجدداً.",
    toggleLang: "English",
    backHome: "الرجوع إلى AutoFlow",
  },
};

const FINGERPRINT_KEY = "autoflow_marketplace_fingerprint";
const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function clientFingerprint() {
  let visitorId = window.localStorage.getItem(FINGERPRINT_KEY);
  if (!visitorId) {
    visitorId = randomId();
    window.localStorage.setItem(FINGERPRINT_KEY, visitorId);
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown";
  return [visitorId, navigator.language, timezone, `${window.screen.width}x${window.screen.height}`].join(":");
}

function TradeInForm() {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    const browserLang = typeof navigator !== "undefined" ? navigator.language : "en";
    if (browserLang.toLowerCase().startsWith("ar")) setLang("ar");
  }, []);
  const t = STRINGS[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

  const searchParams = useSearchParams();
  const orgId = searchParams.get("orgId");
  const dealerName = searchParams.get("dealerName");

  const submitTradeInRequest = useAction(api.marketplaceTradeIns.submitTradeInRequest);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [condition, setCondition] = useState<"EXCELLENT" | "GOOD" | "FAIR" | "POOR">("GOOD");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!orgId) return;

    if (!consentChecked) {
      setError(t.consentRequired);
      return;
    }

    const formData = new FormData(e.currentTarget);
    const formString = (key: string, fallback = "") => {
      const value = formData.get(key);
      return typeof value === "string" ? value : fallback;
    };

    const turnstileToken = formString("cf-turnstile-response");
    if (!turnstileToken) {
      setError(t.verifying);
      return;
    }

    setSubmitting(true);
    try {
      await submitTradeInRequest({
        orgId: orgId as Id<"organizations">,
        buyerFirstName: formString("buyerFirstName"),
        buyerPhone: formString("buyerPhone"),
        currentMake: formString("currentMake"),
        currentModel: formString("currentModel"),
        currentYear: Number(formString("currentYear")) || new Date().getFullYear(),
        currentMileage: Number(formString("currentMileage")) || 0,
        condition,
        notes: formString("notes") || undefined,
        consentAccepted: true,
        clientFingerprint: clientFingerprint(),
        turnstileToken,
      });
      setSuccess(true);
    } catch {
      setError(t.error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main dir={dir} className="min-h-screen bg-slate-50 text-slate-950">
      {turnstileSiteKey && <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />}

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-2xl px-4 py-4 flex items-center justify-between">
          <Link href="/marketplace/dealers" className="flex items-center gap-2 font-semibold">
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

      <section className="mx-auto max-w-2xl px-4 py-10">
        <div className="flex items-center gap-2 text-slate-500 mb-2">
          <RefreshCw className="h-5 w-5" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold">{t.title}</h1>
        <p className="mt-2 text-slate-600">
          {t.subtitle} {dealerName && <span className="font-medium text-slate-900">{t.forDealer} {dealerName}</span>}
        </p>

        {!orgId && <p className="mt-8 text-sm text-rose-600">{t.missingDealer}</p>}

        {orgId && success && (
          <div className="mt-8 rounded-xl border border-emerald-200 bg-emerald-50 p-6 flex items-start gap-3">
            <CheckCircle2 className="h-6 w-6 text-emerald-600 shrink-0" />
            <div>
              <p className="font-semibold text-emerald-900">{t.success}</p>
              <p className="text-sm text-emerald-800 mt-1">{t.successDetail}</p>
            </div>
          </div>
        )}

        {orgId && !success && (
          <form onSubmit={handleSubmit} className="mt-8 space-y-4 bg-white border border-slate-200 rounded-xl p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="buyerFirstName" className="text-sm font-medium block mb-1">{t.firstName}</label>
                <input id="buyerFirstName" name="buyerFirstName" required maxLength={80} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="buyerPhone" className="text-sm font-medium block mb-1">{t.phone}</label>
                <input id="buyerPhone" name="buyerPhone" required maxLength={24} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="currentMake" className="text-sm font-medium block mb-1">{t.currentMake}</label>
                <input id="currentMake" name="currentMake" required maxLength={60} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="currentModel" className="text-sm font-medium block mb-1">{t.currentModel}</label>
                <input id="currentModel" name="currentModel" required maxLength={60} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="currentYear" className="text-sm font-medium block mb-1">{t.currentYear}</label>
                <input id="currentYear" name="currentYear" type="number" required min={1980} max={2100} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="currentMileage" className="text-sm font-medium block mb-1">{t.currentMileage}</label>
                <input id="currentMileage" name="currentMileage" type="number" required min={0} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
            </div>

            <div>
              <label htmlFor="condition" className="text-sm font-medium block mb-1">{t.condition}</label>
              <select
                id="condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value as typeof condition)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="EXCELLENT">{t.conditionExcellent}</option>
                <option value="GOOD">{t.conditionGood}</option>
                <option value="FAIR">{t.conditionFair}</option>
                <option value="POOR">{t.conditionPoor}</option>
              </select>
            </div>

            <div>
              <label htmlFor="notes" className="text-sm font-medium block mb-1">{t.notes}</label>
              <textarea id="notes" name="notes" rows={3} maxLength={500} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
            </div>

            <label className="flex items-start gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-1"
              />
              {t.consent}
            </label>

            {turnstileSiteKey && <TurnstileWidget siteKey={turnstileSiteKey} />}

            {error && <p className="text-sm text-rose-600">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-slate-950 text-white py-2.5 font-medium hover:bg-slate-800 disabled:opacity-60"
            >
              {submitting ? t.submitting : t.submit}
            </button>
          </form>
        )}

        <Link href="/marketplace/cars" className="mt-6 inline-block text-sm text-slate-500 hover:text-slate-800">
          {t.backHome}
        </Link>
      </section>
    </main>
  );
}

export default function MarketplaceTradeInPage() {
  return (
    <Suspense fallback={null}>
      <TradeInForm />
    </Suspense>
  );
}
