"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { CheckCircle2 } from "lucide-react";

function DataDeletionStatusContent() {
  const { locale } = useLanguage();
  const searchParams = useSearchParams();
  const confirmationCode = searchParams.get("id");

  const isAr = locale === "ar";

  return (
    <section className="container mx-auto px-6 py-20 max-w-xl text-center">
      <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-6" />
      <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-3">
        {isAr ? "تم حذف بياناتك" : "Your data has been deleted"}
      </h1>
      <p className="text-sm text-white/65 leading-relaxed mb-6">
        {isAr
          ? "قمنا بإزالة معلومات الوصول إلى حساب إنستغرام الخاص بك بالكامل من أنظمتنا. لا يلزم اتخاذ أي إجراء آخر."
          : "We've fully removed your Instagram account's access information from our systems. No further action is needed."}
      </p>
      {confirmationCode && (
        <p className="text-xs font-mono text-white/40 uppercase tracking-wider">
          {isAr ? "رمز التأكيد:" : "Confirmation code:"} {confirmationCode}
        </p>
      )}
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
