"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { cn } from "@/lib/utils";
import { Truck, Ban, ShieldAlert, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "feature_spotlight_seen_v3";

interface Slide {
  icon: React.ReactNode;
  accentColor: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
}

const SLIDES: Slide[] = [
  {
    icon: <Truck className="h-9 w-9 text-orange-500" />,
    accentColor: "border-orange-400/40 bg-orange-50 dark:bg-orange-950/30",
    titleEn: "Sourced / Special-Order Vehicles",
    titleAr: "المركبات المورَّدة والطلبيات الخاصة",
    bodyEn: `A customer wants a car you don't stock? Source it on demand. In the Sales Wizard tap "Source a vehicle for this customer" to add it inline — the quote continues immediately. Once the deal closes, the system posts an Accounts Payable entry to the supplier dealer and creates a trackable payable record. Visit the new Special Orders page to mark it paid when funds leave.`,
    bodyAr: `طلب عميل سيارة غير موجودة لديك؟ وفِّرها بناءً على الطلب. في معالج المبيعات اضغط "توريد مركبة لهذا العميل" لإضافتها مباشرةً — يستمر عرض السعر فوراً. بعد إغلاق الصفقة، يُسجَّل تلقائياً قيد "حسابات الدفع للموردين" مع سجل الذمة المستحقة. توجَّه إلى صفحة الطلبيات الخاصة لتأكيد الدفع عند سداد المبلغ.`,
  },
  {
    icon: <Ban className="h-9 w-9 text-rose-500" />,
    accentColor: "border-rose-400/40 bg-rose-50 dark:bg-rose-950/30",
    titleEn: "Cancel Any Finance Application — Even Finalized Ones",
    titleAr: "إلغاء أي طلب تمويل — حتى المغلق منها",
    bodyEn: `Submitted against the wrong car? Open the application and tap Cancel Application. For in-progress applications (Pending Docs through Approved) the vehicle hold is released and the application is voided. For finalized (Closed) deals, managers can fully reverse it: the sale is voided, the vehicle returns to Available, and every posted GL entry — revenue, COGS, commission, finance receivable — is reversed automatically, as long as disbursement has not been confirmed yet.`,
    bodyAr: `قُدِّم الطلب بسيارة خاطئة؟ افتح الطلب واضغط "إلغاء الطلب". للطلبات قيد المعالجة (من معلق المستندات حتى الموافقة) يُحرَّر حجز المركبة ويُلغى الطلب. للطلبات المغلقة (المُنهاة)، يمكن للمديرين عكس الصفقة بالكامل: إلغاء البيع وإعادة المركبة إلى متاحة مع عكس كل القيود المحاسبية (الإيراد، التكلفة، العمولة، الذمة) تلقائياً — ما لم يُؤكَّد استلام مبلغ الصرف.`,
  },
  {
    icon: <ShieldAlert className="h-9 w-9 text-purple-500" />,
    accentColor: "border-purple-400/40 bg-purple-50 dark:bg-purple-950/30",
    titleEn: "One Active Application Per Vehicle",
    titleAr: "طلب تمويل نشط واحد لكل مركبة",
    bodyEn: `The system now blocks creating a second active finance application for a vehicle that already has one in progress. If a mistake was made (wrong vehicle, wrong customer), cancel the existing application first. Cancelled applications don't count, so once voided you're free to start fresh with the correct vehicle.`,
    bodyAr: `يمنع النظام الآن إنشاء طلب تمويل نشط ثانٍ لمركبة لديها طلب قائم. إذا حدث خطأ (مركبة خاطئة أو عميل خاطئ)، ألغِ الطلب الموجود أولاً. الطلبات الملغاة لا تُحتسب، فبعد الإلغاء يمكنك البدء من جديد بالتفاصيل الصحيحة.`,
  },
];

export function FeatureSpotlight() {
  const { isRtl } = useLanguage();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    setMounted(true);
    if (!localStorage.getItem(STORAGE_KEY)) {
      const t = setTimeout(() => setVisible(true), 1200);
      return () => clearTimeout(t);
    }
  }, []);

  // Dismiss on Escape key
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visible]);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  };

  const current = SLIDES[slide];
  const isLast = slide === SLIDES.length - 1;

  if (!mounted || !visible) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      dir={isRtl ? "rtl" : "ltr"}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={dismiss}
        aria-hidden="true"
      />

      {/* Card */}
      <div
        className={cn(
          "relative z-10 w-full max-w-lg rounded-2xl border bg-background shadow-2xl",
          "animate-in fade-in zoom-in-95 duration-300",
          current.accentColor
        )}
      >
        {/* Close button */}
        <button
          onClick={dismiss}
          className={cn(
            "absolute top-4 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors",
            isRtl ? "left-4" : "right-4"
          )}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Progress dots */}
        <div className="flex justify-center gap-1.5 pt-5 pb-2">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              onClick={() => setSlide(i)}
              className={cn(
                "h-2 rounded-full transition-all duration-300",
                i === slide
                  ? "w-6 bg-primary"
                  : "w-2 bg-muted-foreground/30 hover:bg-muted-foreground/50"
              )}
              aria-label={`Go to slide ${i + 1}`}
              aria-current={i === slide ? "true" : undefined}
            />
          ))}
        </div>

        {/* Content */}
        <div className="px-6 pb-6 pt-2 space-y-4">
          <div className="flex flex-col items-center text-center gap-3 py-2">
            <div className="p-3 rounded-xl bg-background shadow-sm border">
              {current.icon}
            </div>
            <h2 className="text-lg font-bold leading-snug">
              {isRtl ? current.titleAr : current.titleEn}
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {isRtl ? current.bodyAr : current.bodyEn}
            </p>
          </div>

          {/* Navigation */}
          <div className={cn("flex gap-2 pt-1", isRtl && "flex-row-reverse")}>
            {!isLast ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={dismiss}
                >
                  {isRtl ? "تخطي" : "Skip"}
                </Button>
                <Button
                  size="sm"
                  className="flex-1 gap-1"
                  onClick={() => setSlide((s) => s + 1)}
                >
                  {isRtl ? "التالي" : "Next"}
                  <ChevronRight className={cn("h-3.5 w-3.5", isRtl && "rotate-180")} />
                </Button>
              </>
            ) : (
              <Button size="sm" className="flex-1" onClick={dismiss}>
                {isRtl ? "فهمت، شكراً!" : "Got it, thanks!"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
