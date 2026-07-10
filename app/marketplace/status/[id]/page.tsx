"use client";

import { FormEvent, useState } from "react";
import { useQuery } from "convex/react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { CheckCircle2, Clock, Store } from "lucide-react";

type Lang = "en" | "ar";

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    title: "Check your request",
    subtitle: "Enter the phone number you submitted the request with.",
    phone: "Phone",
    check: "Check status",
    notFound: "We couldn't find a request with that phone number for this link.",
    statusOpen: "Still looking for a match — no dealers matched yet.",
    statusMatched: "Matched with dealers — waiting on replies.",
    statusFulfilled: "At least one dealer has a car for you!",
    statusExpired: "This request has expired.",
    statusSpam: "This request is no longer active.",
    matchedCount: "dealers notified",
    respondedCount: "dealers replied",
    backHome: "Back to AutoFlow",
  },
  ar: {
    title: "تحقق من طلبك",
    subtitle: "أدخل رقم الهاتف الذي أرسلت به الطلب.",
    phone: "رقم الهاتف",
    check: "تحقق من الحالة",
    notFound: "لم نجد طلباً بهذا الرقم لهذا الرابط.",
    statusOpen: "ما زلنا نبحث عن تطابق — لا يوجد معارض مطابقة بعد.",
    statusMatched: "تم التطابق مع معارض — بانتظار الردود.",
    statusFulfilled: "يوجد معرض واحد على الأقل عنده سيارة لك!",
    statusExpired: "انتهت صلاحية هذا الطلب.",
    statusSpam: "هذا الطلب لم يعد نشطاً.",
    matchedCount: "معارض تم إشعارها",
    respondedCount: "معارض ردت",
    backHome: "الرجوع إلى AutoFlow",
  },
};

export default function MarketplaceStatusPage() {
  const params = useParams();
  const requestId = params.id as string;
  const [lang, setLang] = useState<Lang>("en");
  const [phone, setPhone] = useState("");
  const [submittedPhone, setSubmittedPhone] = useState<string | null>(null);

  const t = STRINGS[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

  const status = useQuery(
    api.marketplaceRequests.getStatusForBuyer,
    submittedPhone ? { requestId: requestId as Id<"marketplaceRequests">, buyerPhone: submittedPhone } : "skip"
  );

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmittedPhone(phone.trim());
  }

  const statusMessage = (() => {
    if (!status) return null;
    switch (status.status) {
      case "OPEN":
        return t.statusOpen;
      case "MATCHED":
        return t.statusMatched;
      case "FULFILLED":
        return t.statusFulfilled;
      case "EXPIRED":
        return t.statusExpired;
      case "SPAM":
        return t.statusSpam;
      default:
        return null;
    }
  })();

  return (
    <main dir={dir} className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-md px-4 py-4 flex items-center justify-between">
          <Link href="/marketplace/dealers" className="flex items-center gap-2 font-semibold">
            <Store className="h-5 w-5" />
            AutoFlow
          </Link>
          <button type="button" onClick={() => setLang(lang === "en" ? "ar" : "en")} className="text-sm text-slate-600">
            {lang === "en" ? "العربية" : "English"}
          </button>
        </div>
      </header>

      <section className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="mt-2 text-slate-600">{t.subtitle}</p>

        <form onSubmit={handleSubmit} className="mt-6 flex gap-2">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t.phone}
            required
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
          />
          <button type="submit" className="rounded-lg bg-slate-950 text-white px-4 py-2 font-medium">
            {t.check}
          </button>
        </form>

        {submittedPhone && status === null && (
          <p className="mt-6 text-sm text-rose-600">{t.notFound}</p>
        )}

        {status && (
          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 space-y-3">
            <div className="flex items-center gap-2">
              {status.status === "FULFILLED" ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              ) : (
                <Clock className="h-5 w-5 text-slate-400" />
              )}
              <p className="font-medium">{statusMessage}</p>
            </div>
            <div className="flex gap-4 text-sm text-slate-600">
              <span>{status.matchedCount} {t.matchedCount}</span>
              <span>{status.respondedCount} {t.respondedCount}</span>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
