"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { cn } from "@/lib/utils";
import { Search, Layers, Keyboard, X, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "global_search_onboarding_seen_v1";

interface Step {
  icon: React.ReactNode;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
}

const STEPS: Step[] = [
  {
    icon: <Search className="h-8 w-8 text-violet-500" />,
    titleEn: "Global Search is here! 🔍",
    titleAr: "البحث الشامل وصل! 🔍",
    bodyEn: "Find any vehicle, customer, or lead instantly — just type a name, VIN, or phone number and results appear across all your data.",
    bodyAr: "ابحث عن أي مركبة أو عميل أو فرصة بيع على الفور — اكتب اسماً أو رقم الهيكل أو رقم الجوال وستظهر النتائج من كل بياناتك.",
  },
  {
    icon: <Layers className="h-8 w-8 text-violet-500" />,
    titleEn: "Everything in one place",
    titleAr: "كل شيء في مكان واحد",
    bodyEn: "Results are grouped by type — Vehicles, Customers, and Leads — so you always know exactly what you found.",
    bodyAr: "النتائج مقسّمة حسب النوع — المركبات والعملاء والعملاء المحتملين — حتى تعرف دائماً ما وجدته بالضبط.",
  },
  {
    icon: <Keyboard className="h-8 w-8 text-violet-500" />,
    titleEn: "Keyboard shortcut",
    titleAr: "اختصار لوحة المفاتيح",
    bodyEn: "Press ⌘K (Mac) or Ctrl+K (Windows) from anywhere in the app to open search instantly — or click the search bar up top.",
    bodyAr: "اضغط ⌘K (ماك) أو Ctrl+K (ويندوز) من أي مكان في التطبيق لفتح البحث فوراً — أو انقر على شريط البحث في الأعلى.",
  },
];

export function GlobalSearchOnboarding() {
  const { isRtl } = useLanguage();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    setMounted(true);
    if (!localStorage.getItem(STORAGE_KEY)) setVisible(true);
  }, []);

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  }

  function next() {
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      dismiss();
      setTimeout(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      }, 200);
    }
  }

  if (!mounted || !visible) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm"
        onClick={dismiss}
      />

      {/* Card — anchored top-center, pointing up at the search bar */}
      <div
        className={cn(
          "fixed z-[61] top-20 w-[320px] bg-white rounded-2xl shadow-2xl overflow-hidden",
          isRtl ? "left-1/2 -translate-x-1/2 md:left-auto md:translate-x-0 md:right-[30%]" : "left-1/2 -translate-x-1/2 md:left-[30%] md:translate-x-0"
        )}
      >
        {/* Progress bar */}
        <div className="h-1 bg-slate-100">
          <div
            className="h-full bg-violet-500 transition-all duration-300"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        {/* Dismiss */}
        <button
          onClick={dismiss}
          className="absolute top-3 end-3 p-1 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors z-10"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="px-5 pt-5 pb-4">
          {/* Icon */}
          <div className="w-14 h-14 rounded-2xl bg-violet-50 flex items-center justify-center mb-4">
            {current.icon}
          </div>

          {/* Text */}
          <h3 className="text-base font-bold text-slate-900 mb-2">
            {isRtl ? current.titleAr : current.titleEn}
          </h3>
          <p className="text-sm text-slate-500 leading-relaxed">
            {isRtl ? current.bodyAr : current.bodyEn}
          </p>

          {/* Step dots + button */}
          <div className="flex items-center justify-between mt-5">
            <div className="flex gap-1.5">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-200",
                    i === step ? "w-5 bg-violet-500" : "w-1.5 bg-slate-200"
                  )}
                />
              ))}
            </div>

            <Button size="sm" onClick={next} className="gap-1 bg-violet-600 hover:bg-violet-700">
              {isLast
                ? (isRtl ? "جرّبه الآن" : "Try it now")
                : (isRtl ? "التالي" : "Next")}
              {!isLast && <ChevronRight className={cn("h-3.5 w-3.5", isRtl && "rotate-180")} />}
            </Button>
          </div>
        </div>

        {/* Arrow pointing up toward the TopNav search bar */}
        <div
          className={cn(
            "absolute -top-2 w-4 h-4 bg-white rotate-45 shadow-md",
            isRtl ? "right-1/2 translate-x-1/2" : "left-1/2 -translate-x-1/2"
          )}
        />
      </div>

      {/* Spotlight ring around the TopNav search area */}
      <div
        className={cn(
          "fixed top-2 z-[60] h-10 w-64 rounded-lg",
          "border-2 border-violet-400 animate-pulse pointer-events-none",
          isRtl ? "right-[20%]" : "left-[20%]"
        )}
      />
    </>,
    document.body
  );
}
