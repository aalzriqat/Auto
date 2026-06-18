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
  Globe,
  BarChart3,
  PieChart,
  GitBranch,
  SlidersHorizontal,
  KeyRound,
  Receipt,
  Languages,
  ClipboardCheck,
  UploadCloud,
  Wallet,
  ListChecks
} from "lucide-react";
import { motion, AnimatePresence, useScroll, useTransform, useMotionValue, useSpring } from "framer-motion";
import { MarketingChatWidget } from "@/components/marketing/MarketingChatWidget";

// Custom type definitions for localization
interface LocalCopy {
  navFeatures: string;
  navCalculator: string;
  navWorkflow: string;
  navReports: string;
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
  footerContact: string;
  platformTitle: string;
  platformSub: string;
  rolesTitle: string;
  rolesSub: string;
  analyticsTitle: string;
  analyticsSub: string;
  opsTitle: string;
  opsSub: string;
}

const copy: Record<"en" | "ar", LocalCopy> = {
  en: {
    navFeatures: "Features",
    navCalculator: "Financing Calculator",
    navWorkflow: "Deal Flow",
    navReports: "Reports",
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
    footerTerms: "Terms of Service",
    footerContact: "Contact Us",
    platformTitle: "One Operating System. Every Department.",
    platformSub: "From the showroom floor to the back office — inventory, CRM, sales, finance, and reporting all live in a single connected workspace.",
    rolesTitle: "Granular Access For Every Employee",
    rolesSub: "Five ready-made role templates, fully customizable — give every employee exactly the access they need, nothing more.",
    analyticsTitle: "Reports That Actually Run Your Business",
    analyticsSub: "Six built-in report types turn raw transactions into decisions — filter any date range and export what you need.",
    opsTitle: "Built To Scale With Your Group",
    opsSub: "Multi-branch operations, secure approval chains, bulk data tools, and a form builder that bends to your workflow — not the other way around."
  },
  ar: {
    navFeatures: "الميزات",
    navCalculator: "حاسبة التمويل",
    navWorkflow: "دورة العمل",
    navReports: "التقارير",
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
    footerTerms: "شروط الخدمة",
    footerContact: "تواصل معنا",
    platformTitle: "نظام تشغيل واحد لكل قسم في معرضك",
    platformSub: "من صالة العرض إلى المكتب الخلفي، يجمع أوتوفلو المخزون وعلاقات العملاء والمبيعات والمحاسبة والتقارير في مساحة عمل واحدة متصلة.",
    rolesTitle: "صلاحيات دقيقة لكل موظف",
    rolesSub: "خمسة قوالب أدوار جاهزة وقابلة للتخصيص الكامل، أعطِ كل موظف الصلاحية التي يحتاجها فقط، لا أكثر ولا أقل.",
    analyticsTitle: "تقارير تدير أعمالك فعلياً",
    analyticsSub: "ستة أنواع تقارير جاهزة تحوّل بياناتك الخام إلى قرارات، فلترة أي مدى تاريخي وتصدير ما تحتاجه بسهولة.",
    opsTitle: "مصمم للنمو مع مجموعتك",
    opsSub: "عمليات متعددة الفروع، سلاسل اعتماد آمنة، أدوات استيراد جماعية، ومُنشئ حقول مرن يتكيف مع أسلوب عملك."
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
    price: "95,000 JOD",
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
    },
    {
      qEn: "Can we control exactly what each employee sees and does?",
      qAr: "هل يمكننا التحكم بدقة بما يراه ويفعله كل موظف؟",
      aEn: "Yes. AutoFlow ships with five role templates (Owner, Manager, Sales, Reception, Accountant) covering the most common dealership structures, and every permission is individually toggleable per role — so you can lock down cost prices, deletions, or financial views exactly the way you want.",
      aAr: "نعم. يأتي أوتوفلو بخمسة قوالب أدوار جاهزة (مالك، مدير، مبيعات، استقبال، محاسب) تغطي أكثر الهياكل التنظيمية شيوعاً، وكل صلاحية قابلة للتفعيل أو التعطيل بشكل فردي لكل دور، فتستطيع التحكم بدقة في من يرى سعر التكلفة أو يحذف السجلات أو يصل للبيانات المالية."
    },
    {
      qEn: "Is the Arabic interface a real translation or just a mirrored layout?",
      qAr: "هل واجهة اللغة العربية ترجمة حقيقية أم مجرد انعكاس للتصميم؟",
      aEn: "It's a genuine right-to-left experience, not a CSS mirror trick. Every screen, form, and report is fully translated and laid out natively for Arabic, and switching languages is instant — no reload, no broken layouts.",
      aAr: "هي تجربة عربية حقيقية بترتيب من اليمين لليسار، وليست مجرد انعكاس بصري بواسطة CSS. كل شاشة ونموذج وتقرير مترجم بالكامل ومصمم بشكل أصلي للغة العربية، والتبديل بين اللغتين فوري دون إعادة تحميل أو أي خلل في التصميم."
    }
  ];

  // --- Platform module index (all major areas of the product) ---
  const platformModules = [
    { icon: Layers, titleEn: "Vehicles & Inventory", titleAr: "المخزون والمركبات" },
    { icon: Users, titleEn: "CRM & Customers", titleAr: "علاقات العملاء" },
    { icon: Workflow, titleEn: "Lead Pipeline", titleAr: "متابعة العملاء المحتملين" },
    { icon: Calculator, titleEn: "Sales Wizard", titleAr: "معالج المبيعات" },
    { icon: TrendingDown, titleEn: "Expense Tracking", titleAr: "تتبع المصاريف" },
    { icon: ListChecks, titleEn: "Task Management", titleAr: "إدارة المهام" },
    { icon: BarChart3, titleEn: "Reports & Analytics", titleAr: "التقارير والتحليلات" },
    { icon: Receipt, titleEn: "Accounting Ledger", titleAr: "دفتر المحاسبة" },
    { icon: Wallet, titleEn: "Financing Applications", titleAr: "طلبات التمويل" },
    { icon: KeyRound, titleEn: "Team & Role Permissions", titleAr: "صلاحيات الفريق" },
    { icon: ClipboardCheck, titleEn: "Approval Workflows", titleAr: "سلاسل الاعتماد" },
    { icon: GitBranch, titleEn: "Multi-Branch Operations", titleAr: "إدارة الفروع" },
    { icon: TrendingUp, titleEn: "Commission Tracking", titleAr: "تتبع العمولات" },
    { icon: SlidersHorizontal, titleEn: "Custom Fields", titleAr: "حقول مخصصة" },
    { icon: UploadCloud, titleEn: "Bulk Import / Export", titleAr: "استيراد وتصدير جماعي" },
    { icon: Languages, titleEn: "Bilingual EN / AR (RTL)", titleAr: "ثنائي اللغة (دعم RTL)" },
  ];

  // --- Role-based access showcase ---
  const rolesData = [
    {
      icon: Building2,
      color: "blue",
      nameEn: "Owner",
      nameAr: "المالك",
      taglineEn: "Full control",
      taglineAr: "تحكم كامل",
      bulletsEn: ["Every permission, every module", "Manage roles & team members", "Approve below-margin deals", "Full financial visibility"],
      bulletsAr: ["كل الصلاحيات وكل الوحدات", "إدارة الأدوار وأعضاء الفريق", "اعتماد الصفقات منخفضة الربح", "رؤية مالية كاملة"],
    },
    {
      icon: ShieldCheck,
      color: "cyan",
      nameEn: "Manager",
      nameAr: "المدير",
      taglineEn: "Runs daily operations",
      taglineAr: "يدير العمليات اليومية",
      bulletsEn: ["Manage inventory, sales & team", "Approve or reject deals & expenses", "View cost prices & commissions", "Configure org settings"],
      bulletsAr: ["إدارة المخزون والمبيعات والفريق", "اعتماد أو رفض الصفقات والمصاريف", "رؤية التكلفة والعمولات", "تعديل إعدادات المؤسسة"],
    },
    {
      icon: Activity,
      color: "teal",
      nameEn: "Sales",
      nameAr: "المبيعات",
      taglineEn: "Sells, not signs off",
      taglineAr: "يبيع دون اعتماد مباشر",
      bulletsEn: ["Build leads & manage customers", "Quote deals — sent for approval", "Views own commission & catalog", "No visibility into cost price"],
      bulletsAr: ["إنشاء عملاء محتملين وإدارة العملاء", "تقديم عروض الصفقات للاعتماد", "رؤية عمولاته ومخزون السيارات", "بدون رؤية لسعر التكلفة"],
    },
    {
      icon: Calendar,
      color: "orange",
      nameEn: "Reception",
      nameAr: "الاستقبال",
      taglineEn: "Front-desk scoped",
      taglineAr: "صلاحيات محدودة بالاستقبال",
      bulletsEn: ["Register walk-in customers", "Log new leads instantly", "View vehicle test-drive status", "Strictly scoped to front-desk"],
      bulletsAr: ["تسجيل العملاء الزائرين", "تسجيل عملاء محتملين فوريين", "رؤية حالة تجارب القيادة", "صلاحيات محدودة بالاستقبال فقط"],
    },
    {
      icon: Receipt,
      color: "amber",
      nameEn: "Accountant",
      nameAr: "المحاسب",
      taglineEn: "Owns the books",
      taglineAr: "يدير السجلات المالية",
      bulletsEn: ["Full finance ledger & transactions", "Runs every report type", "Views sales & expense history", "No access to edit inventory"],
      bulletsAr: ["دفتر الحسابات والمعاملات بالكامل", "تشغيل جميع أنواع التقارير", "رؤية سجل المبيعات والمصاريف", "بدون صلاحية تعديل المخزون"],
    },
  ];

  // --- Reports & analytics gallery ---
  const reportCards = [
    { icon: BarChart3, titleEn: "Sales & Profit Report", titleAr: "تقرير المبيعات والأرباح", descEn: "Revenue, cost, and margin per sale, for any date range.", descAr: "الإيرادات والتكلفة والهامش لكل صفقة، لأي مدى تاريخي." },
    { icon: Layers, titleEn: "Inventory Valuation", titleAr: "تقييم المخزون", descEn: "Real-time value of every vehicle in stock, plus sunk expenses.", descAr: "القيمة الفعلية لكل سيارة في المخزون، بالإضافة للمصاريف المرتبطة بها." },
    { icon: Receipt, titleEn: "Expense Breakdown", titleAr: "تفصيل المصاريف", descEn: "Every cost logged, tagged by vehicle or general overhead.", descAr: "كل مصروف مسجل ومرتبط بسيارة أو بالمصاريف العامة." },
    { icon: TrendingUp, titleEn: "Salesperson Leaderboard", titleAr: "ترتيب أداء المبيعات", descEn: "Rank your team by revenue and profit generated.", descAr: "ترتيب فريقك حسب الإيرادات والأرباح المحققة." },
    { icon: Workflow, titleEn: "Lead Conversion Funnel", titleAr: "قمع تحويل العملاء المحتملين", descEn: "Stage-by-stage conversion rates, by salesperson.", descAr: "نسب التحويل في كل مرحلة، لكل موظف مبيعات." },
    { icon: PieChart, titleEn: "Profit & Loss Statement", titleAr: "بيان الأرباح والخسائر", descEn: "Revenue, COGS, operating expenses, net profit — at a glance.", descAr: "الإيرادات وتكلفة البضاعة والمصاريف التشغيلية وصافي الربح في شاشة واحدة." },
  ];

  // --- Operations row: branches, approvals, import/export, custom fields ---
  const opsFeatures = [
    { icon: GitBranch, titleEn: "Multi-Branch Operations", titleAr: "إدارة متعددة الفروع", descEn: "Scope inventory and staff per branch while executives see consolidated totals across every location.", descAr: "تقسيم المخزون والموظفين لكل فرع، بينما يرى المدراء التنفيذيون الإجمالي الموحد لكل الفروع." },
    { icon: ClipboardCheck, titleEn: "Approval Workflows", titleAr: "سلاسل الاعتماد", descEn: "Vehicle edits, status changes, and below-margin deals all route to a manager queue before they go live.", descAr: "تعديلات السيارات وتغييرات الحالة والصفقات منخفضة الربح تُرسل تلقائياً لقائمة اعتماد المدير قبل التنفيذ." },
    { icon: UploadCloud, titleEn: "Bulk Import / Export", titleAr: "استيراد وتصدير جماعي", descEn: "Drop in any spreadsheet — AutoFlow maps your columns automatically and remembers the mapping next time.", descAr: "أدرج أي ملف إكسل، يقوم أوتوفلو بمطابقة الأعمدة تلقائياً ويتذكر الإعداد للمرة القادمة." },
    { icon: SlidersHorizontal, titleEn: "Custom Fields", titleAr: "حقول مخصصة", descEn: "Add the fields your dealership actually needs to vehicle and lead forms — no developer required.", descAr: "أضف الحقول التي يحتاجها معرضك فعلياً لنماذج السيارات والعملاء المحتملين، دون الحاجة لمطور." },
  ];

  const roleColorMap: Record<string, { ring: string; bg: string; text: string; glow: string }> = {
    blue: { ring: "border-blue-500/30", bg: "bg-blue-500/10", text: "text-blue-400", glow: "rgba(59,130,246,0.15)" },
    cyan: { ring: "border-cyan-500/30", bg: "bg-cyan-500/10", text: "text-cyan-400", glow: "rgba(6,182,212,0.15)" },
    teal: { ring: "border-teal-500/30", bg: "bg-teal-500/10", text: "text-teal-400", glow: "rgba(20,184,166,0.15)" },
    orange: { ring: "border-orange-500/30", bg: "bg-orange-500/10", text: "text-orange-400", glow: "rgba(249,115,22,0.15)" },
    amber: { ring: "border-amber-500/30", bg: "bg-amber-500/10", text: "text-amber-400", glow: "rgba(245,158,11,0.15)" },
  };

  return (
    <div 
      ref={pageContainerRef} 
      onMouseMove={handleGlobalMouseMove}
      className={`dark relative min-h-screen bg-[#030014] text-white selection:bg-blue-500/30 overflow-hidden font-sans`}
      style={{ direction: isRtl ? "rtl" : "ltr" }}
    >
      
      {/* 20-Year Exp Interactive Background Canvas */}
      {/* 1. Global mouse follower glow */}
      <div 
        className="fixed inset-0 pointer-events-none z-0 transition-opacity duration-500"
        style={{
          background: `radial-gradient(700px circle at ${mousePos.x}px ${mousePos.y}px, rgba(59, 130, 246, 0.08), transparent 45%)`
        }}
      />
      {/* 2. Abstract Glowing Vector Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1f29370f_1px,transparent_1px),linear-gradient(to_bottom,#1f29370f_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none z-0" />
      
      {/* 3. Deep Cinematic Nebula Orbs */}
      <div className="absolute top-[-10%] right-[-5%] w-[45vw] h-[45vw] rounded-full bg-blue-600/10 blur-[130px] animate-pulse pointer-events-none z-0" style={{ animationDuration: "12s" }} />
      <div className="absolute bottom-[20%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-blue-500/5 blur-[150px] pointer-events-none z-0" />
      <div className="absolute top-[40%] left-[30%] w-[35vw] h-[35vw] rounded-full bg-orange-600/5 blur-[140px] pointer-events-none z-0" />

      {/* Bespoke Header */}
      <header className="fixed top-0 inset-x-0 z-50 w-full bg-[#030014]/40 backdrop-blur-2xl border-b border-white/5 transition-all duration-300">
        <div className="container mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 relative z-10">
            <Image 
              src="/logo.png" 
              alt="AutoFlow Logo" 
              width={160} 
              height={50} 
              className="w-28 h-auto object-contain opacity-95 transition-transform duration-500 hover:scale-105"
              priority 
            />
          </Link>
          
          <nav className="hidden lg:flex items-center gap-8 text-xs font-semibold tracking-wider text-white/60 uppercase">
            <a href="#features" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navFeatures}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-blue-500 group-hover:w-full transition-all duration-300" />
            </a>
            <a href="#calculator" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navCalculator}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-blue-500 group-hover:w-full transition-all duration-300" />
            </a>
            <a href="#workflow" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navWorkflow}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-blue-500 group-hover:w-full transition-all duration-300" />
            </a>
            <a href="#analytics" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navReports}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-blue-500 group-hover:w-full transition-all duration-300" />
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
              <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500 to-orange-600 rounded-full blur opacity-40 group-hover:opacity-100 transition duration-700" />
              <button className="relative px-6 py-2.5 bg-black hover:bg-[#07051a] rounded-full flex items-center gap-2 border border-white/10 group-hover:border-blue-500/30 transition-colors duration-300 cursor-pointer">
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
              className="py-2.5 text-sm font-semibold hover:text-blue-400 transition-colors"
            >
              {t.navFeatures}
            </a>
            <a 
              href="#calculator" 
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-blue-400 transition-colors"
            >
              {t.navCalculator}
            </a>
            <a
              href="#workflow"
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-blue-400 transition-colors"
            >
              {t.navWorkflow}
            </a>
            <a
              href="#analytics"
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-blue-400 transition-colors"
            >
              {t.navReports}
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
              <Sparkles className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-[10px] sm:text-xs font-bold tracking-widest text-blue-200/90">{t.heroBadge}</span>
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
                className="block text-transparent bg-clip-text bg-gradient-to-r from-blue-200 via-blue-400 to-cyan-400"
              >
                {t.heroTitle2}
              </motion.span>
            </h1>
            
            <motion.p 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.2, delay: 0.5 }}
              className="text-base sm:text-lg lg:text-xl text-white/65 max-w-2xl mx-auto leading-relaxed font-medium mb-12"
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
                <div className="absolute -inset-1 bg-gradient-to-r from-blue-500 to-blue-600 rounded-full blur opacity-60 group-hover:opacity-100 transition duration-700" />
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
                className="relative w-full rounded-2xl md:rounded-3xl border border-white/10 bg-[#090622]/85 shadow-[0_0_120px_rgba(59,130,246,0.15)] overflow-hidden aspect-[16/10] backdrop-blur-3xl transition-shadow duration-700 hover:shadow-[0_0_150px_rgba(59,130,246,0.25)] group"
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
                  <div className="bg-white/5 px-6 py-1 rounded text-[10px] text-white/50 font-semibold tracking-wider w-40 text-center truncate">
                    autoflow.io/dashboard
                  </div>
                  <div className="w-16" />
                </div>
                
                {/* Live mock screen display */}
                <div className="relative w-full h-[calc(100%-3rem)] bg-[#030014] select-none overflow-hidden">
                  <Image 
                    src="/dashboard.png" 
                    alt="AutoFlow Enterprise Dashboard Interface Preview" 
                    fill
                    priority
                    className="object-cover object-top opacity-85 group-hover:opacity-95 transition-opacity duration-700"
                  />
                  
                  {/* Internal ambient glowing points */}
                  <div className="absolute top-1/4 left-1/3 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl" />
                  <div className="absolute bottom-1/4 right-1/4 w-40 h-40 bg-orange-500/10 rounded-full blur-3xl" />
                </div>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Platform Module Index — every department, one glance */}
        <section id="platform" className="py-20 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-14">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.platformTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.platformSub}
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              {platformModules.map((mod, idx) => {
                const Icon = mod.icon;
                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: idx * 0.03 }}
                    className="group flex flex-col items-center justify-center gap-2.5 text-center p-4 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-blue-500/30 hover:bg-white/[0.05] transition-all duration-300"
                  >
                    <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/10 flex items-center justify-center group-hover:bg-blue-500/20 transition-colors duration-300">
                      <Icon className="w-4.5 h-4.5 text-blue-400" />
                    </div>
                    <span className="text-[10px] sm:text-[11px] font-bold text-white/70 group-hover:text-white leading-tight transition-colors duration-300">
                      {locale === "ar" ? mod.titleAr : mod.titleEn}
                    </span>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Bento Grid Features Showcase */}
        <section id="features" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-20">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-4">
                {t.bentoTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
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
                className="md:col-span-2 md:row-span-2 rounded-2xl bg-gradient-to-br from-white/5 to-[#05031b] border border-white/5 p-8 relative overflow-hidden group hover:border-blue-500/30 transition-all duration-500 flex flex-col justify-between"
              >
                {/* Floating graphic overlay */}
                <div className="absolute top-0 right-0 w-80 h-80 bg-blue-500/[0.02] rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
                
                {/* Interactive Showroom Stock Mini-Widget */}
                <div className="relative z-10 w-full h-full flex flex-col justify-between gap-6">
                  <div className="flex items-center justify-between">
                    <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                      <Layers className="w-5 h-5 text-blue-400" />
                    </div>
                    <span className="text-[10px] font-bold text-blue-400/80 uppercase tracking-widest bg-blue-500/5 px-3 py-1 rounded-full border border-blue-500/10">Interactive Sandbox</span>
                  </div>

                  {/* Mock Inventory List */}
                  <div className="space-y-2.5 my-4">
                    {[
                      { name: "Toyota Land Cruiser GXR", vin: "JTMHV05J504123456", status: "Available", statusAr: "متوفرة", color: "text-emerald-400 bg-emerald-400/5 border-emerald-400/20", price: locale === "ar" ? "47,500 د.أ" : "47,500 JOD" },
                      { name: "Hyundai Tucson 2024", vin: "KM8J3CAL2RU123456", status: "Reserved", statusAr: "محجوزة", color: "text-amber-400 bg-amber-400/5 border-amber-400/20", price: locale === "ar" ? "28,900 د.أ" : "28,900 JOD" },
                      { name: "Porsche 911 Carrera S", vin: "WP0AB2A99NS123456", status: "Sold", statusAr: "مباعة", color: "text-blue-400 bg-blue-400/5 border-blue-400/20", price: locale === "ar" ? "165,000 د.أ" : "165,000 JOD" }
                    ].map((car, idx) => (
                      <div 
                        key={idx} 
                        className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300"
                      >
                        <div className="flex flex-col text-left" style={{ direction: "ltr" }}>
                          <span className="text-xs font-bold text-white/90">{car.name}</span>
                          <span className="text-[9px] text-white/50 font-semibold mt-0.5">VIN: {car.vin}</span>
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
                    <p className="text-xs sm:text-sm text-white/65 leading-relaxed max-w-xl">{t.bentoCard1Desc}</p>
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
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-blue-400" />
                  </div>
                  {/* Ping Animation indicator */}
                  <div className="flex items-center gap-1.5 bg-emerald-500/5 px-2.5 py-1 rounded border border-emerald-500/10">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
                    <span className="text-[9px] text-emerald-400 font-extrabold tracking-wider uppercase">Active Live Sync</span>
                  </div>
                </div>
                
                {/* Ping speedometer mock */}
                <div className="bg-black/40 rounded-xl p-3 border border-white/5 text-center my-2 select-none" style={{ direction: "ltr" }}>
                  <div className="text-xs text-white/60 font-bold mb-1">Websocket Latency</div>
                  <div className="text-2xl font-black text-blue-400 tracking-tight">
                    12<span className="text-xs text-white/60 font-semibold ml-0.5">ms</span>
                  </div>
                  <div className="text-[9px] text-white/40 font-bold mt-1">Convex Reactive Subscriptions</div>
                </div>

                <div>
                  <h3 className="text-base font-bold text-white mb-1">{t.bentoCard2Title}</h3>
                  <p className="text-xs text-white/60 leading-relaxed">{t.bentoCard2Desc}</p>
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
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <ShieldCheck className="w-5 h-5 text-blue-400" />
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
                  <p className="text-xs text-white/60 leading-relaxed">{t.bentoCard3Desc}</p>
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
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Users className="w-5 h-5 text-blue-400" />
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
                  <p className="text-xs text-white/60 leading-relaxed">{t.bentoCard4Desc}</p>
                </div>
              </motion.div>

            </div>
          </div>
        </section>

        {/* Role-Based Access Showcase */}
        <section id="roles" className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.rolesTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.rolesSub}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">
              {rolesData.map((role, idx) => {
                const Icon = role.icon;
                const colors = roleColorMap[role.color];
                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: idx * 0.08 }}
                    className={`relative rounded-2xl border ${colors.ring} bg-white/[0.02] p-6 flex flex-col gap-4 hover:bg-white/[0.04] transition-all duration-500 group`}
                  >
                    <div
                      className="absolute -top-10 -right-10 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none"
                      style={{ backgroundColor: colors.glow }}
                    />
                    <div className={`w-11 h-11 rounded-xl ${colors.bg} flex items-center justify-center relative z-10`}>
                      <Icon className={`w-5 h-5 ${colors.text}`} />
                    </div>
                    <div className="relative z-10">
                      <h3 className="text-base font-extrabold text-white">{locale === "ar" ? role.nameAr : role.nameEn}</h3>
                      <span className={`text-[10px] font-bold uppercase tracking-wide ${colors.text}`}>
                        {locale === "ar" ? role.taglineAr : role.taglineEn}
                      </span>
                    </div>
                    <ul className="space-y-2 relative z-10">
                      {(locale === "ar" ? role.bulletsAr : role.bulletsEn).map((bullet, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px] text-white/55 leading-snug font-medium">
                          <Check className={`w-3 h-3 mt-0.5 shrink-0 ${colors.text}`} />
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>
                  </motion.div>
                );
              })}
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
              <p className="text-sm sm:text-base text-white/60 max-w-xl mx-auto font-medium">
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
                    <span className="font-black text-blue-400 text-lg" style={{ direction: "ltr" }}>
                      {carPrice.toLocaleString()} {locale === "ar" ? "د.أ" : "JOD"}
                    </span>
                  </div>
                  <input 
                    type="range"
                    min="15000"
                    max="250000"
                    step="5000"
                    value={carPrice}
                    onChange={(e) => setCarPrice(Number(e.target.value))}
                    className="w-full accent-blue-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/40 font-bold" style={{ direction: "ltr" }}>
                    <span>15,000 JOD</span>
                    <span>250,000 JOD</span>
                  </div>
                </div>

                {/* 2. Down Payment Slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/75">{t.calcDown}</span>
                    <span className="font-black text-blue-400 text-lg" style={{ direction: "ltr" }}>
                      {downPayment.toLocaleString()} {locale === "ar" ? "د.أ" : "JOD"}
                    </span>
                  </div>
                  <input 
                    type="range"
                    min="0"
                    max={carPrice}
                    step="2000"
                    value={downPayment}
                    onChange={(e) => setDownPayment(Number(e.target.value))}
                    className="w-full accent-blue-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/40 font-bold" style={{ direction: "ltr" }}>
                    <span>0 JOD</span>
                    <span>Max ({carPrice ? `${carPrice.toLocaleString()} JOD` : ""})</span>
                  </div>
                </div>

                {/* 3. Interest Rate Slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/75">{t.calcRate}</span>
                    <span className="font-black text-blue-400 text-lg" style={{ direction: "ltr" }}>
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
                    className="w-full accent-blue-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/40 font-bold" style={{ direction: "ltr" }}>
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
                            ? "bg-blue-500 border-blue-500 text-white shadow-[0_0_15px_rgba(59,130,246,0.4)]" 
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
                <div className="absolute -top-1/4 -right-1/4 w-60 h-60 bg-blue-500/[0.04] rounded-full blur-3xl" />
                
                <div className="text-center relative z-10">
                  <span className="text-[10px] font-extrabold tracking-widest text-white/50 uppercase">{t.calcMonthly}</span>
                  <div className="text-4xl sm:text-5xl font-black text-white mt-1 mb-2" style={{ direction: "ltr" }}>
                    {Math.round(monthlyInstallment).toLocaleString()} <span className="text-xl font-bold">{locale === "ar" ? "د.أ" : "JOD"}</span>
                    <span className="text-sm font-light text-white/60 tracking-wider"> / {locale === "ar" ? "شهرياً" : "mo"}</span>
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
                      className="stroke-orange-500/20" 
                      strokeWidth="10" 
                      fill="transparent" 
                    />
                    {/* Principal Ring */}
                    <circle 
                      cx="72" 
                      cy="72" 
                      r="48" 
                      className="stroke-blue-500 transition-all duration-500" 
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
                    <span className="text-[8px] text-white/50 font-bold uppercase tracking-wider">{t.calcPrinc}</span>
                  </div>
                </div>

                {/* Numeric details list */}
                <div className="space-y-3.5 relative z-10 border-t border-white/5 pt-6">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-white/60 font-bold">{t.calcPrinc}</span>
                    <span className="text-white font-extrabold" style={{ direction: "ltr" }}>
                      {principal.toLocaleString()} {locale === "ar" ? "د.أ" : "JOD"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-white/60 font-bold">{t.calcInterest}</span>
                    <span className="text-orange-400 font-extrabold" style={{ direction: "ltr" }}>
                      {Math.round(totalInterest).toLocaleString()} {locale === "ar" ? "د.أ" : "JOD"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs border-t border-white/5 pt-3">
                    <span className="text-white/60 font-bold">{t.calcTotalPaid}</span>
                    <span className="text-white font-black text-sm" style={{ direction: "ltr" }}>
                      {Math.round(totalPaid).toLocaleString()} {locale === "ar" ? "د.أ" : "JOD"}
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
              <p className="text-sm sm:text-base text-white/60 max-w-xl mx-auto font-medium">
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
                          ? "bg-blue-500/10 border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.2)]" 
                          : isDone 
                            ? "bg-white/[0.03] border-blue-500/40 text-white/80"
                            : "bg-white/[0.01] border-white/5 text-white/55"
                      }`}
                    >
                      <div className="absolute top-3 right-3 text-[10px] font-black opacity-35">0{idx + 1}</div>
                      
                      <div className="flex justify-center mb-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors duration-500 ${
                          isActive 
                            ? "bg-blue-500 text-white animate-pulse" 
                            : isDone
                              ? "bg-blue-500/20 text-blue-400"
                              : "bg-white/5 text-white/50"
                        }`}>
                          <Workflow className="w-4 h-4" />
                        </div>
                      </div>

                      <div className="text-xs sm:text-sm font-black mb-1">
                        {locale === "ar" ? stage.labelAr : stage.labelEn}
                      </div>
                      <div className={`text-[9px] font-bold px-2 py-0.5 rounded inline-block ${
                        isActive 
                          ? "bg-blue-500/20 text-blue-300"
                          : isDone 
                            ? "bg-white/5 text-white/60"
                            : "bg-white/5 text-white/40"
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
                  <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 px-3.5 py-1 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                    <span className="text-[10px] font-black uppercase text-blue-300 tracking-wider">
                      Stage {pipelineStage + 1} Details
                    </span>
                  </div>

                  <h4 className="text-xl sm:text-2xl font-black text-white">
                    {locale === "ar" ? pipelineStages[pipelineStage].labelAr : pipelineStages[pipelineStage].labelEn}
                  </h4>
                  <p className="text-xs sm:text-sm text-white/65 leading-relaxed max-w-xl">
                    {locale === "ar" ? pipelineStages[pipelineStage].descAr : pipelineStages[pipelineStage].descEn}
                  </p>
                </div>

                <div className="md:col-span-4 flex flex-col md:flex-row gap-3 md:justify-end">
                  <button
                    onClick={handleNextPipelineStage}
                    className="px-6 py-3 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
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

        {/* Reports & Analytics Gallery */}
        <section id="analytics" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.analyticsTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.analyticsSub}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {reportCards.map((report, idx) => {
                const Icon = report.icon;
                const barHeights = [40, 70, 55, 85, 60, 95];
                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: idx * 0.07 }}
                    className="rounded-2xl bg-gradient-to-br from-white/5 to-[#05031b] border border-white/5 p-6 hover:border-blue-500/30 transition-all duration-500 group flex flex-col gap-5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                        <Icon className="w-5 h-5 text-blue-400" />
                      </div>
                      <div className="flex items-end gap-1 h-8" style={{ direction: "ltr" }}>
                        {barHeights.map((h, i) => (
                          <div
                            key={i}
                            className="w-1.5 rounded-full bg-blue-500/20 group-hover:bg-blue-500/50 transition-all duration-500"
                            style={{ height: `${h}%` }}
                          />
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white mb-1.5">{locale === "ar" ? report.titleAr : report.titleEn}</h3>
                      <p className="text-xs text-white/62 leading-relaxed">{locale === "ar" ? report.descAr : report.descEn}</p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Operations: branches, approvals, bulk tools, custom fields */}
        <section id="operations" className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.opsTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.opsSub}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {opsFeatures.map((feature, idx) => {
                const Icon = feature.icon;
                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: idx * 0.08 }}
                    className="rounded-2xl bg-[#090622]/85 border border-white/5 p-6 hover:border-white/20 transition-all duration-500 flex flex-col gap-4"
                  >
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                      <Icon className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white mb-1.5">{locale === "ar" ? feature.titleAr : feature.titleEn}</h3>
                      <p className="text-xs text-white/62 leading-relaxed">{locale === "ar" ? feature.descAr : feature.descEn}</p>
                    </div>
                  </motion.div>
                );
              })}
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
              <p className="text-sm sm:text-base text-white/60 max-w-xl mx-auto font-medium">
                {t.roiSub}
              </p>
            </div>

            <div className="bg-gradient-to-r from-[#090622] to-black border border-white/5 rounded-3xl p-8 relative overflow-hidden group">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center">
                
                {/* Inputs */}
                <div className="md:col-span-6 space-y-4">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/85">{t.roiSales}</span>
                    <span className="font-black text-blue-400 text-xl">{monthlySales}</span>
                  </div>
                  <input 
                    type="range"
                    min="5"
                    max="300"
                    step="5"
                    value={monthlySales}
                    onChange={(e) => setMonthlySales(Number(e.target.value))}
                    className="w-full accent-blue-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/40 font-bold" style={{ direction: "ltr" }}>
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
                    <div className="text-[10px] text-blue-400 font-extrabold uppercase tracking-wide mb-1">
                      {t.roiHours}
                    </div>
                    <div className="text-[9px] text-white/55 font-bold leading-tight">
                      {t.roiHoursSub}
                    </div>
                  </div>

                  <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-5">
                    <div className="text-2xl sm:text-3xl font-black text-white mb-1" style={{ direction: "ltr" }}>
                      {annualSavingsDollars.toLocaleString()} {locale === "ar" ? "د.أ" : "JOD"}
                    </div>
                    <div className="text-[10px] text-blue-400 font-extrabold uppercase tracking-wide mb-1">
                      {t.roiSavings}
                    </div>
                    <div className="text-[9px] text-white/55 font-bold leading-tight">
                      {t.roiSavingsSub}
                    </div>
                  </div>

                </div>

              </div>
            </div>

          </div>
        </section>

        {/* Brand FAQ Section */}
        <section className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-3xl">
            
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.faqTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-xl mx-auto font-medium">
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
                      <ChevronRight className={`w-4 h-4 text-white/60 shrink-0 transition-transform duration-300 ${isOpen ? "rotate-90" : ""}`} />
                    </button>
                    
                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.25 }}
                        >
                          <div className="px-6 pb-6 text-xs sm:text-sm text-white/65 leading-relaxed text-right border-t border-white/5 pt-4" style={{ direction: isRtl ? "rtl" : "ltr" }}>
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
              className="w-20 h-auto object-contain opacity-70 hover:opacity-100 transition-opacity duration-300"
            />
          </div>

          <p className="text-white/40 text-xs font-semibold tracking-wider">
            © {new Date().getFullYear()} {t.footerRights}
          </p>

          <div className="flex gap-6 text-xs font-semibold tracking-wider text-white/50 uppercase">
            <Link href="/privacy" className="hover:text-white transition-colors duration-300">{t.footerPrivacy}</Link>
            <Link href="/terms" className="hover:text-white transition-colors duration-300">{t.footerTerms}</Link>
            <Link href="/contact" className="hover:text-white transition-colors duration-300">{t.footerContact}</Link>
          </div>

        </div>
      </footer>

      <MarketingChatWidget />
    </div>
  );
}
