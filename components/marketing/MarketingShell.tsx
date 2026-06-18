"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, ArrowRight, Globe } from "lucide-react";
import { useLanguage } from "@/components/providers/LanguageProvider";

const copy = {
  en: {
    back: "Back to home",
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    contact: "Contact Us",
    rights: "AUTOFLOW. All rights reserved.",
  },
  ar: {
    back: "العودة للرئيسية",
    privacy: "سياسة الخصوصية",
    terms: "شروط الخدمة",
    contact: "تواصل معنا",
    rights: "أوتوفلو. جميع الحقوق محفوظة.",
  },
};

export function MarketingShell({ children }: { children: React.ReactNode }) {
  const { locale, setLocale, isRtl } = useLanguage();
  const t = copy[locale] || copy.en;

  return (
    <div
      className="dark relative min-h-screen bg-[#030014] text-white selection:bg-blue-500/30 font-sans"
      style={{ direction: isRtl ? "rtl" : "ltr" }}
    >
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1f29370f_1px,transparent_1px),linear-gradient(to_bottom,#1f29370f_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none z-0" />
      <div className="absolute top-[-10%] right-[-5%] w-[40vw] h-[40vw] rounded-full bg-blue-600/10 blur-[130px] pointer-events-none z-0" />

      <header className="relative z-10 border-b border-white/5 bg-[#030014]/60 backdrop-blur-2xl">
        <div className="container mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt="AutoFlow Logo"
              width={160}
              height={50}
              className="w-28 h-auto object-contain opacity-95"
              priority
            />
          </Link>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setLocale(locale === "en" ? "ar" : "en")}
              className="px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/20 bg-white/5 hover:bg-white/10 text-xs font-bold uppercase transition-all duration-300 flex items-center gap-1.5 cursor-pointer text-white/80"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>{locale === "en" ? "العربية" : "EN"}</span>
            </button>

            <Link
              href="/"
              className="hidden sm:flex items-center gap-2 text-xs font-bold text-white/60 hover:text-white transition-colors duration-300"
            >
              {isRtl ? <ArrowRight className="w-3.5 h-3.5" /> : <ArrowLeft className="w-3.5 h-3.5" />}
              <span>{t.back}</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="relative z-10">{children}</main>

      <footer className="relative z-10 border-t border-white/5 py-10 bg-[#02000f]">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
          <p className="text-white/40 text-xs font-semibold tracking-wider">
            © {new Date().getFullYear()} {t.rights}
          </p>
          <div className="flex gap-6 text-xs font-semibold tracking-wider text-white/50 uppercase">
            <Link href="/privacy" className="hover:text-white transition-colors duration-300">{t.privacy}</Link>
            <Link href="/terms" className="hover:text-white transition-colors duration-300">{t.terms}</Link>
            <Link href="/contact" className="hover:text-white transition-colors duration-300">{t.contact}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
