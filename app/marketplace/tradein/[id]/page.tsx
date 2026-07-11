"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { CheckCircle2, Clock, RefreshCw, XCircle } from "lucide-react";
import { BuyerLookupShell } from "@/components/marketplace/BuyerLookupShell";

type Lang = "en" | "ar";

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    title: "Check your trade-in offer",
    subtitle: "Enter the phone number you submitted the request with.",
    phone: "Phone",
    check: "Check status",
    notFound: "We couldn't find a trade-in request with that phone number for this link.",
    statusPending: "Still waiting on the dealer's offer.",
    statusOffered: "The dealer sent you an offer!",
    statusAccepted: "You accepted this offer. The dealer will be in touch.",
    statusDeclined: "You declined this offer.",
    offerLabel: "Offer",
    accept: "Accept offer",
    decline: "Decline offer",
    accepted: "Offer accepted!",
    declined: "Offer declined.",
    error: "Something went wrong. Please try again.",
    backHome: "Back to AutoFlow",
  },
  ar: {
    title: "تحقق من عرض الاستبدال",
    subtitle: "أدخل رقم الهاتف الذي أرسلت به الطلب.",
    phone: "رقم الهاتف",
    check: "تحقق من الحالة",
    notFound: "لم نجد طلب استبدال بهذا الرقم لهذا الرابط.",
    statusPending: "ما زلنا بانتظار عرض المعرض.",
    statusOffered: "أرسل لك المعرض عرضاً!",
    statusAccepted: "لقد قبلت هذا العرض. سيتواصل معك المعرض.",
    statusDeclined: "لقد رفضت هذا العرض.",
    offerLabel: "العرض",
    accept: "قبول العرض",
    decline: "رفض العرض",
    accepted: "تم قبول العرض!",
    declined: "تم رفض العرض.",
    error: "حدث خطأ ما. الرجاء المحاولة مرة أخرى.",
    backHome: "الرجوع إلى AutoFlow",
  },
};

export default function MarketplaceTradeInStatusPage() {
  const params = useParams();
  const tradeInRequestId = params.id as string;
  const [lang, setLang] = useState<Lang>("en");
  const [phone, setPhone] = useState("");
  const [submittedPhone, setSubmittedPhone] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDone, setActionDone] = useState<"accepted" | "declined" | null>(null);

  const t = STRINGS[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

  const status = useQuery(
    api.marketplaceTradeIns.getStatusForBuyer,
    submittedPhone
      ? { tradeInRequestId: tradeInRequestId as Id<"marketplaceTradeInRequests">, buyerPhone: submittedPhone }
      : "skip"
  );
  const acceptOffer = useMutation(api.marketplaceTradeIns.acceptOffer);
  const declineOffer = useMutation(api.marketplaceTradeIns.declineOffer);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmittedPhone(phone.trim());
    setActionDone(null);
    setActionError(null);
  }

  async function handleAccept() {
    if (!submittedPhone) return;
    setActionError(null);
    try {
      await acceptOffer({ tradeInRequestId: tradeInRequestId as Id<"marketplaceTradeInRequests">, buyerPhone: submittedPhone });
      setActionDone("accepted");
    } catch {
      setActionError(t.error);
    }
  }

  async function handleDecline() {
    if (!submittedPhone) return;
    setActionError(null);
    try {
      await declineOffer({ tradeInRequestId: tradeInRequestId as Id<"marketplaceTradeInRequests">, buyerPhone: submittedPhone });
      setActionDone("declined");
    } catch {
      setActionError(t.error);
    }
  }

  const statusMessage = (() => {
    if (!status) return null;
    switch (status.status) {
      case "PENDING":
        return t.statusPending;
      case "OFFERED":
        return t.statusOffered;
      case "ACCEPTED":
        return t.statusAccepted;
      case "DECLINED":
        return t.statusDeclined;
      default:
        return null;
    }
  })();

  return (
    <BuyerLookupShell
      dir={dir}
      homeHref="/marketplace/cars"
      langToggleLabel={lang === "en" ? "العربية" : "English"}
      onToggleLang={() => setLang(lang === "en" ? "ar" : "en")}
      aboveTitle={
        <div className="flex items-center gap-2 text-slate-500 mb-2">
          <RefreshCw className="h-5 w-5" />
        </div>
      }
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
            {status.status === "ACCEPTED" ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : status.status === "DECLINED" ? (
              <XCircle className="h-5 w-5 text-slate-400" />
            ) : (
              <Clock className="h-5 w-5 text-slate-400" />
            )}
            <p className="font-medium">{statusMessage}</p>
          </div>
          <p className="text-sm text-slate-600">
            {status.currentYear} {status.currentMake} {status.currentModel}
          </p>

          {status.status === "OFFERED" && status.offerAmountJod != null && !actionDone && (
            <div className="space-y-3 border-t border-slate-100 pt-3">
              <p className="text-lg font-bold text-slate-950">
                {t.offerLabel}: {status.offerAmountJod.toLocaleString()} JOD
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleAccept}
                  className="flex-1 rounded-lg bg-emerald-600 text-white py-2 font-medium hover:bg-emerald-700"
                >
                  {t.accept}
                </button>
                <button
                  type="button"
                  onClick={handleDecline}
                  className="flex-1 rounded-lg border border-slate-300 py-2 font-medium text-slate-700 hover:bg-slate-50"
                >
                  {t.decline}
                </button>
              </div>
              {actionError && <p className="text-sm text-rose-600">{actionError}</p>}
            </div>
          )}

          {actionDone === "accepted" && (
            <p className="text-sm text-emerald-700 font-medium border-t border-slate-100 pt-3">{t.accepted}</p>
          )}
          {actionDone === "declined" && (
            <p className="text-sm text-slate-600 font-medium border-t border-slate-100 pt-3">{t.declined}</p>
          )}
        </div>
      )}
    </BuyerLookupShell>
  );
}
