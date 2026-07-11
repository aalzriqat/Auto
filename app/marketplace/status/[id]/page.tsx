"use client";

import { FormEvent, useState } from "react";
import { useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { CheckCircle2, Clock } from "lucide-react";
import { BuyerLookupShell } from "@/components/marketplace/BuyerLookupShell";

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
    <BuyerLookupShell
      dir={dir}
      homeHref="/marketplace/dealers"
      langToggleLabel={lang === "en" ? "العربية" : "English"}
      onToggleLang={() => setLang(lang === "en" ? "ar" : "en")}
      title={t.title}
      subtitle={t.subtitle}
      phone={phone}
      onPhoneChange={setPhone}
      onSubmit={handleSubmit}
      phonePlaceholder={t.phone}
      checkLabel={t.check}
      notFound={Boolean(submittedPhone && status === null)}
      notFoundMessage={t.notFound}
    >
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
    </BuyerLookupShell>
  );
}
