import {
  Activity,
  BarChart3,
  BookOpen,
  Building2,
  Calculator,
  Calendar,
  ClipboardCheck,
  GitBranch,
  Globe,
  KeyRound,
  Landmark,
  Languages,
  Layers,
  ListChecks,
  MessageCircle,
  MessageSquare,
  Percent,
  PieChart,
  Receipt,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  TrendingDown,
  TrendingUp,
  UploadCloud,
  Users,
  Wallet,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export interface TitledIconItem {
  icon: LucideIcon;
  titleEn: string;
  titleAr: string;
}

export interface FeatureGridItem extends TitledIconItem {
  descEn: string;
  descAr: string;
}

export type RoleColorName = "blue" | "cyan" | "teal" | "orange" | "amber";

export interface RoleColorClasses {
  ring: string;
  bg: string;
  text: string;
  glow: string;
}

export interface RoleData {
  icon: LucideIcon;
  color: RoleColorName;
  nameEn: string;
  nameAr: string;
  taglineEn: string;
  taglineAr: string;
  bulletsEn: string[];
  bulletsAr: string[];
}
export interface LocalCopy {
  navFeatures: string;
  navCalculator: string;
  navWorkflow: string;
  navReports: string;
  navPricing: string;
  navContact: string;
  navLogin: string;
  navStart: string;
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
  pipeStageDetails: string;
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
  financeTitle: string;
  financeSub: string;
  growTitle: string;
  growSub: string;
}

type LocaleCode = "en" | "ar";
type CopyRow = readonly [key: keyof LocalCopy, en: string, ar: string];
type FaqRow = readonly [questionEn: string, questionAr: string, answerEn: string, answerAr: string];

const FIELD_SEPARATOR = " | ";

function parseMarketingRows(source: string, expectedFieldCount: number): string[][] {
  return source.trim().split(/\r?\n/).map((line) => {
    const fields = line.split(FIELD_SEPARATOR);

    if (fields.length !== expectedFieldCount) {
      throw new Error("Invalid marketing content row.");
    }

    return fields;
  });
}

const copyRows: CopyRow[] = parseMarketingRows(`
navFeatures | Features | الميزات
navCalculator | Financing Calculator | حاسبة التمويل
navWorkflow | Deal Flow | دورة العمل
navReports | Reports | التقارير
navPricing | Pricing | الأسعار
navContact | Contact | تواصل معنا
navLogin | Sign In | دخول
navStart | Get Started | ابدأ الآن
heroTitle1 | The Creative Engine | المحرك الإبداعي
heroTitle2 | For Elite Car Dealerships | لمعارض السيارات النخبة
heroSubhead | Ditch slow spreadsheets. Manage luxury inventory, automate credit approvals, and scale sales pipeline in a fast, unified digital workspace. | ودع الجداول التقليدية البطيئة. أدر مخزونك الفاخر، وأتمت موافقات التمويل، وضاعف مبيعاتك في منصة سحابية واحدة تمتاز بالسرعة والجمال.
heroCTA | Claim Your Showroom Space | احجز مساحة معرضك الآن
heroDemo | Explore Interactive Demo | استكشف العرض التفاعلي
calcTitle | Showroom Finance Estimator | حاسبة التمويل التفاعلية
calcSub | Empower your clients with credit breakdowns. Adjust vehicle values and downpayments in real-time. | امنح عملائك حسابات فورية لأقساط التمويل. اسحب المؤشرات لتعديل قيمة المركبة والتمويل في الوقت الفعلي.
calcVal | Vehicle Value | سعر المركبة
calcDown | Down Payment | الدفعة الأولى
calcRate | Interest Rate (APR) | نسبة الفائدة السنوية
calcTerm | Financing Term | فترة التمويل
calcMonthly | Monthly Installment | القسط الشهري المتوقع
calcPrinc | Principal Amount | مبلغ التمويل الأساسي
calcInterest | Total Interest Cost | إجمالي الفوائد
calcTotalPaid | Total Paid Balance | إجمالي المدفوعات
calcMonths | Months | شهراً
pipeTitle | Live Deal Flow Automation | أتمتة مراحل الصفقات الحية
pipeSub | Simulate a client sales cycle. Watch statuses transition instantly across the database pipeline. | حاكِ دورة حياة العميل بنقرة واحدة. شاهد تحديث حالة الطلبات تلقائياً عبر قاعدة البيانات.
pipeBtn | Step Next Stage | المرحلة التالية
pipeBtnAuto | Simulate Auto-Run | محاكاة تلقائية
pipeStageDetails | Stage {stage} Details | تفاصيل المرحلة {stage}
bentoTitle | Designed for Velocity. Engineered for Control. | هندسة متناهية السرعة والتحكم.
bentoSub | A complete vehicle dealership operating system combining beautiful interfaces with secure workflows. | نظام تشغيل متكامل يجمع بين الواجهات الفخمة وقواعد البيانات الموثوقة والآمنة.
bentoCard1Title | Live Inventory & VIN Auditing | مخزون حي وفحص رقم الشاصي
bentoCard1Desc | Instantly index custom vehicle specifications, track repair statuses, and fetch car profiles in milliseconds. | فهرسة مواصفات السيارات بدقة، وتتبع حالة الصيانة، وتحميل صور المعرض في أقل من 30 مللي ثانية.
bentoCard2Title | Sub-Second Sync Engine | مزامنة لحظية فائقة
bentoCard2Desc | Deal data, payments, and sales statuses propagate instantly to all managers via Convex WebSockets. | مزامنة فورية لكل صفقة أو دفعة عبر جميع موظفي المبيعات باستخدام تقنيات Convex المتطورة.
bentoCard3Title | Margin & Profit Protection | حماية هوامش أرباح المعرض
bentoCard3Desc | Automatically route profit reductions below targets to manager queues for secure numeric override authorization. | توجيه طلبات تخفيض هامش الربح تلقائياً لمدير المعرض لاعتمادها أو رفضها بشكل آمن ومحمي.
bentoCard4Title | 360° Client Profile Hub | ملفات عملاء متكاملة 360°
bentoCard4Desc | Track complete customer interaction logs, financing applications, test-drive waivers, and follow-ups. | سجل كامل لتعاملات المشتري، وطلبات التمويل النشطة، وحجوزات قيادة المركبات والمهام المعلقة.
roiTitle | Calculate Your Showroom ROI | احسب العائد على استثمار معرضك
roiSub | See how much time and operational costs you save with AutoFlow every month. | قدّر أوقات العمل والمبالغ السنوية التي يوفرها معرضك عند استخدام أوتوفلو.
roiSales | Vehicles Sold Monthly | عدد السيارات المباعة شهرياً
roiHours | Hours Saved / Wk | ساعات عمل موفرة أسبوعياً
roiHoursSub | Freed from manual spreadsheet entries | من خلال تقليل مدخلات البيانات اليدوية والتكرارية
roiSavings | Annual Profit Gain | التوفير المالي السنوي
roiSavingsSub | Through workflow efficiency & faster lead closes | بفضل رفع سرعة إغلاق الصفقات وتحسين أداء مبيعاتك
pricingTitle | Elite Dealership Plans | الاستثمار في التميز
pricingSub | Zero complexity. One simple price built for high-performance showrooms. | لا توجد تعقيدات. باقة واحدة تشمل كل شيء، مصممة للمعارض التي لا ترضى بأقل من الكمال.
pricingMonthly | Monthly Billing | فاتورة شهرية
pricingAnnual | Annual Billing (20% Off) | فاتورة سنوية (خصم 20%)
pricingBadge | Best Value | الأكثر طلباً
pricingButton | Elevate Your Dealership Now | ارتقِ بمعرضك إلى النخبة الآن
faqTitle | Frequently Asked Questions | الأسئلة الشائعة
faqSub | Everything you need to know about migrating your showroom operations. | كل ما تود معرفته عن ترحيل بيانات معرضك ونظام أوتوفلو.
footerRights | AUTOFLOW. All rights reserved. | أوتوفلو. جميع الحقوق محفوظة.
footerPrivacy | Privacy Policy | سياسة الخصوصية
footerTerms | Terms of Service | شروط الخدمة
footerContact | Contact Us | تواصل معنا
platformTitle | One Operating System. Every Department. | نظام تشغيل واحد لكل قسم في معرضك
platformSub | From the showroom floor to the back office — inventory, CRM, sales, finance, and reporting all live in a single connected workspace. | من صالة العرض إلى المكتب الخلفي، يجمع أوتوفلو المخزون وعلاقات العملاء والمبيعات والمحاسبة والتقارير في مساحة عمل واحدة متصلة.
rolesTitle | Granular Access For Every Employee | صلاحيات دقيقة لكل موظف
rolesSub | Five ready-made role templates, fully customizable — give every employee exactly the access they need, nothing more. | خمسة قوالب أدوار جاهزة وقابلة للتخصيص الكامل، أعطِ كل موظف الصلاحية التي يحتاجها فقط، لا أكثر ولا أقل.
analyticsTitle | Reports That Actually Run Your Business | تقارير تدير أعمالك فعلياً
analyticsSub | Six built-in report types turn raw transactions into decisions — filter any date range and export what you need. | ستة أنواع تقارير جاهزة تحوّل بياناتك الخام إلى قرارات، فلترة أي مدى تاريخي وتصدير ما تحتاجه بسهولة.
opsTitle | Built To Scale With Your Group | مصمم للنمو مع مجموعتك
opsSub | Multi-branch operations, secure approval chains, bulk data tools, and a form builder that bends to your workflow — not the other way around. | عمليات متعددة الفروع، سلاسل اعتماد آمنة، أدوات استيراد جماعية، ومُنشئ حقول مرن يتكيف مع أسلوب عملك.
financeTitle | A Real Finance Department, Built In | قسم محاسبة متكامل داخل النظام
financeSub | Double-entry general ledger, bank reconciliation, VAT returns, and installment tracking — no separate accounting software required. | دفتر أستاذ عام بقيد مزدوج، تسوية بنكية، إقرارات ضريبة القيمة المضافة، ومتابعة أقساط التمويل، دون الحاجة لأي برنامج محاسبي منفصل.
growTitle | Grow Beyond The Showroom Floor | انطلق خارج صالة العرض
growSub | A bilingual public website, a unified social inbox, and internal team chat — everything that touches a customer or a coworker, in one place. | موقع إلكتروني عام ثنائي اللغة، صندوق وارد موحّد لمنصات التواصل، ومحادثات داخلية للفريق، كل ما يتعلق بعميل أو زميل عمل، في مكان واحد.
`, 3).map(([key, en, ar]) => [key as keyof LocalCopy, en, ar]);

function buildCopy(locale: LocaleCode): LocalCopy {
  return copyRows.reduce<Partial<LocalCopy>>((localizedCopy, [key, en, ar]) => {
    localizedCopy[key] = locale === "ar" ? ar : en;
    return localizedCopy;
  }, {}) as LocalCopy;
}

export const copy: Record<LocaleCode, LocalCopy> = {
  en: buildCopy("en"),
  ar: buildCopy("ar"),
};

export const pipelineStages = [
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
    descEn: "AutoFlow coordinates with underwriting financing companies to compute payment approval thresholds.",
    descAr: "حساب فوري للأرباح وهوامش التمويل بالتنسيق مع شركات التمويل المعتمدة.",
  },
  {
    labelEn: "Delivered",
    labelAr: "تسليم السيارة",
    statusEn: "Deal Completed",
    statusAr: "تم اكتمال البيع",
    descEn: "Instantly locks PDF invoice contract, modifies inventory status to 'Sold', triggers audit log.",
    descAr: "توليد العقد النهائي بصيغة PDF، تحديث حالة السيارة إلى 'مباعة'، وحفظ سجل الفحص.",
  }
] as const;

