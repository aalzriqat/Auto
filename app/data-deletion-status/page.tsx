"use client";

import { Suspense } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { CheckCircle2, Clock, SearchX } from "lucide-react";

type Platform = "facebook" | "instagram";

// The page states only what the callback does: it clears the stored access
// credentials and connection details for the account. It does not claim a
// complete erasure, and when the callback found no connection it says nothing was
// removed (SCRUM-842).
const PLATFORM_NAME: Record<"en" | "ar", Record<Platform, string>> = {
  en: { facebook: "Facebook", instagram: "Instagram" },
  ar: { facebook: "فيسبوك", instagram: "إنستغرام" },
};

function DataDeletionStatusContent() {
  const { locale } = useLanguage();
  const searchParams = useSearchParams();
  const confirmationCode = searchParams.get("id");

  const isAr = locale === "ar";
  const status = useQuery(
    api.socialIntegrations.getMetaDataDeletionStatus,
    confirmationCode ? { code: confirmationCode } : "skip",
  );

  if (confirmationCode && status === undefined) {
    return (
      <section className="container mx-auto px-6 py-20 max-w-xl text-center" aria-busy="true">
        <Clock className="h-12 w-12 text-white/40 mx-auto mb-6" />
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-3">
          {isAr ? "جارٍ التحقق من طلبك" : "Checking your request"}
        </h1>
      </section>
    );
  }

  if (!confirmationCode || status === null || status === undefined) {
    return (
      <section className="container mx-auto px-6 py-20 max-w-xl text-center">
        <SearchX className="h-12 w-12 text-white/40 mx-auto mb-6" />
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-3">
          {isAr ? "لم نتمكن من العثور على هذا الطلب" : "We could not find this request"}
        </h1>
        <p className="text-sm text-white/65 leading-relaxed">
          {isAr
            ? "تأكد من فتح الرابط الكامل كما وصلك من فيسبوك أو إنستغرام. إذا استمرت المشكلة، تواصل معنا."
            : "Check that you opened the full link you were given by Facebook or Instagram. If the problem continues, contact us."}
        </p>
      </section>
    );
  }

  const platform = PLATFORM_NAME[isAr ? "ar" : "en"][status.platform];

  // The request is recorded, but removing the identifier from retained logs runs
  // in pages and has not finished. Say so; claim nothing was removed yet (SCRUM-842).
  if (status.completedAt === null) {
    return (
      <section className="container mx-auto px-6 py-20 max-w-xl text-center" aria-busy="true">
        <Clock className="h-12 w-12 text-white/40 mx-auto mb-6" />
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-3">
          {isAr ? "طلب الحذف الخاص بك قيد التنفيذ" : "Your deletion request is in progress"}
        </h1>
        <p className="text-sm text-white/65 leading-relaxed mb-6">
          {isAr
            ? `ما زلنا ننفذ طلب الحذف المتعلق بحسابك على ${platform}. أعد فتح هذه الصفحة بعد بضع دقائق لمعرفة اكتمال الطلب.`
            : `We are still carrying out the ${platform} deletion request for your account. Open this page again in a few minutes to see when it is complete.`}
        </p>
        <p className="text-xs text-white/40 tracking-wider">
          {isAr ? "رمز التأكيد:" : "Confirmation code:"}{" "}
          <bdi dir="ltr" className="font-mono">
            {confirmationCode}
          </bdi>
        </p>
      </section>
    );
  }

  return (
    <section className="container mx-auto px-6 py-20 max-w-xl text-center">
      <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-6" />
      <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-3">
        {isAr ? "تمت معالجة طلب الحذف الخاص بك" : "Your deletion request was processed"}
      </h1>
      <p className="text-sm text-white/65 leading-relaxed mb-6">
        {status.connectionRemoved === false
          ? // The callback matched no stored connection (already removed, or never held here).
            // Claim nothing was removed now (SCRUM-842).
            isAr
            ? `لم نجد أي بيانات وصول إلى ${platform} أو تفاصيل ربط محفوظة لحسابك، لذلك لم يكن هناك ما نزيله. لا يلزم اتخاذ أي إجراء آخر.`
            : `We held no ${platform} access credentials or connection details for your account, so there was nothing to remove. No further action is needed.`
          : isAr
            ? `أزلنا بيانات الوصول إلى ${platform} وتفاصيل الربط التي كنا نحتفظ بها لحسابك. لا يلزم اتخاذ أي إجراء آخر.`
            : `We removed the ${platform} access credentials and connection details we held for your account. No further action is needed.`}
      </p>
      <p className="text-xs text-white/40 tracking-wider">
        {isAr ? "رمز التأكيد:" : "Confirmation code:"}{" "}
        <bdi dir="ltr" className="font-mono">
          {confirmationCode}
        </bdi>
      </p>
    </section>
  );
}

export default function DataDeletionStatusPage() {
  return (
    <MarketingShell>
      <Suspense fallback={null}>
        <DataDeletionStatusContent />
      </Suspense>
    </MarketingShell>
  );
}
