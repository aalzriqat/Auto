"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { ChevronRight, Eye, Globe2, ShieldCheck, X } from "lucide-react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "dealer_website_onboarding_seen_v1";

type WebsiteOnboardingStep = {
  icon: React.ReactNode;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
};

const WEBSITE_ONBOARDING_STEPS: WebsiteOnboardingStep[] = [
  {
    icon: <Globe2 className="h-8 w-8 text-emerald-600" />,
    titleEn: "Dealer Website is ready",
    titleAr: "موقع المعرض جاهز",
    bodyEn: "Create a public website using a free autoflowdealer.com subdomain or a purchased custom domain.",
    bodyAr: "أنشئ موقعاً عاماً للمعرض باستخدام نطاق autoflowdealer.com مجاني أو نطاق مخصص.",
  },
  {
    icon: <ShieldCheck className="h-8 w-8 text-emerald-600" />,
    titleEn: "Public-safe by design",
    titleAr: "مصمم للنشر الآمن",
    bodyEn: "Only selected public data is published. Costs, margins, customer records, notes, and accounting data stay private.",
    bodyAr: "لا يتم نشر إلا البيانات العامة التي تختارها. التكاليف والأرباح والعملاء والملاحظات والمحاسبة تبقى خاصة.",
  },
  {
    icon: <Eye className="h-8 w-8 text-emerald-600" />,
    titleEn: "Preview before publishing",
    titleAr: "عاين قبل النشر",
    bodyEn: "Use the setup steps to pick sections, branding, and lead routing, then preview before going live.",
    bodyAr: "استخدم خطوات الإعداد لاختيار الأقسام والهوية وتحويل العملاء، ثم عاين الموقع قبل النشر.",
  },
];

export function WebsiteOnboarding() {
  const pathname = usePathname();
  const { isRtl } = useLanguage();
  const [isMounted, setIsMounted] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isMounted || !pathname.includes("/settings/website")) return;
    if (!localStorage.getItem(STORAGE_KEY)) setIsVisible(true);
  }, [isMounted, pathname]);

  function dismissOnboarding() {
    localStorage.setItem(STORAGE_KEY, "1");
    setIsVisible(false);
  }

  function advanceOnboarding() {
    if (stepIndex < WEBSITE_ONBOARDING_STEPS.length - 1) {
      setStepIndex((currentStep) => currentStep + 1);
      return;
    }
    dismissOnboarding();
  }

  if (!isMounted || !isVisible) return null;

  const currentStep = WEBSITE_ONBOARDING_STEPS[stepIndex];
  const isLastStep = stepIndex === WEBSITE_ONBOARDING_STEPS.length - 1;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm" onClick={dismissOnboarding} />
      <div
        className={cn(
          "fixed z-[61] top-24 w-[340px] overflow-hidden rounded-xl bg-white shadow-2xl",
          isRtl ? "left-4 md:left-auto md:right-72" : "right-4 md:right-72"
        )}
      >
        <div className="h-1 bg-slate-100">
          <div
            className="h-full bg-emerald-600 transition-all"
            style={{ width: `${((stepIndex + 1) / WEBSITE_ONBOARDING_STEPS.length) * 100}%` }}
          />
        </div>
        <button
          type="button"
          onClick={dismissOnboarding}
          className="absolute end-3 top-3 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label="Dismiss dealer website onboarding"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="p-5">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-emerald-50">
            {currentStep.icon}
          </div>
          <h3 className="text-base font-bold text-slate-950">
            {isRtl ? currentStep.titleAr : currentStep.titleEn}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            {isRtl ? currentStep.bodyAr : currentStep.bodyEn}
          </p>
          <div className="mt-5 flex items-center justify-between">
            <div className="flex gap-1.5">
              {WEBSITE_ONBOARDING_STEPS.map((onboardingStep, index) => (
                <div
                  key={onboardingStep.titleEn}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    index === stepIndex ? "w-5 bg-emerald-600" : "w-1.5 bg-slate-200"
                  )}
                />
              ))}
            </div>
            <Button size="sm" onClick={advanceOnboarding} className="gap-1 bg-emerald-700 hover:bg-emerald-800">
              {isLastStep ? (isRtl ? "ابدأ" : "Start") : (isRtl ? "التالي" : "Next")}
              {!isLastStep && <ChevronRight className={cn("h-3.5 w-3.5", isRtl && "rotate-180")} />}
            </Button>
          </div>
        </div>
        <div className={cn("absolute top-8 h-4 w-4 rotate-45 bg-white shadow-md", isRtl ? "-right-2" : "-left-2")} />
      </div>
      <div
        className={cn(
          "pointer-events-none fixed top-24 z-[60] h-12 w-52 rounded-lg border-2 border-emerald-400",
          "animate-pulse",
          isRtl ? "right-3 md:right-3" : "left-3 md:left-3"
        )}
      />
    </>,
    document.body
  );
}