interface LocalizedText {
  en: string;
  ar: string;
}

interface FaqItem {
  question: LocalizedText;
  answer: LocalizedText;
}

const faqRows: FaqRow[] = parseMarketingRows(`
Can we transfer our existing vehicle stock and customer list? | هل يمكننا نقل قائمة السيارات والعملاء الحالية لدينا بسهولة؟ | Absolutely. AutoFlow provides clean CSV and JSON templates to batch-import your entire inventory and customer history in minutes. Our tech staff is also available for direct database migrations. | بالتأكيد. يوفر أوتوفلو قوالب استيراد مرنة بصيغة CSV و JSON لرفع مخزونك وبيانات العملاء دفعة واحدة خلال دقائق. فريقنا التقني متواجد أيضاً لمساعدتك في نقل البيانات بالكامل.
How do profit protection thresholds and approvals work? | كيف تعمل حماية هوامش أرباح الصفقات واعتماد المعاملات؟ | You set target profit percentages per brand or branch. If a salesperson configures a deal below these margins, AutoFlow automatically blocks invoicing and pushes a secure approval request to the manager dashboard with SMS notifications. | يمكنك تحديد هوامش الربح المستهدفة لكل علامة تجارية أو فرع. إذا حاول موظف المبيعات إدخال صفقة بأرباح أقل، يقوم النظام تلقائياً بتجميدها وإرسال طلب موافقة فوري لهاتف لوحة تحكم المدير لإقرارها أو رفضها.
Is AutoFlow optimized for multi-branch dealerships? | هل يدعم أوتوفلو معارض السيارات ذات الفروع المتعددة؟ | Yes. Our enterprise plan supports granular branch-scoping, permitting salesmen to view local stock while enabling executives to monitor consolidated inventory, sales, and analytics across all regional sites. | نعم. يدعم أوتوفلو تقسيم الصلاحيات والمخزون للفروع المتعددة. حيث يمكن للموظف رؤية سيارات فرعه المحلي فقط، بينما يستطيع المسؤول العام تتبع كافة الفروع والتقارير المالية المدمجة بكفاءة.
Can we control exactly what each employee sees and does? | هل يمكننا التحكم بدقة بما يراه ويفعله كل موظف؟ | Yes. AutoFlow ships with five role templates (Owner, Manager, Sales, Reception, Accountant) covering the most common dealership structures, and every permission is individually toggleable per role — so you can lock down cost prices, deletions, or financial views exactly the way you want. | نعم. يأتي أوتوفلو بخمسة قوالب أدوار جاهزة (مالك، مدير، مبيعات، استقبال، محاسب) تغطي أكثر الهياكل التنظيمية شيوعاً، وكل صلاحية قابلة للتفعيل أو التعطيل بشكل فردي لكل دور، فتستطيع التحكم بدقة في من يرى سعر التكلفة أو يحذف السجلات أو يصل للبيانات المالية.
Is the Arabic interface a real translation or just a mirrored layout? | هل واجهة اللغة العربية ترجمة حقيقية أم مجرد انعكاس للتصميم؟ | It's a genuine right-to-left experience, not a CSS mirror trick. Every screen, form, and report is fully translated and laid out natively for Arabic, and switching languages is instant — no reload, no broken layouts. | هي تجربة عربية حقيقية بترتيب من اليمين لليسار، وليست مجرد انعكاس بصري بواسطة CSS. كل شاشة ونموذج وتقرير مترجم بالكامل ومصمم بشكل أصلي للغة العربية، والتبديل بين اللغتين فوري دون إعادة تحميل أو أي خلل في التصميم.
Can AutoFlow build our dealership's public website? | هل يمكن لأوتوفلو بناء الموقع الإلكتروني العام لمعرضنا؟ | Yes. Every org gets a bilingual, public-facing dealer website synced live to your inventory, with a choice of standard themes plus premium designs — no separate hosting or developer needed. | نعم. تحصل كل مؤسسة على موقع إلكتروني عام ثنائي اللغة مرتبط مباشرة بمخزونها الحي، مع تشكيلة من القوالب القياسية والتصاميم المميزة، دون الحاجة لاستضافة منفصلة أو مطور.
Does AutoFlow connect to our Instagram and Facebook pages? | هل يتصل أوتوفلو بصفحاتنا على إنستغرام وفيسبوك؟ | Yes. Connect your pages to auto-post vehicles when they go available, capture every comment and DM into one Social Inbox, auto-reply to common questions, and convert engaged followers straight into leads. | نعم. اربط صفحاتك لنشر السيارات تلقائياً عند توفرها، وتجميع كل تعليق ورسالة خاصة في صندوق وارد اجتماعي واحد، مع رد تلقائي على الأسئلة الشائعة وتحويل المتابعين المتفاعلين إلى عملاء محتملين مباشرة.
`, 4).map(([questionEn, questionAr, answerEn, answerAr]) => [questionEn, questionAr, answerEn, answerAr]);

