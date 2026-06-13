"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, useRef, useEffect } from "react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { 
  ArrowLeft, 
  ArrowRight, 
  Sparkles, 
  Fingerprint, 
  Activity, 
  Zap, 
  Calculator, 
  TrendingUp, 
  Clock, 
  ShieldCheck, 
  Check, 
  Workflow, 
  Building2, 
  Users, 
  Menu, 
  X, 
  Calendar,
  Layers,
  ChevronRight,
  TrendingDown,
  Globe
} from "lucide-react";
import { motion, AnimatePresence, useScroll, useTransform, useMotionValue, useSpring } from "framer-motion";

// Custom type definitions for localization
interface LocalCopy {
  navFeatures: string;
  navCalculator: string;
  navWorkflow: string;
  navPricing: string;
  navLogin: string;
  navStart: string;
  heroBadge: string;
  heroTitle1: string;
  heroTitle2: string;
  heroSubhead: string;
  heroCTA: string;
  heroDemo: string;
  calcTitle: string;
  calcSub: string;
  calcVal: string;
  calcDown: string;
  calcRate: string;
  calcTerm: string;
  calcMonthly: string;
  calcPrinc: string;
  calcInterest: string;
  calcTotalPaid: string;
  calcMonths: string;
  pipeTitle: string;
  pipeSub: string;
  pipeBtn: string;
  pipeBtnAuto: string;
  bentoTitle: string;
  bentoSub: string;
  bentoCard1Title: string;
  bentoCard1Desc: string;
  bentoCard2Title: string;
  bentoCard2Desc: string;
  bentoCard3Title: string;
  bentoCard3Desc: string;
  bentoCard4Title: string;
  bentoCard4Desc: string;
  roiTitle: string;
  roiSub: string;
  roiSales: string;
  roiHours: string;
  roiHoursSub: string;
  roiSavings: string;
  roiSavingsSub: string;
  pricingTitle: string;
  pricingSub: string;
  pricingMonthly: string;
  pricingAnnual: string;
  pricingBadge: string;
  pricingButton: string;
  faqTitle: string;
  faqSub: string;
  footerRights: string;
  footerPrivacy: string;
  footerTerms: string;
}

const copy: Record<"en" | "ar", LocalCopy> = {
  en: {
    navFeatures: "Features",
    navCalculator: "Financing Calculator",
    navWorkflow: "Deal Flow",
    navPricing: "Pricing",
    navLogin: "Sign In",
    navStart: "Get Started",
    heroBadge: "AUTOFLOW OS • THE DEALERSHIP STANDARD",
    heroTitle1: "The Creative Engine",
    heroTitle2: "For Elite Car Dealerships",
    heroSubhead: "Ditch slow spreadsheets. Manage luxury inventory, automate credit approvals, and scale sales pipeline in a fast, unified digital workspace.",
    heroCTA: "Claim Your Showroom Space",
    heroDemo: "Explore Interactive Demo",
    calcTitle: "Showroom Finance Estimator",
    calcSub: "Empower your clients with credit breakdowns. Adjust vehicle values and downpayments in real-time.",
    calcVal: "Vehicle Value",
    calcDown: "Down Payment",
    calcRate: "Interest Rate (APR)",
    calcTerm: "Financing Term",
    calcMonthly: "Monthly Installment",
    calcPrinc: "Principal Amount",
    calcInterest: "Total Interest Cost",
    calcTotalPaid: "Total Paid Balance",
    calcMonths: "Months",
    pipeTitle: "Live Deal Flow Automation",
    pipeSub: "Simulate a client sales cycle. Watch statuses transition instantly across the database pipeline.",
    pipeBtn: "Step Next Stage",
    pipeBtnAuto: "Simulate Auto-Run",
    bentoTitle: "Designed for Velocity. Engineered for Control.",
    bentoSub: "A complete vehicle dealership operating system combining beautiful interfaces with secure workflows.",
    bentoCard1Title: "Live Inventory & VIN Auditing",
    bentoCard1Desc: "Instantly index custom vehicle specifications, track repair statuses, and fetch car profiles in milliseconds.",
    bentoCard2Title: "Sub-Second Sync Engine",
    bentoCard2Desc: "Deal data, payments, and sales statuses propagate instantly to all managers via Convex WebSockets.",
    bentoCard3Title: "Margin & Profit Protection",
    bentoCard3Desc: "Automatically route profit reductions below targets to manager queues for secure numeric override authorization.",
    bentoCard4Title: "360° Client Profile Hub",
    bentoCard4Desc: "Track complete customer interaction logs, financing applications, test-drive waivers, and follow-ups.",
    roiTitle: "Calculate Your Showroom ROI",
    roiSub: "See how much time and operational costs you save with AutoFlow every month.",
    roiSales: "Vehicles Sold Monthly",
    roiHours: "Hours Saved / Wk",
    roiHoursSub: "Freed from manual spreadsheet entries",
    roiSavings: "Annual Profit Gain",
    roiSavingsSub: "Through workflow efficiency & faster lead closes",
    pricingTitle: "Elite Dealership Plans",
    pricingSub: "Zero complexity. One simple price built for high-performance showrooms.",
    pricingMonthly: "Monthly Billing",
    pricingAnnual: "Annual Billing (20% Off)",
    pricingBadge: "Best Value",
    pricingButton: "Elevate Your Dealership Now",
    faqTitle: "Frequently Asked Questions",
    faqSub: "Everything you need to know about migrating your showroom operations.",
    footerRights: "AUTOFLOW. All rights reserved.",
    footerPrivacy: "Privacy Policy",
    footerTerms: "Terms of Service"
  },
  ar: {
    navFeatures: "الميزات",
    navCalculator: "حاسبة التمويل",
    navWorkflow: "دورة العمل",
    navPricing: "الأسعار",
    navLogin: "دخول",
    navStart: "ابدأ الآن",
    heroBadge: "نظام أوتوفلو • المعيار الحديث لإدارة المعارض",
    heroTitle1: "المحرك الإبداعي",
    heroTitle2: "لمعارض السيارات النخبة",
    heroSubhead: "ودع الجداول التقليدية البطيئة. أدر مخزونك الفاخر، وأتمت موافقات التمويل، وضاعف مبيعاتك في منصة سحابية واحدة تمتاز بالسرعة والجمال.",
    heroCTA: "احجز مساحة معرضك الآن",
    heroDemo: "استكشف العرض التفاعلي",
    calcTitle: "حاسبة التمويل التفاعلية",
    calcSub: "امنح عملائك حسابات فورية لأقساط التمويل. اسحب المؤشرات لتعديل قيمة المركبة والتمويل في الوقت الفعلي.",
    calcVal: "سعر المركبة",
    calcDown: "الدفعة الأولى",
    calcRate: "نسبة الفائدة السنوية",
    calcTerm: "فترة التمويل",
    calcMonthly: "القسط الشهري المتوقع",
    calcPrinc: "مبلغ التمويل الأساسي",
    calcInterest: "إجمالي الفوائد",
    calcTotalPaid: "إجمالي المدفوعات",
    calcMonths: "شهراً",
    pipeTitle: "أتمتة مراحل الصفقات الحية",
    pipeSub: "حاكِ دورة حياة العميل بنقرة واحدة. شاهد تحديث حالة الطلبات تلقائياً عبر قاعدة البيانات.",
    pipeBtn: "المرحلة التالية",
    pipeBtnAuto: "محاكاة تلقائية",
    bentoTitle: "هندسة متناهية السرعة والتحكم.",
    bentoSub: "نظام تشغيل متكامل يجمع بين الواجهات الفخمة وقواعد البيانات الموثوقة والآمنة.",
    bentoCard1Title: "مخزون حي وفحص رقم الشاصي",
    bentoCard1Desc: "فهرسة مواصفات السيارات بدقة، وتتبع حالة الصيانة، وتحميل صور المعرض في أقل من 30 مللي ثانية.",
    bentoCard2Title: "مزامنة لحظية فائقة",
    bentoCard2Desc: "مزامنة فورية لكل صفقة أو دفعة عبر جميع موظفي المبيعات باستخدام تقنيات Convex المتطورة.",
    bentoCard3Title: "حماية هوامش أرباح المعرض",
    bentoCard3Desc: "توجيه طلبات تخفيض هامش الربح تلقائياً لمدير المعرض لاعتمادها أو رفضها بشكل آمن ومحمي.",
    bentoCard4Title: "ملفات عملاء متكاملة 360°",
    bentoCard4Desc: "سجل كامل لتعاملات المشتري، وطلبات التمويل النشطة، وحجوزات قيادة المركبات والمهام المعلقة.",
    roiTitle: "احسب العائد على استثمار معرضك",
    roiSub: "قدّر أوقات العمل والمبالغ السنوية التي يوفرها معرضك عند استخدام أوتوفلو.",
    roiSales: "عدد السيارات المباعة شهرياً",
    roiHours: "ساعات عمل موفرة أسبوعياً",
    roiHoursSub: "من خلال تقليل مدخلات البيانات اليدوية والتكرارية",
    roiSavings: "التوفير المالي السنوي",
    roiSavingsSub: "بفضل رفع سرعة إغلاق الصفقات وتحسين أداء مبيعاتك",
    pricingTitle: "الاستثمار في التميز",
    pricingSub: "لا توجد تعقيدات. باقة واحدة تشمل كل شيء، مصممة للمعارض التي لا ترضى بأقل من الكمال.",
    pricingMonthly: "فاتورة شهرية",
    pricingAnnual: "فاتورة سنوية (خصم 20%)",
    pricingBadge: "الأكثر طلباً",
    pricingButton: "ارتقِ بمعرضك إلى النخبة الآن",
    faqTitle: "الأسئلة الشائعة",
    faqSub: "كل ما تود معرفته عن ترحيل بيانات معرضك ونظام أوتوفلو.",
    footerRights: "أوتوفلو. جميع الحقوق محفوظة.",
    footerPrivacy: "سياسة الخصوصية",
    footerTerms: "شروط الخدمة"
  }
};

