"use client";

import { FormEvent, useEffect, useState } from "react";
import { useAction } from "convex/react";
import Link from "next/link";
import Script from "next/script";
import { api } from "@/convex/_generated/api";
import { TurnstileWidget } from "@/app/dealer-site/[[...slug]]/turnstile-widget";
import { Car, CheckCircle2, Globe2, Store } from "lucide-react";

type Lang = "en" | "ar";

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    title: "Request a Car",
    subtitle: "Tell us what you're looking for — verified dealers who have it will reach out.",
    firstName: "First name",
    phone: "Phone",
    whatsapp: "WhatsApp (optional, if different)",
    city: "City",
    make: "Make (optional)",
    model: "Model (optional)",
    yearMin: "Year from",
    yearMax: "Year to",
    priceMin: "Budget from (JOD)",
    priceMax: "Budget to (JOD)",
    paymentType: "Payment",
    paymentCash: "Cash",
    paymentFinance: "Finance",
    paymentEither: "Either",
    monthlyBudget: "Monthly payment budget (JOD, optional)",
    timeframe: "When do you want to buy?",
    timeframeAsap: "As soon as possible",
    timeframeWeek: "This week",
    timeframeMonth: "This month",
    timeframeLooking: "Just looking",
    consent: "By submitting this request, you agree that AutoFlow will share your request details and phone number with matching car dealers so they can contact you.",
    submit: "Submit request",
    submitting: "Submitting...",
    success: "Request sent!",
    successDetail: "matching dealers were notified and may contact you soon.",
    successDetailZero: "No matching dealers yet — we'll keep your request on file.",
    trackRequest: "Track your request",
    error: "Something went wrong. Please try again.",
    consentRequired: "Please accept the consent notice to continue.",
    verifying: "Please complete the verification challenge.",
    toggleLang: "العربية",
    backHome: "Back to AutoFlow",
  },
  ar: {
    title: "اطلب سيارتك",
    subtitle: "قول لنا شو بتدور عليه، ومعارض موثوقة عندها اللي بتحتاجه رح تتواصل معك.",
    firstName: "الاسم الأول",
    phone: "رقم الهاتف",
    whatsapp: "الواتساب (اختياري، إذا مختلف)",
    city: "المدينة",
    make: "الماركة (اختياري)",
    model: "الموديل (اختياري)",
    yearMin: "من سنة",
    yearMax: "إلى سنة",
    priceMin: "الميزانية من (دينار)",
    priceMax: "الميزانية إلى (دينار)",
    paymentType: "طريقة الدفع",
    paymentCash: "كاش",
    paymentFinance: "أقساط",
    paymentEither: "أي منهما",
    monthlyBudget: "القسط الشهري المتاح (دينار، اختياري)",
    timeframe: "متى بدك تشتري؟",
    timeframeAsap: "بأسرع وقت",
    timeframeWeek: "هذا الأسبوع",
    timeframeMonth: "هذا الشهر",
    timeframeLooking: "بس بتفرج",
    consent: "بإرسالك الطلب، أنت توافق أن AutoFlow يشارك معلومات طلبك ورقمك مع معارض سيارات مناسبة للتواصل معك.",
    submit: "إرسال الطلب",
    submitting: "جاري الإرسال...",
    success: "تم إرسال الطلب!",
    successDetail: "تم إشعار معارض مطابقة وقد تتواصل معك قريباً.",
    successDetailZero: "لا يوجد معارض مطابقة حالياً — سنحتفظ بطلبك.",
    trackRequest: "تابع حالة طلبك",
    error: "حدث خطأ ما. الرجاء المحاولة مرة أخرى.",
    consentRequired: "الرجاء الموافقة على إشعار الخصوصية للمتابعة.",
    verifying: "الرجاء إكمال تحدي التحقق.",
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

export default function MarketplaceRequestPage() {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    const browserLang = typeof navigator !== "undefined" ? navigator.language : "en";
    if (browserLang.toLowerCase().startsWith("ar")) setLang("ar");
  }, []);

  const t = STRINGS[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

  const submitRequest = useAction(api.marketplaceRequests.submitRequest);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ requestId: string; matchedCount: number } | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [paymentType, setPaymentType] = useState<"CASH" | "FINANCE" | "EITHER">("EITHER");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!consentChecked) {
      setError(t.consentRequired);
      return;
    }

    const formElement = e.currentTarget;
    const formData = new FormData(formElement);

    const formString = (key: string, fallback = "") => {
      const value = formData.get(key);
      return typeof value === "string" ? value : fallback;
    };

    const turnstileToken = formString("cf-turnstile-response");
    if (!turnstileToken) {
      setError(t.verifying);
      return;
    }

    const numberOrUndefined = (key: string) => {
      const raw = formString(key);
      const parsed = raw ? Number(raw) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    setSubmitting(true);
    try {
      const response = await submitRequest({
        buyerFirstName: formString("buyerFirstName"),
        buyerPhone: formString("buyerPhone"),
        buyerWhatsApp: formString("buyerWhatsApp") || undefined,
        buyerCity: formString("buyerCity"),
        make: formString("make") || undefined,
        model: formString("model") || undefined,
        yearMin: numberOrUndefined("yearMin"),
        yearMax: numberOrUndefined("yearMax"),
        priceMin: numberOrUndefined("priceMin"),
        priceMax: numberOrUndefined("priceMax"),
        paymentType,
        monthlyBudget: numberOrUndefined("monthlyBudget"),
        buyerTimeframe: formString("buyerTimeframe", "THIS_MONTH") as
          | "ASAP"
          | "THIS_WEEK"
          | "THIS_MONTH"
          | "JUST_LOOKING",
        consentAccepted: true,
        clientFingerprint: clientFingerprint(),
        turnstileToken,
      });
      setResult({ requestId: response.requestId, matchedCount: response.matchedCount });
    } catch {
      setError(t.error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main dir={dir} className="min-h-screen bg-slate-50 text-slate-950">
      {turnstileSiteKey && (
        <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      )}

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
          <Car className="h-5 w-5" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold">{t.title}</h1>
        <p className="mt-2 text-slate-600">{t.subtitle}</p>

        {result ? (
          <div className="mt-8 rounded-xl border border-emerald-200 bg-emerald-50 p-6 flex items-start gap-3">
            <CheckCircle2 className="h-6 w-6 text-emerald-600 shrink-0" />
            <div>
              <p className="font-semibold text-emerald-900">{t.success}</p>
              <p className="text-sm text-emerald-800 mt-1">
                {result.matchedCount > 0
                  ? `${result.matchedCount} ${t.successDetail}`
                  : t.successDetailZero}
              </p>
              <Link
                href={`/marketplace/status/${result.requestId}`}
                className="mt-3 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                {t.trackRequest}
              </Link>
            </div>
          </div>
        ) : (
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
                <label htmlFor="buyerWhatsApp" className="text-sm font-medium block mb-1">{t.whatsapp}</label>
                <input id="buyerWhatsApp" name="buyerWhatsApp" maxLength={24} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="buyerCity" className="text-sm font-medium block mb-1">{t.city}</label>
                <input id="buyerCity" name="buyerCity" required maxLength={60} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="make" className="text-sm font-medium block mb-1">{t.make}</label>
                <input id="make" name="make" maxLength={60} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="model" className="text-sm font-medium block mb-1">{t.model}</label>
                <input id="model" name="model" maxLength={60} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="yearMin" className="text-sm font-medium block mb-1">{t.yearMin}</label>
                <input id="yearMin" name="yearMin" type="number" min={1980} max={2100} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="yearMax" className="text-sm font-medium block mb-1">{t.yearMax}</label>
                <input id="yearMax" name="yearMax" type="number" min={1980} max={2100} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="priceMin" className="text-sm font-medium block mb-1">{t.priceMin}</label>
                <input id="priceMin" name="priceMin" type="number" min={0} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <div>
                <label htmlFor="priceMax" className="text-sm font-medium block mb-1">{t.priceMax}</label>
                <input id="priceMax" name="priceMax" type="number" min={0} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
            </div>

            <div>
              <label htmlFor="paymentType" className="text-sm font-medium block mb-1">{t.paymentType}</label>
              <select
                id="paymentType"
                value={paymentType}
                onChange={(e) => setPaymentType(e.target.value as "CASH" | "FINANCE" | "EITHER")}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="EITHER">{t.paymentEither}</option>
                <option value="CASH">{t.paymentCash}</option>
                <option value="FINANCE">{t.paymentFinance}</option>
              </select>
            </div>

            {paymentType !== "CASH" && (
              <div>
                <label htmlFor="monthlyBudget" className="text-sm font-medium block mb-1">{t.monthlyBudget}</label>
                <input id="monthlyBudget" name="monthlyBudget" type="number" min={0} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </div>
            )}

            <div>
              <label htmlFor="buyerTimeframe" className="text-sm font-medium block mb-1">{t.timeframe}</label>
              <select id="buyerTimeframe" name="buyerTimeframe" defaultValue="THIS_MONTH" className="w-full rounded-lg border border-slate-300 px-3 py-2">
                <option value="ASAP">{t.timeframeAsap}</option>
                <option value="THIS_WEEK">{t.timeframeWeek}</option>
                <option value="THIS_MONTH">{t.timeframeMonth}</option>
                <option value="JUST_LOOKING">{t.timeframeLooking}</option>
              </select>
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

        <Link href="/" className="mt-6 inline-block text-sm text-slate-500 hover:text-slate-800">
          {t.backHome}
        </Link>
      </section>
    </main>
  );
}
