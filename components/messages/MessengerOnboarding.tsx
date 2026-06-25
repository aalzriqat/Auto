"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useMessenger } from "./MessengerContext";
import { cn } from "@/lib/utils";
import { MessagesSquare, Users, BellOff, CheckCheck, X, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "messenger_onboarding_seen_v1";

interface Step {
  icon: React.ReactNode;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
}

const STEPS: Step[] = [
  {
    icon: <MessagesSquare className="h-8 w-8 text-blue-500" />,
    titleEn: "Team Messenger is here! 🎉",
    titleAr: "الرسائل الداخلية وصلت! 🎉",
    bodyEn: "Chat directly with any team member — DMs or group conversations, right inside AutoFlow. No WhatsApp, no noise.",
    bodyAr: "تواصل مع أي عضو في فريقك مباشرةً — رسائل خاصة أو محادثات جماعية، داخل AutoFlow دون الحاجة لواتساب.",
  },
  {
    icon: <CheckCheck className="h-8 w-8 text-blue-500" />,
    titleEn: "Sent · Delivered · Seen",
    titleAr: "مُرسَل · مُستلَم · مقروء",
    bodyEn: "Every message shows a real-time status — one tick for sent, two grey for delivered, two blue for seen. Groups show mini avatars of who's read it.",
    bodyAr: "كل رسالة تُظهر حالتها لحظياً — ✓ للإرسال، ✓✓ رمادي للاستلام، ✓✓ أزرق للقراءة. المجموعات تُظهر صور من قرأها.",
  },
  {
    icon: <BellOff className="h-8 w-8 text-blue-500" />,
    titleEn: "Sounds & Mute",
    titleAr: "الأصوات وكتم الإشعارات",
    bodyEn: "You'll hear a Messenger-like sound for new messages. Tap the bell icon inside any conversation to mute it — per conversation, not globally.",
    bodyAr: "ستسمع صوت إشعار عند وصول رسائل جديدة. اضغط على أيقونة الجرس داخل أي محادثة لكتمها — يعمل لكل محادثة بشكل مستقل.",
  },
  {
    icon: <Users className="h-8 w-8 text-blue-500" />,
    titleEn: "Groups & DMs",
    titleAr: "مجموعات ورسائل خاصة",
    bodyEn: "Click the chat icon in the top bar or the blue button in the corner to open your conversations. Use the group icon to start a team group chat.",
    bodyAr: "اضغط على أيقونة المحادثات في الشريط العلوي أو الزر الأزرق في الزاوية لعرض محادثاتك. استخدم أيقونة المجموعة لإنشاء محادثة جماعية.",
  },
];

export function MessengerOnboarding() {
  const { isRtl } = useLanguage();
  const { toggleList } = useMessenger();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    setMounted(true);
    const seen = localStorage.getItem(STORAGE_KEY);
    if (!seen) setVisible(true);
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
      // Open the messenger panel so the user can explore
      setTimeout(() => toggleList(), 200);
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

      {/* Card */}
      <div
        className={cn(
          "fixed z-[61] bottom-24 w-[320px] bg-white rounded-2xl shadow-2xl overflow-hidden",
          isRtl ? "left-6" : "right-6"
        )}
      >
        {/* Progress bar */}
        <div className="h-1 bg-slate-100">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
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
          <div className="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center mb-4">
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
                    i === step ? "w-5 bg-blue-500" : "w-1.5 bg-slate-200"
                  )}
                />
              ))}
            </div>

            <Button size="sm" onClick={next} className="gap-1 bg-blue-600 hover:bg-blue-700">
              {isLast ? (isRtl ? "استكشف الآن" : "Explore now") : (isRtl ? "التالي" : "Next")}
              {!isLast && <ChevronRight className={cn("h-3.5 w-3.5", isRtl && "rotate-180")} />}
            </Button>
          </div>
        </div>

        {/* Arrow pointing to FAB */}
        <div
          className={cn(
            "absolute -bottom-2 w-4 h-4 bg-white rotate-45 shadow-md",
            isRtl ? "left-8" : "right-8"
          )}
        />
      </div>

      {/* Spotlight ring around the FAB */}
      <div
        className={cn(
          "fixed bottom-4 z-[60] w-20 h-20 rounded-full",
          "border-4 border-blue-400 animate-pulse pointer-events-none",
          isRtl ? "left-4" : "right-4"
        )}
      />
    </>,
    document.body
  );
}