export default function CreativeMarketingPage() {
  const { locale, setLocale, isRtl } = useLanguage();
  const t = copy[locale] || copy.en;

  // Toggle Language Handler
  const handleToggleLang = () => {
    setLocale(locale === "en" ? "ar" : "en");
  };

  // State for mobile menu
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Background Interactive Glow Mouse Movement
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const handleGlobalMouseMove = (e: React.MouseEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
  };

  // Scroll Animations for Mockup
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const mockupSectionRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: mockupSectionRef,
    offset: ["start end", "end start"]
  });

  const mockupScale = useTransform(scrollYProgress, [0, 0.4], [0.85, 1.05]);
  const mockupRotateX = useTransform(scrollYProgress, [0, 0.4], [15, 0]);
  const mockupTranslateY = useTransform(scrollYProgress, [0, 0.4], [60, 0]);

  // Buttery Mouse-Tilt Parallax for Mockup
  const cardX = useMotionValue(0);
  const cardY = useMotionValue(0);
  const tiltRotateX = useTransform(cardY, [-200, 200], [10, -10]);
  const tiltRotateY = useTransform(cardX, [-300, 300], [-10, 10]);
  const springConfig = { damping: 25, stiffness: 180 };
  const springRotateX = useSpring(tiltRotateX, springConfig);
  const springRotateY = useSpring(tiltRotateY, springConfig);

  const handleCardMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const clientX = e.clientX - rect.left - width / 2;
    const clientY = e.clientY - rect.top - height / 2;
    cardX.set(clientX);
    cardY.set(clientY);
  };

  const handleCardMouseLeave = () => {
    cardX.set(0);
    cardY.set(0);
  };

  // --- Widget A: Finance Calculator State ---
  const [carPrice, setCarPrice] = useState(95000);
  const [downPayment, setDownPayment] = useState(20000);
  const [apr, setApr] = useState(5.4);
  const [term, setTerm] = useState(60);

  // Keep downpayment capped at carPrice
  useEffect(() => {
    if (downPayment > carPrice) {
      setDownPayment(carPrice);
    }
  }, [carPrice, downPayment]);

  const principal = Math.max(0, carPrice - downPayment);
  const monthlyInterestRate = (apr / 12) / 100;
  
  let monthlyInstallment = 0;
  let totalPaid = 0;
  let totalInterest = 0;

  if (principal > 0) {
    if (monthlyInterestRate > 0) {
      monthlyInstallment = (principal * monthlyInterestRate * Math.pow(1 + monthlyInterestRate, term)) / (Math.pow(1 + monthlyInterestRate, term) - 1);
      totalPaid = monthlyInstallment * term;
      totalInterest = totalPaid - principal;
    } else {
      monthlyInstallment = principal / term;
      totalPaid = principal;
      totalInterest = 0;
    }
  }

  // Percentage calculations for SVG Circle Breakdown
  const principalPercent = totalPaid > 0 ? (principal / totalPaid) * 100 : 100;
  const interestPercent = totalPaid > 0 ? (totalInterest / totalPaid) * 100 : 0;
  const strokeDasharray = 2 * Math.PI * 40; // R=40 circle
  const strokeDashoffset = strokeDasharray * (1 - (principalPercent / 100));

  // --- Widget B: Deal Pipeline Simulation ---
  const [pipelineStage, setPipelineStage] = useState(0);
  const [pipelineData, setPipelineData] = useState({
    client: "Sarah Jenkins",
    vehicle: "2024 Porsche 911 Carrera S",
    price: "$134,200",
    creditScore: "785 (Excellent)",
    terms: "60 mo @ 4.9% APR",
    status: "New Lead Captured"
  });

  const pipelineStages = [
    {
      labelEn: "Lead Ingestion",
      labelAr: "تسجيل العميل",
      statusEn: "CRM Registered",
      statusAr: "تم التسجيل بالنظام",
      descEn: "Website inquiry auto-converts to workflow, allocating to matching luxury agent.",
      descAr: "تحويل استفسار الموقع تلقائياً إلى صفقة عمل مع تعيين ممثل مبيعات مناسب.",
    },
    {
      labelEn: "Test Drive",
      labelAr: "تجربة القيادة",
      statusEn: "Waiver Signed",
      statusAr: "توقيع نموذج القيادة",
      descEn: "Generates digital waiver form, registers vehicle keys, and alerts yard staff.",
      descAr: "إنشاء رقمي لتفويض القيادة، تتبع المفاتيح الذكية، وتنبيه موظفي المعرض.",
    },
    {
      labelEn: "Credit Decided",
      labelAr: "قرار التمويل",
      statusEn: "Terms Configured",
      statusAr: "تم تحديد الشروط",
      descEn: "AutoFlow coordinates with underwriting banks to compute payment approval thresholds.",
      descAr: "حساب فوري للأرباح وهوامش التمويل بالتنسيق مع البنوك المعتمدة.",
    },
    {
      labelEn: "Delivered",
      labelAr: "تسليم السيارة",
      statusEn: "Deal Completed",
      statusAr: "تم اكتمال البيع",
      descEn: "Instantly locks PDF invoice contract, modifies inventory status to 'Sold', triggers audit log.",
      descAr: "توليد العقد النهائي بصيغة PDF، تحديث حالة السيارة إلى 'مباعة'، وحفظ سجل الفحص.",
    }
  ];

  const handleNextPipelineStage = () => {
    setPipelineStage((prev) => (prev + 1) % 4);
  };

  const handleSimulateAuto = () => {
    let current = 0;
    setPipelineStage(0);
    const interval = setInterval(() => {
      current++;
      if (current >= 4) {
        clearInterval(interval);
      } else {
        setPipelineStage(current);
      }
    }, 2000);
  };

  // --- Widget C: ROI Estimator State ---
  const [monthlySales, setMonthlySales] = useState(35);
  const hoursSavedPerWk = Math.round(monthlySales * 0.85);
  const annualSavingsDollars = Math.round(monthlySales * 38 * 12);

  // --- Widget D: Pricing Card Toggle ---
  const [billingPeriod, setBillingPeriod] = useState<"monthly" | "annual">("annual");

  // --- FAQ State ---
  const [activeFaq, setActiveFaq] = useState<number | null>(null);
  const faqs = [
    {
      qEn: "Can we transfer our existing vehicle stock and customer list?",
      qAr: "هل يمكننا نقل قائمة السيارات والعملاء الحالية لدينا بسهولة؟",
      aEn: "Absolutely. AutoFlow provides clean CSV and JSON templates to batch-import your entire inventory and customer history in minutes. Our tech staff is also available for direct database migrations.",
      aAr: "بالتأكيد. يوفر أوتوفلو قوالب استيراد مرنة بصيغة CSV و JSON لرفع مخزونك وبيانات العملاء دفعة واحدة خلال دقائق. فريقنا التقني متواجد أيضاً لمساعدتك في نقل البيانات بالكامل."
    },
    {
      qEn: "How do profit protection thresholds and approvals work?",
      qAr: "كيف تعمل حماية هوامش أرباح الصفقات واعتماد المعاملات؟",
      aEn: "You set target profit percentages per brand or branch. If a salesperson configurations a deal below these margins, AutoFlow automatically blocks invoicing and pushes a secure approval request to the manager dashboard with SMS notifications.",
      aAr: "يمكنك تحديد هوامش الربح المستهدفة لكل علامة تجارية أو فرع. إذا حاول موظف المبيعات إدخال صفقة بأرباح أقل، يقوم النظام تلقائياً بتجميدها وإرسال طلب موافقة فوري لهاتف لوحة تحكم المدير لإقرارها أو رفضها."
    },
    {
      qEn: "Is AutoFlow optimized for multi-branch dealerships?",
      qAr: "هل يدعم أوتوفلو معارض السيارات ذات الفروع المتعددة؟",
      aEn: "Yes. Our enterprise plan supports granular branch-scoping, permitting salesmen to view local stock while enabling executives to monitor consolidated inventory, sales, and analytics across all regional sites.",
      aAr: "نعم. يدعم أوتوفلو تقسيم الصلاحيات والمخزون للفروع المتعددة. حيث يمكن للموظف رؤية سيارات فرعه المحلي فقط، بينما يستطيع المسؤول العام تتبع كافة الفروع والتقارير المالية المدمجة بكفاءة."
    }
  ];

  return (
    <div 
      ref={pageContainerRef} 
      onMouseMove={handleGlobalMouseMove}
      className={`dark relative min-h-screen bg-[#030014] text-white selection:bg-indigo-500/30 overflow-hidden font-sans`}
      style={{ direction: isRtl ? "rtl" : "ltr" }}
    >
      
      {/* 20-Year Exp Interactive Background Canvas */}
      {/* 1. Global mouse follower glow */}
      <div 
        className="fixed inset-0 pointer-events-none z-0 transition-opacity duration-500"
        style={{
          background: `radial-gradient(700px circle at ${mousePos.x}px ${mousePos.y}px, rgba(99, 102, 241, 0.08), transparent 45%)`
        }}
      />
      {/* 2. Abstract Glowing Vector Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1f29370f_1px,transparent_1px),linear-gradient(to_bottom,#1f29370f_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none z-0" />
      
      {/* 3. Deep Cinematic Nebula Orbs */}
      <div className="absolute top-[-10%] right-[-5%] w-[45vw] h-[45vw] rounded-full bg-indigo-600/10 blur-[130px] animate-pulse pointer-events-none z-0" style={{ animationDuration: "12s" }} />
      <div className="absolute bottom-[20%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-blue-500/5 blur-[150px] pointer-events-none z-0" />
      <div className="absolute top-[40%] left-[30%] w-[35vw] h-[35vw] rounded-full bg-purple-600/5 blur-[140px] pointer-events-none z-0" />

      {/* Bespoke Header */}
      <header className="fixed top-0 inset-x-0 z-50 w-full bg-[#030014]/40 backdrop-blur-2xl border-b border-white/5 transition-all duration-300">
        <div className="container mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 relative z-10">
            <Image 
              src="/logo.png" 
              alt="AutoFlow Logo" 
              width={160} 
              height={50} 
              className="w-28 h-auto object-contain brightness-0 invert opacity-95 transition-transform duration-500 hover:scale-105" 
              priority 
            />
          </Link>
          
          <nav className="hidden lg:flex items-center gap-8 text-xs font-semibold tracking-wider text-white/60 uppercase">
            <a href="#features" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navFeatures}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-indigo-500 group-hover:w-full transition-all duration-300" />
            </a>
            <a href="#calculator" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navCalculator}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-indigo-500 group-hover:w-full transition-all duration-300" />
            </a>
            <a href="#workflow" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navWorkflow}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-indigo-500 group-hover:w-full transition-all duration-300" />
            </a>
            <a href="#pricing" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navPricing}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-indigo-500 group-hover:w-full transition-all duration-300" />
            </a>
          </nav>

          <div className="flex items-center gap-4 z-10">
            {/* Language Switcher */}
            <button 
              onClick={handleToggleLang}
              className="px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/20 bg-white/5 hover:bg-white/10 text-xs font-bold uppercase transition-all duration-300 flex items-center gap-1.5 cursor-pointer text-white/80"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>{locale === "en" ? "العربية" : "EN"}</span>
            </button>

            <Link href="/sign-in" className="text-xs font-bold text-white/60 hover:text-white transition-colors duration-300 py-2">
              {t.navLogin}
            </Link>

            <Link href="/sign-up" className="relative group">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-full blur opacity-40 group-hover:opacity-100 transition duration-700" />
              <button className="relative px-6 py-2.5 bg-black hover:bg-[#07051a] rounded-full flex items-center gap-2 border border-white/10 group-hover:border-indigo-500/30 transition-colors duration-300 cursor-pointer">
                <span className="text-white text-xs font-bold">{t.navStart}</span>
                {isRtl ? <ArrowLeft className="w-3.5 h-3.5 text-white/70" /> : <ArrowRight className="w-3.5 h-3.5 text-white/70" />}
              </button>
            </Link>

            {/* Mobile Menu Icon */}
            <button 
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-1.5 text-white/80 hover:text-white"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Menu overlay */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="fixed top-20 inset-x-0 z-40 bg-[#030014]/95 border-b border-white/5 p-6 backdrop-blur-3xl lg:hidden flex flex-col gap-4 text-center"
          >
            <a 
              href="#features" 
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-indigo-400 transition-colors"
            >
              {t.navFeatures}
            </a>
            <a 
              href="#calculator" 
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-indigo-400 transition-colors"
            >
              {t.navCalculator}
            </a>
            <a 
              href="#workflow" 
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-indigo-400 transition-colors"
            >
              {t.navWorkflow}
            </a>
            <a 
              href="#pricing" 
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-indigo-400 transition-colors"
            >
              {t.navPricing}
            </a>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="relative z-10 pt-20">
        
        {/* Cinematic Premium Hero */}
        <section className="relative min-h-[90vh] flex items-center justify-center pt-16 pb-12">
          <div className="container mx-auto px-6 max-w-6xl flex flex-col items-center text-center">
            
            {/* Ambient Badge */}
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
              className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-md mb-8"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-[10px] sm:text-xs font-bold tracking-widest text-indigo-200/90">{t.heroBadge}</span>
            </motion.div>
            
            {/* Split Title Animations */}
            <h1 className="text-[2.25rem] sm:text-[4rem] lg:text-[5.5rem] font-black leading-[1.05] tracking-tight mb-8">
              <motion.span 
                initial={{ opacity: 0, y: 35 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
                className="block text-white"
              >
                {t.heroTitle1}
              </motion.span>
              <motion.span 
                initial={{ opacity: 0, y: 35 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="block text-transparent bg-clip-text bg-gradient-to-r from-indigo-200 via-indigo-400 to-purple-500"
              >
                {t.heroTitle2}
              </motion.span>
            </h1>
            
            <motion.p 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.2, delay: 0.5 }}
              className="text-base sm:text-lg lg:text-xl text-white/50 max-w-2xl mx-auto leading-relaxed font-medium mb-12"
            >
              {t.heroSubhead}
            </motion.p>
            
            {/* Button Interactions */}
            <motion.div 
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1, delay: 0.7 }}
              className="flex flex-col sm:flex-row items-center gap-5 justify-center w-full"
            >
              <Link href="/sign-up" className="relative group w-full sm:w-auto">
                <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-indigo-600 rounded-full blur opacity-60 group-hover:opacity-100 transition duration-700" />
                <button className="relative w-full sm:w-auto px-10 py-4.5 bg-white text-black font-bold rounded-full flex items-center justify-center gap-3 hover:bg-white/95 transition-colors cursor-pointer text-sm">
                  <span>{t.heroCTA}</span>
                  {isRtl ? <ArrowLeft className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
                </button>
              </Link>
              
              <a href="#features" className="w-full sm:w-auto">
                <button className="w-full sm:w-auto px-8 py-4.5 bg-white/5 border border-white/10 hover:border-white/20 rounded-full text-sm font-semibold tracking-wide text-white/80 hover:text-white backdrop-blur-md transition-all duration-300 cursor-pointer">
                  {t.heroDemo}
                </button>
              </a>
            </motion.div>
          </div>
        </section>

        {/* Scroll-Linked 3D Mockup Showcase */}
        <section ref={mockupSectionRef} className="relative w-full px-6 pb-24 z-20">
          <div className="max-w-6xl mx-auto flex justify-center">
            
            {/* Animated Parent Wrapper (Links to scroll zoom & perspective rotate) */}
            <motion.div 
              style={{
                scale: mockupScale,
                rotateX: mockupRotateX,
                y: mockupTranslateY,
                transformPerspective: 1200,
              }}
              className="w-full"
            >
              
              {/* Inner Mouse Parallax Tilt Container */}
              <motion.div
                onMouseMove={handleCardMouseMove}
                onMouseLeave={handleCardMouseLeave}
                style={{
                  rotateX: springRotateX,
                  rotateY: springRotateY,
                }}
                className="relative w-full rounded-2xl md:rounded-3xl border border-white/10 bg-[#090622]/85 shadow-[0_0_120px_rgba(99,102,241,0.15)] overflow-hidden aspect-[16/10] backdrop-blur-3xl transition-shadow duration-700 hover:shadow-[0_0_150px_rgba(99,102,241,0.25)] group"
              >
                
                {/* Visual Glass Overlay reflection */}
                <div className="absolute inset-0 bg-gradient-to-tr from-white/0 via-white/5 to-white/0 opacity-0 group-hover:opacity-100 transition-opacity duration-1000 pointer-events-none" />
                
                {/* Browser Top Bar */}
                <div className="h-12 border-b border-white/5 flex items-center justify-between px-6 gap-3 select-none" style={{ direction: "ltr" }}>
                  <div className="flex gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500/60" />
                    <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                    <div className="w-3 h-3 rounded-full bg-green-500/60" />
                  </div>
                  <div className="bg-white/5 px-6 py-1 rounded text-[10px] text-white/30 font-semibold tracking-wider w-40 text-center truncate">
                    autoflow.io/dashboard
                  </div>
                  <div className="w-16" />
                </div>
                
                {/* Live mock screen display */}
                <div className="relative w-full h-[calc(100%-3rem)] bg-[#030014] select-none overflow-hidden">
                  <Image 
                    src="/dashboard-mockup-v2.png" 
                    alt="AutoFlow Enterprise Dashboard Interface Preview" 
                    fill
                    priority
                    className="object-cover object-top opacity-85 group-hover:opacity-95 transition-opacity duration-700"
                  />
                  
                  {/* Internal ambient glowing points */}
                  <div className="absolute top-1/4 left-1/3 w-32 h-32 bg-indigo-500/10 rounded-full blur-3xl" />
                  <div className="absolute bottom-1/4 right-1/4 w-40 h-40 bg-purple-500/10 rounded-full blur-3xl" />
                </div>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Bento Grid Features Showcase */}
        <section id="features" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-20">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-4">
                {t.bentoTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/40 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.bentoSub}
              </p>
            </div>

            {/* Asymmetrical Bento Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 auto-rows-[280px] md:auto-rows-[260px]">
              
              {/* Feature 1: Live Inventory (Double Column) */}
              <motion.div 
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8 }}
                className="md:col-span-2 md:row-span-2 rounded-2xl bg-gradient-to-br from-white/5 to-[#05031b] border border-white/5 p-8 relative overflow-hidden group hover:border-indigo-500/30 transition-all duration-500 flex flex-col justify-between"
              >
                {/* Floating graphic overlay */}
                <div className="absolute top-0 right-0 w-80 h-80 bg-indigo-500/[0.02] rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
                
                {/* Interactive Showroom Stock Mini-Widget */}
                <div className="relative z-10 w-full h-full flex flex-col justify-between gap-6">
                  <div className="flex items-center justify-between">
                    <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                      <Layers className="w-5 h-5 text-indigo-400" />
                    </div>
                    <span className="text-[10px] font-bold text-indigo-400/80 uppercase tracking-widest bg-indigo-500/5 px-3 py-1 rounded-full border border-indigo-500/10">Interactive Sandbox</span>
                  </div>

                  {/* Mock Inventory List */}
                  <div className="space-y-2.5 my-4">
                    {[
                      { name: "Porsche 911 GT3 RS", vin: "WP0AC2A98HS12", status: "Reserved", statusAr: "محجوزة", color: "text-amber-400 bg-amber-400/5 border-amber-400/20", price: "$223,800" },
                      { name: "Mercedes-AMG GT Black Series", vin: "WDDJK9FB2HA04", status: "Available", statusAr: "متوفرة", color: "text-emerald-400 bg-emerald-400/5 border-emerald-400/20", price: "$325,000" },
                      { name: "Ferrari 296 GTB", vin: "ZFF89LHB7KS09", status: "Sold", statusAr: "مباعة", color: "text-indigo-400 bg-indigo-400/5 border-indigo-400/20", price: "$318,500" }
                    ].map((car, idx) => (
                      <div 
                        key={idx} 
                        className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300"
                      >
                        <div className="flex flex-col text-left" style={{ direction: "ltr" }}>
                          <span className="text-xs font-bold text-white/90">{car.name}</span>
                          <span className="text-[9px] text-white/30 font-semibold mt-0.5">VIN: {car.vin}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-extrabold text-white/80">{car.price}</span>
                          <span className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded border ${car.color}`}>
                            {locale === "ar" ? car.statusAr : car.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div>
                    <h3 className="text-lg sm:text-xl font-bold text-white mb-2">{t.bentoCard1Title}</h3>
                    <p className="text-xs sm:text-sm text-white/50 leading-relaxed max-w-xl">{t.bentoCard1Desc}</p>
                  </div>
                </div>
              </motion.div>

              {/* Feature 2: Sync Engine (Single Column) */}
              <motion.div 
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.15 }}
                className="rounded-2xl bg-[#090622]/85 border border-white/5 p-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-indigo-400" />
                  </div>
                  {/* Ping Animation indicator */}
                  <div className="flex items-center gap-1.5 bg-emerald-500/5 px-2.5 py-1 rounded border border-emerald-500/10">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
                    <span className="text-[9px] text-emerald-400 font-extrabold tracking-wider uppercase">Active Live Sync</span>
                  </div>
                </div>
                
                {/* Ping speedometer mock */}
                <div className="bg-black/40 rounded-xl p-3 border border-white/5 text-center my-2 select-none" style={{ direction: "ltr" }}>
                  <div className="text-xs text-white/40 font-bold mb-1">Websocket Latency</div>
                  <div className="text-2xl font-black text-indigo-400 tracking-tight">
                    12<span className="text-xs text-white/60 font-semibold ml-0.5">ms</span>
                  </div>
                  <div className="text-[9px] text-white/20 font-bold mt-1">Convex Reactive Subscriptions</div>
                </div>

                <div>
                  <h3 className="text-base font-bold text-white mb-1">{t.bentoCard2Title}</h3>
                  <p className="text-xs text-white/40 leading-relaxed">{t.bentoCard2Desc}</p>
                </div>
              </motion.div>

              {/* Feature 3: Margin Safeguards (Single Column) */}
              <motion.div 
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.25 }}
                className="rounded-2xl bg-[#090622]/85 border border-white/5 p-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                    <ShieldCheck className="w-5 h-5 text-indigo-400" />
                  </div>
                  <span className="text-[9px] font-bold text-red-400 uppercase tracking-widest bg-red-500/5 px-2 py-0.5 rounded border border-red-500/10">Security Trigger</span>
                </div>

                {/* Overrides Banner Mock */}
                <div className="bg-red-500/5 rounded-xl p-3 border border-red-500/10 my-2 text-left" style={{ direction: "ltr" }}>
                  <div className="flex items-center gap-1 text-[10px] text-red-400 font-extrabold mb-1">
                    <TrendingDown className="w-3.5 h-3.5" />
                    <span>Margin Fallback Alert</span>
                  </div>
                  <div className="text-[10px] text-white/60 leading-tight">Sale #1092 requires profit approval.</div>
                </div>

                <div>
                  <h3 className="text-base font-bold text-white mb-1">{t.bentoCard3Title}</h3>
                  <p className="text-xs text-white/40 leading-relaxed">{t.bentoCard3Desc}</p>
                </div>
              </motion.div>

              {/* Feature 4: Client Profile Hub (Single Column) */}
              <motion.div 
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.3 }}
                className="rounded-2xl bg-[#090622]/85 border border-white/5 p-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 flex flex-col justify-between md:col-span-1"
              >
                <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                  <Users className="w-5 h-5 text-indigo-400" />
                </div>
                
                {/* Customer tags list mock */}
                <div className="flex flex-wrap gap-1.5 my-2">
                  {["Score: 785", "Capital One Approved", "Active Lease", "3 Visits"].map((tag, i) => (
                    <span key={i} className="text-[9px] font-bold px-2 py-0.5 rounded bg-white/5 border border-white/5 text-white/70">
                      {tag}
                    </span>
                  ))}
                </div>

                <div>
                  <h3 className="text-base font-bold text-white mb-1">{t.bentoCard4Title}</h3>
                  <p className="text-xs text-white/40 leading-relaxed">{t.bentoCard4Desc}</p>
                </div>
              </motion.div>

            </div>
          </div>
        </section>

        {/* Dynamic Auto Loan Financing Estimator Section */}
        <section id="calculator" className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-6xl">
            
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.calcTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/40 max-w-xl mx-auto font-medium">
                {t.calcSub}
              </p>
            </div>

            {/* Split layout: inputs vs outputs */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
              
              {/* Sliders Input Panel */}
              <div className="lg:col-span-7 bg-white/[0.02] border border-white/5 rounded-3xl p-8 backdrop-blur-md flex flex-col justify-between gap-8">
                
                {/* 1. Vehicle Value Slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/75">{t.calcVal}</span>
                    <span className="font-black text-indigo-400 text-lg" style={{ direction: "ltr" }}>
                      {locale === "ar" ? "" : "$"}{carPrice.toLocaleString()}{locale === "ar" ? " دولار" : ""}
                    </span>
                  </div>
                  <input 
                    type="range"
                    min="15000"
                    max="250000"
                    step="5000"
                    value={carPrice}
                    onChange={(e) => setCarPrice(Number(e.target.value))}
                    className="w-full accent-indigo-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/20 font-bold" style={{ direction: "ltr" }}>
                    <span>$15,000</span>
                    <span>$250,000</span>
                  </div>
                </div>

                {/* 2. Down Payment Slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/75">{t.calcDown}</span>
                    <span className="font-black text-indigo-400 text-lg" style={{ direction: "ltr" }}>
                      {locale === "ar" ? "" : "$"}{downPayment.toLocaleString()}{locale === "ar" ? " دولار" : ""}
                    </span>
                  </div>
                  <input 
                    type="range"
                    min="0"
                    max={carPrice}
                    step="2000"
                    value={downPayment}
                    onChange={(e) => setDownPayment(Number(e.target.value))}
                    className="w-full accent-indigo-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/20 font-bold" style={{ direction: "ltr" }}>
                    <span>$0</span>
                    <span>Max ({carPrice ? `$${carPrice.toLocaleString()}` : ""})</span>
                  </div>
                </div>

                {/* 3. Interest Rate Slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/75">{t.calcRate}</span>
                    <span className="font-black text-indigo-400 text-lg" style={{ direction: "ltr" }}>
                      {apr.toFixed(1)}%
                    </span>
                  </div>
                  <input 
                    type="range"
                    min="1.9"
                    max="17.9"
                    step="0.1"
                    value={apr}
                    onChange={(e) => setApr(Number(e.target.value))}
                    className="w-full accent-indigo-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/20 font-bold" style={{ direction: "ltr" }}>
                    <span>1.9%</span>
                    <span>17.9%</span>
                  </div>
                </div>

                {/* 4. Financing Term Select buttons */}
                <div className="space-y-3">
                  <span className="text-sm font-bold text-white/75 block">{t.calcTerm}</span>
                  <div className="grid grid-cols-4 gap-3">
                    {[24, 36, 48, 60, 72].map((m) => (
                      <button
                        key={m}
                        onClick={() => setTerm(m)}
                        className={`py-3 rounded-xl border text-xs font-bold transition-all duration-300 cursor-pointer ${
                          term === m 
                            ? "bg-indigo-500 border-indigo-500 text-white shadow-[0_0_15px_rgba(99,102,241,0.4)]" 
                            : "bg-white/5 border-white/5 text-white/75 hover:bg-white/10 hover:border-white/10"
                        }`}
                      >
                        {m} {t.calcMonths}
                      </button>
                    ))}
                  </div>
                </div>

              </div>

              {/* Dynamic Calculations Visualizer Panel */}
              <div className="lg:col-span-5 bg-gradient-to-b from-[#090622] to-black border border-white/5 rounded-3xl p-8 flex flex-col justify-between gap-8 relative overflow-hidden group">
                {/* Glowing ring backdrop */}
                <div className="absolute -top-1/4 -right-1/4 w-60 h-60 bg-indigo-500/[0.04] rounded-full blur-3xl" />
                
                <div className="text-center relative z-10">
                  <span className="text-[10px] font-extrabold tracking-widest text-white/30 uppercase">{t.calcMonthly}</span>
                  <div className="text-4xl sm:text-5xl font-black text-white mt-1 mb-2" style={{ direction: "ltr" }}>
                    {locale === "ar" ? "" : "$"}{Math.round(monthlyInstallment).toLocaleString()}{locale === "ar" ? " دولار" : ""}
                    <span className="text-sm font-light text-white/40 tracking-wider"> / {locale === "ar" ? "شهرياً" : "mo"}</span>
                  </div>
                </div>

                {/* Graphic Circle Diagram */}
                <div className="flex justify-center items-center my-4 relative z-10">
                  <svg className="w-36 h-36 transform -rotate-90 select-none">
                    {/* Secondary/Interest Ring */}
                    <circle 
                      cx="72" 
                      cy="72" 
                      r="48" 
                      className="stroke-purple-500/20" 
                      strokeWidth="10" 
                      fill="transparent" 
                    />
                    {/* Principal Ring */}
                    <circle 
                      cx="72" 
                      cy="72" 
                      r="48" 
                      className="stroke-indigo-500 transition-all duration-500" 
                      strokeWidth="10" 
                      fill="transparent" 
                      strokeDasharray={strokeDasharray}
                      strokeDashoffset={strokeDashoffset}
                      strokeLinecap="round"
                    />
                  </svg>
                  
                  {/* Digital percentage display inside circle */}
                  <div className="absolute flex flex-col items-center select-none" style={{ direction: "ltr" }}>
                    <span className="text-lg font-black text-white">{Math.round(principalPercent)}%</span>
                    <span className="text-[8px] text-white/30 font-bold uppercase tracking-wider">{t.calcPrinc}</span>
                  </div>
                </div>

                {/* Numeric details list */}
                <div className="space-y-3.5 relative z-10 border-t border-white/5 pt-6">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-white/40 font-bold">{t.calcPrinc}</span>
                    <span className="text-white font-extrabold" style={{ direction: "ltr" }}>
                      {locale === "ar" ? "" : "$"}{principal.toLocaleString()}{locale === "ar" ? " دولار" : ""}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-white/40 font-bold">{t.calcInterest}</span>
                    <span className="text-purple-400 font-extrabold" style={{ direction: "ltr" }}>
                      {locale === "ar" ? "" : "$"}{Math.round(totalInterest).toLocaleString()}{locale === "ar" ? " دولار" : ""}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs border-t border-white/5 pt-3">
                    <span className="text-white/40 font-bold">{t.calcTotalPaid}</span>
                    <span className="text-white font-black text-sm" style={{ direction: "ltr" }}>
                      {locale === "ar" ? "" : "$"}{Math.round(totalPaid).toLocaleString()}{locale === "ar" ? " دولار" : ""}
                    </span>
                  </div>
                </div>

              </div>

            </div>

          </div>
        </section>

        {/* Live Deal Flow / Pipeline automation simulation section */}
        <section id="workflow" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-6xl">
            
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.pipeTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/40 max-w-xl mx-auto font-medium">
                {t.pipeSub}
              </p>
            </div>

            {/* Workflow Widget Layout */}
            <div className="bg-gradient-to-br from-white/5 to-[#05031b] border border-white/5 rounded-3xl p-8 backdrop-blur-md">
              
              {/* Line Connector Progress Visual */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-center relative mb-12">
                {pipelineStages.map((stage, idx) => {
                  const isActive = pipelineStage === idx;
                  const isDone = pipelineStage >= idx;

                  return (
                    <div 
                      key={idx}
                      className={`relative p-5 rounded-2xl border transition-all duration-500 text-center select-none ${
                        isActive 
                          ? "bg-indigo-500/10 border-indigo-500 shadow-[0_0_20px_rgba(99,102,241,0.2)]" 
                          : isDone 
                            ? "bg-white/[0.03] border-indigo-500/40 text-white/80"
                            : "bg-white/[0.01] border-white/5 text-white/35"
                      }`}
                    >
                      <div className="absolute top-3 right-3 text-[10px] font-black opacity-35">0{idx + 1}</div>
                      
                      <div className="flex justify-center mb-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors duration-500 ${
                          isActive 
                            ? "bg-indigo-500 text-white animate-pulse" 
                            : isDone
                              ? "bg-indigo-500/20 text-indigo-400"
                              : "bg-white/5 text-white/30"
                        }`}>
                          <Workflow className="w-4 h-4" />
                        </div>
                      </div>

                      <div className="text-xs sm:text-sm font-black mb-1">
                        {locale === "ar" ? stage.labelAr : stage.labelEn}
                      </div>
                      <div className={`text-[9px] font-bold px-2 py-0.5 rounded inline-block ${
                        isActive 
                          ? "bg-indigo-500/20 text-indigo-300"
                          : isDone 
                            ? "bg-white/5 text-white/60"
                            : "bg-white/5 text-white/20"
                      }`}>
                        {locale === "ar" ? stage.statusAr : stage.statusEn}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Detail breakdown box */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center border-t border-white/5 pt-8">
                
                <div className="md:col-span-8 space-y-4">
                  <div className="inline-flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/20 px-3.5 py-1 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                    <span className="text-[10px] font-black uppercase text-indigo-300 tracking-wider">
                      Stage {pipelineStage + 1} Details
                    </span>
                  </div>

                  <h4 className="text-xl sm:text-2xl font-black text-white">
                    {locale === "ar" ? pipelineStages[pipelineStage].labelAr : pipelineStages[pipelineStage].labelEn}
                  </h4>
                  <p className="text-xs sm:text-sm text-white/50 leading-relaxed max-w-xl">
                    {locale === "ar" ? pipelineStages[pipelineStage].descAr : pipelineStages[pipelineStage].descEn}
                  </p>
                </div>

                <div className="md:col-span-4 flex flex-col md:flex-row gap-3 md:justify-end">
                  <button
                    onClick={handleNextPipelineStage}
                    className="px-6 py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
                  >
                    {t.pipeBtn}
                  </button>
                  <button
                    onClick={handleSimulateAuto}
                    className="px-6 py-3 bg-white/5 border border-white/10 hover:border-white/20 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
                  >
                    {t.pipeBtnAuto}
                  </button>
                </div>

              </div>

            </div>

          </div>
        </section>

        {/* Dynamic ROI Calculator widget section */}
        <section className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-4xl">
            
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.roiTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/40 max-w-xl mx-auto font-medium">
                {t.roiSub}
              </p>
            </div>

            <div className="bg-gradient-to-r from-[#090622] to-black border border-white/5 rounded-3xl p-8 relative overflow-hidden group">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center">
                
                {/* Inputs */}
                <div className="md:col-span-6 space-y-4">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/85">{t.roiSales}</span>
                    <span className="font-black text-indigo-400 text-xl">{monthlySales}</span>
                  </div>
                  <input 
                    type="range"
                    min="5"
                    max="300"
                    step="5"
                    value={monthlySales}
                    onChange={(e) => setMonthlySales(Number(e.target.value))}
                    className="w-full accent-indigo-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/20 font-bold" style={{ direction: "ltr" }}>
                    <span>5 cars</span>
                    <span>300 cars</span>
                  </div>
                </div>

                {/* Outputs Display */}
                <div className="md:col-span-6 grid grid-cols-2 gap-4 text-center">
                  
                  <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-5">
                    <div className="text-2xl sm:text-3xl font-black text-white mb-1">
                      {hoursSavedPerWk}
                    </div>
                    <div className="text-[10px] text-indigo-400 font-extrabold uppercase tracking-wide mb-1">
                      {t.roiHours}
                    </div>
                    <div className="text-[9px] text-white/35 font-bold leading-tight">
                      {t.roiHoursSub}
                    </div>
                  </div>

                  <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-5">
                    <div className="text-2xl sm:text-3xl font-black text-white mb-1" style={{ direction: "ltr" }}>
                      {locale === "ar" ? "" : "$"}{annualSavingsDollars.toLocaleString()}{locale === "ar" ? " دولار" : ""}
                    </div>
                    <div className="text-[10px] text-indigo-400 font-extrabold uppercase tracking-wide mb-1">
                      {t.roiSavings}
                    </div>
                    <div className="text-[9px] text-white/35 font-bold leading-tight">
                      {t.roiSavingsSub}
                    </div>
                  </div>

                </div>

              </div>
            </div>

          </div>
        </section>

        {/* Minimalist Interactive Pricing section */}
        <section id="pricing" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-4xl text-center">
            
            <h2 className="text-3xl sm:text-5xl font-black text-white mb-4">
              {t.pricingTitle}
            </h2>
            <p className="text-sm sm:text-base text-white/40 mb-12 max-w-xl mx-auto font-medium">
              {t.pricingSub}
            </p>

            {/* Toggle Billing interval */}
            <div className="inline-flex bg-white/5 border border-white/10 rounded-full p-1 mb-16 relative select-none">
              <button
                onClick={() => setBillingPeriod("monthly")}
                className={`px-6 py-2.5 rounded-full text-xs font-bold transition-all duration-300 cursor-pointer ${
                  billingPeriod === "monthly" ? "bg-indigo-500 text-white" : "text-white/60 hover:text-white"
                }`}
              >
                {t.pricingMonthly}
              </button>
              <button
                onClick={() => setBillingPeriod("annual")}
                className={`px-6 py-2.5 rounded-full text-xs font-bold transition-all duration-300 cursor-pointer ${
                  billingPeriod === "annual" ? "bg-indigo-500 text-white" : "text-white/60 hover:text-white"
                }`}
              >
                {t.pricingAnnual}
              </button>
            </div>

            {/* Single Elite Card */}
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
              className="relative p-[1px] rounded-[2.5rem] bg-gradient-to-b from-white/20 to-transparent max-w-lg mx-auto group hover:from-indigo-500/50 transition-all duration-1000"
            >
              <div className="absolute inset-0 bg-indigo-500/20 blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-1000 pointer-events-none" />
              
              <div className="relative bg-[#05031b] rounded-[2.5rem] p-10 sm:p-12 overflow-hidden border border-white/5">
                <div className="absolute top-0 right-0 w-[180px] h-[180px] bg-indigo-500/10 blur-[80px] pointer-events-none" />
                
                <span className="text-[10px] font-black text-indigo-400 bg-indigo-500/10 px-3.5 py-1 rounded-full border border-indigo-500/20 uppercase tracking-wider mb-6 inline-block">
                  {t.pricingBadge}
                </span>

                <h3 className="text-xl sm:text-2xl font-black text-white mb-4">{t.pricingBadge}</h3>
                
                <div className="flex items-baseline justify-center gap-1.5 mb-10" style={{ direction: "ltr" }}>
                  <span className="text-5xl sm:text-6xl font-black text-white">
                    {billingPeriod === "annual" ? "$119" : "$149"}
                  </span>
                  <span className="text-white/30 tracking-widest text-xs">/ {locale === "ar" ? "شهرياً" : "mo"}</span>
                </div>
                
                <ul className="space-y-4 text-right mb-10" style={{ direction: isRtl ? "rtl" : "ltr" }}>
                  {[
                    locale === "ar" ? "وصول غير محدود لكافة الفروع والمخزون" : "Unlimited branches, vehicles, and users",
                    locale === "ar" ? "أتمتة الموافقات وحسابات التمويل الذكية" : "Dynamic finance calculator & margin approvals",
                    locale === "ar" ? "نظام أدوار وصلاحيات أمان متقدم ومحمي" : "Enterprise granular roles & authorizations",
                    locale === "ar" ? "دعم فني مخصص وخطة عمل متكاملة" : "24/7 dedicated support & data migration"
                  ].map((feature, i) => (
                    <li key={i} className="flex items-center gap-3 text-white/75 text-xs sm:text-sm font-semibold">
                      <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <Link href="/sign-up" className="block w-full relative">
                  <div className="absolute inset-0 bg-indigo-500 rounded-full blur-sm opacity-50 hover:opacity-100 transition-opacity duration-300" />
                  <button className="relative w-full py-4.5 bg-white text-black rounded-full text-xs font-black tracking-wide hover:bg-white/95 transition-colors cursor-pointer">
                    {t.pricingButton}
                  </button>
                </Link>
              </div>
            </motion.div>

          </div>
        </section>

        {/* Brand FAQ Section */}
        <section className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-3xl">
            
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.faqTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/40 max-w-xl mx-auto font-medium">
                {t.faqSub}
              </p>
            </div>

            <div className="space-y-4">
              {faqs.map((faq, idx) => {
                const isOpen = activeFaq === idx;
                return (
                  <div 
                    key={idx}
                    className="border border-white/5 bg-white/[0.01] rounded-2xl overflow-hidden transition-all duration-300 hover:border-white/10"
                  >
                    <button
                      onClick={() => setActiveFaq(isOpen ? null : idx)}
                      className="w-full px-6 py-5 flex items-center justify-between gap-4 font-bold text-sm sm:text-base text-white/90 text-right cursor-pointer"
                      style={{ direction: isRtl ? "rtl" : "ltr" }}
                    >
                      <span>{locale === "ar" ? faq.qAr : faq.qEn}</span>
                      <ChevronRight className={`w-4 h-4 text-white/40 shrink-0 transition-transform duration-300 ${isOpen ? "rotate-90" : ""}`} />
                    </button>
                    
                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.25 }}
                        >
                          <div className="px-6 pb-6 text-xs sm:text-sm text-white/50 leading-relaxed text-right border-t border-white/5 pt-4" style={{ direction: isRtl ? "rtl" : "ltr" }}>
                            {locale === "ar" ? faq.aAr : faq.aEn}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>

          </div>
        </section>

      </main>

      {/* Ultra-Premium Minimalist Footer */}
      <footer className="border-t border-white/5 py-12 relative z-10 bg-[#02000f]">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-8">
          
          <div className="flex items-center gap-3">
            <Image 
              src="/logo.png" 
              alt="AutoFlow Logo" 
              width={100} 
              height={30} 
              className="w-20 h-auto object-contain brightness-0 invert opacity-40 hover:opacity-100 transition-opacity duration-300" 
            />
          </div>

          <p className="text-white/20 text-xs font-semibold tracking-wider">
            © {new Date().getFullYear()} {t.footerRights}
          </p>

          <div className="flex gap-6 text-xs font-semibold tracking-wider text-white/30 uppercase">
            <Link href="#" className="hover:text-white transition-colors duration-300">{t.footerPrivacy}</Link>
            <Link href="#" className="hover:text-white transition-colors duration-300">{t.footerTerms}</Link>
          </div>

        </div>
      </footer>
    </div>
  );
}