export const faqs: FaqItem[] = faqRows.map(([questionEn, questionAr, answerEn, answerAr]) => ({
  question: { en: questionEn, ar: questionAr },
  answer: { en: answerEn, ar: answerAr },
}));

export const platformModules: TitledIconItem[] = [
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
  { icon: Globe, titleEn: "Dealer Website Builder", titleAr: "منشئ مواقع المعارض" },
  { icon: MessageCircle, titleEn: "Instagram & Facebook Inbox", titleAr: "صندوق وارد إنستغرام وفيسبوك" },
  { icon: MessageSquare, titleEn: "Internal Team Chat", titleAr: "محادثات الفريق الداخلية" },
  { icon: Landmark, titleEn: "Bank Reconciliation", titleAr: "التسوية البنكية" },
  { icon: Percent, titleEn: "VAT Return Filing", titleAr: "إقرارات ضريبة القيمة المضافة" },
  { icon: Smartphone, titleEn: "Installable Mobile App (PWA)", titleAr: "تطبيق جوال قابل للتثبيت" },
];

export const rolesData: RoleData[] = [
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

export const reportCards: FeatureGridItem[] = [
  { icon: BarChart3, titleEn: "Sales & Profit Report", titleAr: "تقرير المبيعات والأرباح", descEn: "Revenue, cost, and margin per sale, for any date range.", descAr: "الإيرادات والتكلفة والهامش لكل صفقة، لأي مدى تاريخي." },
  { icon: Layers, titleEn: "Inventory Valuation", titleAr: "تقييم المخزون", descEn: "Real-time value of every vehicle in stock, plus sunk expenses.", descAr: "القيمة الفعلية لكل سيارة في المخزون، بالإضافة للمصاريف المرتبطة بها." },
  { icon: Receipt, titleEn: "Expense Breakdown", titleAr: "تفصيل المصاريف", descEn: "Every cost logged, tagged by vehicle or general overhead.", descAr: "كل مصروف مسجل ومرتبط بسيارة أو بالمصاريف العامة." },
  { icon: TrendingUp, titleEn: "Salesperson Leaderboard", titleAr: "ترتيب أداء المبيعات", descEn: "Rank your team by revenue and profit generated.", descAr: "ترتيب فريقك حسب الإيرادات والأرباح المحققة." },
  { icon: Workflow, titleEn: "Lead Conversion Funnel", titleAr: "تحويل العملاء المحتملين", descEn: "Stage-by-stage conversion rates, by salesperson.", descAr: "نسب التحويل في كل مرحلة، لكل موظف مبيعات." },
  { icon: PieChart, titleEn: "Profit & Loss Statement", titleAr: "بيان الأرباح والخسائر", descEn: "Revenue, COGS, operating expenses, net profit — at a glance.", descAr: "الإيرادات وتكلفة البضاعة والمصاريف التشغيلية وصافي الربح في شاشة واحدة." },
];

export const opsFeatures: FeatureGridItem[] = [
  { icon: GitBranch, titleEn: "Multi-Branch Operations", titleAr: "إدارة متعددة الفروع", descEn: "Scope inventory and staff per branch while executives see consolidated totals across every location.", descAr: "تقسيم المخزون والموظفين لكل فرع، بينما يرى المدراء التنفيذيون الإجمالي الموحد لكل الفروع." },
  { icon: ClipboardCheck, titleEn: "Approval Workflows", titleAr: "سلاسل الاعتماد", descEn: "Vehicle edits, status changes, and below-margin deals all route to a manager queue before they go live.", descAr: "تعديلات السيارات وتغييرات الحالة والصفقات منخفضة الربح تُرسل تلقائياً لقائمة اعتماد المدير قبل التنفيذ." },
  { icon: UploadCloud, titleEn: "Bulk Import / Export", titleAr: "استيراد وتصدير جماعي", descEn: "Drop in any spreadsheet — AutoFlow maps your columns automatically and remembers the mapping next time.", descAr: "أدرج أي ملف إكسل، يقوم أوتوفلو بمطابقة الأعمدة تلقائياً ويتذكر الإعداد للمرة القادمة." },
  { icon: SlidersHorizontal, titleEn: "Custom Fields", titleAr: "حقول مخصصة", descEn: "Add the fields your dealership actually needs to vehicle and lead forms — no developer required.", descAr: "أضف الحقول التي يحتاجها معرضك فعلياً لنماذج السيارات والعملاء المحتملين، دون الحاجة لمطور." },
];

export const financeFeatures: FeatureGridItem[] = [
  { icon: BookOpen, titleEn: "Double-Entry General Ledger", titleAr: "دفتر أستاذ عام بقيد مزدوج", descEn: "Every sale, expense, and payment auto-posts a balanced journal entry — no manual bookkeeping.", descAr: "كل عملية بيع أو مصروف أو دفعة تُسجَّل تلقائياً كقيد محاسبي متوازن، دون إدخال يدوي." },
  { icon: Landmark, titleEn: "Bank Accounts & Reconciliation", titleAr: "الحسابات البنكية والتسوية", descEn: "Upload a bank statement and get scored transaction matches — nothing is ever auto-confirmed without you.", descAr: "ارفع كشف الحساب البنكي واحصل على مطابقات مقترحة للمعاملات، ولا يتم اعتماد أي تسوية دون مراجعتك." },
  { icon: Percent, titleEn: "VAT Return Reports", titleAr: "تقارير إقرار ضريبة القيمة المضافة", descEn: "Output vs. input VAT calculated from every sale, expense, and supplier payment — export as PDF or CSV.", descAr: "احتساب ضريبة المخرجات مقابل ضريبة المدخلات من كل بيع ومصروف ودفعة مورد، مع تصدير بصيغة PDF أو CSV." },
  { icon: Calendar, titleEn: "Installment Due-Date Calendar", titleAr: "تقويم استحقاق الأقساط", descEn: "See every financed sale's upcoming installment in one collections calendar — never miss a due date.", descAr: "شاهد جميع أقساط المبيعات الممولة القادمة في تقويم تحصيل واحد، ولا تفوّت أي تاريخ استحقاق." },
];

export const growFeatures: FeatureGridItem[] = [
  { icon: Globe, titleEn: "Bilingual Dealer Website Builder", titleAr: "منشئ مواقع المعارض ثنائي اللغة", descEn: "Publish a public, bilingual dealership site synced to your live inventory — pick from standard themes or premium designs like Prestige, Velocity, and Avant.", descAr: "أطلق موقعاً عاماً ثنائي اللغة لمعرضك مرتبطاً بمخزونك الحي، اختر من القوالب القياسية أو التصاميم المميزة مثل Prestige و Velocity و Avant." },
  { icon: MessageCircle, titleEn: "Instagram & Facebook Social Inbox", titleAr: "صندوق وارد إنستغرام وفيسبوك", descEn: "Every comment and DM from Instagram and Facebook lands in one inbox, with auto-reply and automatic lead creation.", descAr: "كل تعليق أو رسالة خاصة من إنستغرام وفيسبوك تصل إلى صندوق وارد واحد، مع رد تلقائي وإنشاء عملاء محتملين تلقائياً." },
  { icon: MessageSquare, titleEn: "Internal Team Messaging", titleAr: "محادثات الفريق الداخلية", descEn: "A built-in messenger for direct and group chats, with seen receipts and sound alerts — no need for a separate chat app.", descAr: "محادثات جماعية وفردية مدمجة مع إشعارات القراءة والتنبيهات الصوتية، دون الحاجة لتطبيق محادثة منفصل." },
];

export const roleColorMap: Record<RoleColorName, RoleColorClasses> = {
  blue: { ring: "border-blue-500/30", bg: "bg-blue-500/10", text: "text-blue-400", glow: "rgba(59,130,246,0.15)" },
  cyan: { ring: "border-cyan-500/30", bg: "bg-cyan-500/10", text: "text-cyan-400", glow: "rgba(6,182,212,0.15)" },
  teal: { ring: "border-teal-500/30", bg: "bg-teal-500/10", text: "text-teal-400", glow: "rgba(20,184,166,0.15)" },
  orange: { ring: "border-orange-500/30", bg: "bg-orange-500/10", text: "text-orange-400", glow: "rgba(249,115,22,0.15)" },
  amber: { ring: "border-amber-500/30", bg: "bg-amber-500/10", text: "text-amber-400", glow: "rgba(245,158,11,0.15)" },
};
