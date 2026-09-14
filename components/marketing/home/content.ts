/**
 * Landing page v2 content — SCRUM-323 (port of the SCRUM-301 prototype).
 *
 * Every visible string lives here as an EN/AR pair. The page never hardcodes
 * copy; it resolves each pair through `pick(locale, bi)` so a translation gap
 * is a type error rather than an English fallback in the Arabic UI.
 *
 * Currency is ONE constant. Change `CURRENCY` to re-denominate the whole
 * page (vehicle floor and calculator). The plan card carries no price by
 * owner decision (SCRUM-326).
 */

export type Locale = "en" | "ar";

export type Bi = Readonly<{ en: string; ar: string }>;

export function pick(locale: string, bi: Bi): string {
  return locale === "ar" ? bi.ar : bi.en;
}

export const CURRENCY: Bi = { en: "JOD", ar: "د.أ" };

/** Where every generated image for this page lives. Filenames are a contract. */
export const IMG = "/marketing/landing-v2";

/* ------------------------------------------------------------------ */
/* Nav                                                                  */
/* ------------------------------------------------------------------ */

export const NAV_LINKS: readonly { href: string; label: Bi }[] = [
  { href: "#features", label: { en: "Features", ar: "الميزات" } },
  { href: "#workflow", label: { en: "Deal Flow", ar: "دورة العمل" } },
  { href: "#calculator", label: { en: "Financing", ar: "حاسبة التمويل" } },
  { href: "#accounting", label: { en: "Accounting", ar: "المحاسبة" } },
  { href: "#pricing", label: { en: "Pricing", ar: "الأسعار" } },
];

export const NAV = {
  signIn: { en: "Sign In", ar: "دخول" },
  getStarted: { en: "Get Started", ar: "ابدأ الآن" },
} as const satisfies Record<string, Bi>;

/* ------------------------------------------------------------------ */
/* Hero                                                                 */
/* ------------------------------------------------------------------ */

export const HERO = {
  title: { en: "One operating system. Every department.", ar: "نظام تشغيل واحد لكل قسم في معرضك" },
  lede: {
    en: "From the showroom floor to the back office — inventory, CRM, sales, finance, and reporting all live in a single connected workspace.",
    ar: "من صالة العرض إلى المكتب الخلفي، يجمع أوتوفلو المخزون وعلاقات العملاء والمبيعات والمحاسبة والتقارير في مساحة عمل واحدة متصلة.",
  },
  demo: { en: "Explore Interactive Demo", ar: "استكشف العرض التفاعلي" },
} as const satisfies Record<string, Bi>;

export type SpineNode = Readonly<{
  /** authored delay for the spring entrance */
  delayMs: number;
  /** inline-start percentage on the desktop diagonal */
  start: number;
  /** top percentage on the desktop diagonal */
  top: number;
  label?: Bi;
  icon: "lead" | "drive" | "check" | "finance" | "delivered";
}>;

export const SPINE_NODES: readonly SpineNode[] = [
  { delayMs: 250, start: 25, top: 67, icon: "lead", label: { en: "Lead", ar: "عميل محتمل" } },
  { delayMs: 400, start: 40, top: 47, icon: "drive", label: { en: "Test drive", ar: "تجربة القيادة" } },
  { delayMs: 150, start: 50, top: 47, icon: "check" },
  { delayMs: 520, start: 60, top: 47, icon: "finance", label: { en: "Financing", ar: "التمويل" } },
  { delayMs: 660, start: 75, top: 67, icon: "delivered", label: { en: "Delivered", ar: "تم التسليم" } },
];

export type SpineChip = Readonly<{
  delayMs: number;
  /** logical position: which edge and how far in */
  edge: "start" | "end";
  inset: number;
  top: number;
  color: string;
  title: Bi;
  sub: Bi;
}>;

export const SPINE_CHIPS: readonly SpineChip[] = [
  {
    delayMs: 820, edge: "start", inset: 1, top: 20, color: "hsl(145 63% 42%)",
    title: { en: "Facebook & Instagram lead", ar: "عميل من فيسبوك وإنستغرام" },
    sub: { en: "auto-assigned", ar: "تم التعيين تلقائياً" },
  },
  {
    delayMs: 980, edge: "end", inset: 1, top: 12, color: "hsl(38 92% 50%)",
    title: { en: "Below-margin deal", ar: "صفقة تحت الهامش" },
    sub: { en: "waiting on manager", ar: "بانتظار اعتماد المدير" },
  },
  {
    delayMs: 1140, edge: "end", inset: 3, top: 84, color: "hsl(236 82% 58%)",
    title: { en: "Journal posted", ar: "تم ترحيل القيد" },
    sub: { en: "debits = credits", ar: "مدين = دائن" },
  },
];

export const TRUST: readonly Bi[] = [
  { en: "Double-entry general ledger", ar: "دفتر أستاذ عام بقيد مزدوج" },
  { en: "5 customizable role templates", ar: "خمسة قوالب أدوار قابلة للتخصيص" },
  { en: "Bilingual EN / AR (RTL)", ar: "ثنائي اللغة (دعم RTL)" },
  { en: "Multi-branch operations", ar: "إدارة متعددة الفروع" },
  { en: "Installable mobile app", ar: "تطبيق جوال قابل للتثبيت" },
];

/* ------------------------------------------------------------------ */
/* Vehicle floor                                                        */
/* ------------------------------------------------------------------ */

export type VehicleStatus = "available" | "reserved" | "sold" | "sourced";

export type Vehicle = Readonly<{
  img: string;
  name: Bi;
  vin: string;
  price: number;
  status: VehicleStatus;
}>;

export const VEHICLES: readonly Vehicle[] = [
  { img: "veh-01-suv-white.webp", name: { en: "Pearl White SUV · 2024", ar: "دفع رباعي أبيض لؤلؤي · ٢٠٢٤" }, vin: "WAUZZZ4M6RA018374", price: 59000, status: "available" },
  { img: "veh-02-sedan-silver.webp", name: { en: "Silver Executive Sedan · 2023", ar: "سيدان فاخرة فضية · ٢٠٢٣" }, vin: "WDD2231761A419008", price: 50500, status: "reserved" },
  { img: "veh-03-coupe-red.webp", name: { en: "Signal Red Coupe · 2024", ar: "كوبيه أحمر · ٢٠٢٤" }, vin: "JF1ZNAA10P8703112", price: 34000, status: "available" },
  { img: "veh-04-pickup-black.webp", name: { en: "Black Double-Cab Pickup · 2025", ar: "بيك أب أسود غرفتين · ٢٠٢٥" }, vin: "MNBLMFE50NW614228", price: 28000, status: "sourced" },
  { img: "veh-05-hatch-teal.webp", name: { en: "Teal Compact Hatch · 2024", ar: "هاتشباك صغيرة · ٢٠٢٤" }, vin: "W0V0XEP68P4229561", price: 14000, status: "sold" },
  { img: "veh-06-van-grey.webp", name: { en: "Graphite Panel Van · 2024", ar: "فان رمادي · ٢٠٢٤" }, vin: "WF0YXXTTGYPL33417", price: 22800, status: "available" },
];

export const STATUS_LABEL: Readonly<Record<VehicleStatus, Bi>> = {
  available: { en: "Available", ar: "متاحة" },
  reserved: { en: "Reserved", ar: "محجوزة" },
  sold: { en: "Sold", ar: "مباعة" },
  sourced: { en: "Sourced", ar: "وساطة" },
};

/** Desktop scatter: rest position + the offset each card flies in from.
 *  `fx` is mirrored at runtime via --dirsign so RTL flies the correct way. */
export type FloorSlot = Readonly<{ s: string; t: string; fx: number; fy: number; r: number; rr: number; d: number }>;

export const FLOOR_LAYOUT: readonly FloorSlot[] = [
  { s: "0%", t: "1%", fx: -180, fy: -60, r: -7, rr: -5, d: 0 },
  { s: "6%", t: "35%", fx: -220, fy: 20, r: 5, rr: 3, d: 90 },
  { s: "1%", t: "69%", fx: -160, fy: 90, r: -4, rr: -2, d: 180 },
  { s: "80%", t: "2%", fx: 190, fy: -70, r: 6, rr: 4, d: 60 },
  { s: "73%", t: "36%", fx: 230, fy: 10, r: -5, rr: -3, d: 150 },
  { s: "81%", t: "70%", fx: 170, fy: 100, r: 4, rr: 3, d: 240 },
];

export const FLOOR = {
  eyebrow: { en: "Inventory", ar: "المخزون" },
  title: { en: "Every car on the floor, costed and audited", ar: "كل سيارة في المعرض، بتكلفتها وسجل فحصها" },
  lede: {
    en: "Index custom specifications, track repair status and sunk expenses, and see real-time stock value — with cost price visible only to the roles you allow.",
    ar: "فهرسة المواصفات المخصصة، وتتبع حالة الصيانة والمصاريف المرتبطة، ورؤية القيمة الفعلية للمخزون لحظياً، مع إظهار سعر التكلفة للأدوار التي تسمح لها فقط.",
  },
  note: { en: "Cost price and margin stay hidden from the Sales role by default.", ar: "سعر التكلفة والهامش يبقيان مخفيين عن دور المبيعات افتراضياً." },
} as const satisfies Record<string, Bi>;

/* ------------------------------------------------------------------ */
/* Roles bento                                                          */
/* ------------------------------------------------------------------ */

export const ROLES = {
  eyebrow: { en: "Permissions", ar: "الصلاحيات" },
  title: { en: "Granular access for every employee", ar: "صلاحيات دقيقة لكل موظف" },
  lede: {
    en: "Five ready-made role templates, fully customizable — give every employee exactly the access they need, nothing more.",
    ar: "خمسة قوالب أدوار جاهزة وقابلة للتخصيص الكامل، أعطِ كل موظف الصلاحية التي يحتاجها فقط، لا أكثر ولا أقل.",
  },
  owner: { en: "Owner", ar: "المالك" },
  ownerTag: { en: "Full control", ar: "تحكم كامل" },
  manager: { en: "Manager", ar: "المدير" },
  managerTag: { en: "Runs daily operations", ar: "يدير العمليات اليومية" },
  sales: { en: "Sales", ar: "المبيعات" },
  salesBody: { en: "Sells, not signs off. Quotes route for approval; cost price stays hidden.", ar: "يبيع دون اعتماد مباشر. تُرسل العروض للاعتماد، ويبقى سعر التكلفة مخفياً." },
  reception: { en: "Reception", ar: "الاستقبال" },
  receptionBody: { en: "Front-desk scoped. Register walk-ins and log leads instantly.", ar: "صلاحيات محدودة بالاستقبال. تسجيل الزوار وإنشاء عملاء محتملين فوراً." },
  accountant: { en: "Accountant", ar: "المحاسب" },
  accountantBody: { en: "Owns the books. Full ledger and every report — no rights to edit inventory.", ar: "يدير السجلات المالية. دفتر الحسابات وكل التقارير، دون صلاحية تعديل المخزون." },
  plAxis: { en: "Net profit, last 7 months", ar: "صافي الربح، آخر ٧ أشهر" },
  pl: { en: "P&L", ar: "الأرباح والخسائر" },
  approve: { en: "Approve", ar: "اعتماد" },
  reject: { en: "Reject", ar: "رفض" },
  balanced: { en: "Balanced", ar: "متوازن" },
} as const satisfies Record<string, Bi>;

export const OWNER_POINTS: readonly Bi[] = [
  { en: "Every permission, every module", ar: "كل الصلاحيات وكل الوحدات" },
  { en: "Approve below-margin deals", ar: "اعتماد الصفقات منخفضة الربح" },
  { en: "Full financial visibility", ar: "رؤية مالية كاملة" },
];

export const MANAGER_POINTS: readonly Bi[] = [
  { en: "Approve or reject deals & expenses", ar: "اعتماد أو رفض الصفقات والمصاريف" },
  { en: "View cost prices & commissions", ar: "رؤية التكلفة والعمولات" },
];

/** P&L mini-chart bars: height % and entrance delay */
export const PL_BARS: readonly { h: number; d: number; alt?: boolean }[] = [
  { h: 38, d: 100 }, { h: 56, d: 180 }, { h: 31, d: 260, alt: true }, { h: 74, d: 340 },
  { h: 62, d: 420 }, { h: 44, d: 500, alt: true }, { h: 92, d: 580 },
];

export type QueueRow = Readonly<{ d: number; pill: VehicleStatus; tag: Bi; what: Bi }>;

export const QUEUE: readonly QueueRow[] = [
  { d: 200, pill: "reserved", tag: { en: "Margin", ar: "هامش" }, what: { en: "Deal #2418", ar: "صفقة ‎#2418" } },
  { d: 340, pill: "sourced", tag: { en: "Edit", ar: "تعديل" }, what: { en: "VIN change", ar: "تغيير الشاصي" } },
  { d: 480, pill: "available", tag: { en: "Expense", ar: "مصروف" }, what: { en: "Detailing 240", ar: "تلميع 240" } },
];

export const PIPE_COLUMNS: readonly { label: Bi; chips: number }[] = [
  { label: { en: "New", ar: "جديد" }, chips: 2 },
  { label: { en: "Drive", ar: "قيادة" }, chips: 1 },
  { label: { en: "Quote", ar: "عرض" }, chips: 1 },
  { label: { en: "Won", ar: "مغلق" }, chips: 1 },
];

export const RECEPTION_LOG: readonly { time: string; initial: string; color: string; what: Bi }[] = [
  { time: "09:12", initial: "M", color: "hsl(236 82% 58%)", what: { en: "Walk-in registered", ar: "تسجيل زائر" } },
  { time: "09:40", initial: "S", color: "hsl(160 62% 38%)", what: { en: "Test drive booked", ar: "حجز تجربة قيادة" } },
  { time: "10:05", initial: "A", color: "hsl(38 92% 50%)", what: { en: "Lead assigned", ar: "تعيين عميل محتمل" } },
];

export type JournalLine = Readonly<{ account: Bi; debit?: string; credit?: string }>;

export const JOURNAL_HEAD = {
  account: { en: "Account", ar: "الحساب" },
  debit: { en: "Debit", ar: "مدين" },
  credit: { en: "Credit", ar: "دائن" },
} as const satisfies Record<string, Bi>;

/** The short journal on the Accountant card */
export const JOURNAL_SHORT: readonly JournalLine[] = [
  { account: { en: "Bank", ar: "البنك" }, debit: "50,500" },
  { account: { en: "Vehicle sales", ar: "مبيعات المركبات" }, credit: "43,534" },
  { account: { en: "VAT payable", ar: "ضريبة مستحقة" }, credit: "6,966" },
];

/** The full posting on the accounting demo */
export const JOURNAL_FULL: readonly JournalLine[] = [
  ...JOURNAL_SHORT,
  { account: { en: "Cost of goods sold", ar: "تكلفة البضاعة المباعة" }, debit: "40,400" },
  { account: { en: "Inventory", ar: "المخزون" }, credit: "40,400" },
];

/* ------------------------------------------------------------------ */
/* Deal flow                                                            */
/* ------------------------------------------------------------------ */

export const FLOW = {
  eyebrow: { en: "Workflow", ar: "دورة العمل" },
  title: { en: "Live deal flow automation", ar: "أتمتة مراحل الصفقات الحية" },
  lede: {
    en: "Watch a customer move through the pipeline — statuses transition instantly across the database, and every step leaves an audit trail.",
    ar: "تابع رحلة العميل عبر مراحل الصفقة، تتحدث الحالات فوراً في قاعدة البيانات، وكل خطوة تترك أثراً في سجل التدقيق.",
  },
} as const satisfies Record<string, Bi>;

export type FlowStep = Readonly<{ status: Bi; title: Bi; body: Bi }>;

export const FLOW_STEPS: readonly FlowStep[] = [
  {
    status: { en: "CRM Registered", ar: "تم التسجيل بالنظام" },
    title: { en: "Lead Ingestion", ar: "تسجيل العميل" },
    body: {
      en: "Enquiries from your website, Instagram, Facebook and WhatsApp auto-convert into a deal and route to the right salesperson.",
      ar: "الاستفسارات من موقعك وإنستغرام وفيسبوك وواتساب تتحول تلقائياً إلى صفقة وتُوجَّه لموظف المبيعات المناسب.",
    },
  },
  {
    status: { en: "Waiver Signed", ar: "توقيع نموذج القيادة" },
    title: { en: "Test Drive", ar: "تجربة القيادة" },
    body: { en: "Generates digital waiver form, registers vehicle keys, and alerts yard staff.", ar: "إنشاء رقمي لتفويض القيادة، تتبع المفاتيح الذكية، وتنبيه موظفي المعرض." },
  },
  {
    status: { en: "Terms Configured", ar: "تم تحديد الشروط" },
    title: { en: "Credit Decided", ar: "قرار التمويل" },
    body: { en: "AutoFlow coordinates with underwriting financing companies to compute payment approval thresholds.", ar: "حساب فوري للأرباح وهوامش التمويل بالتنسيق مع شركات التمويل المعتمدة." },
  },
  {
    status: { en: "Deal Completed", ar: "تم اكتمال البيع" },
    title: { en: "Delivered", ar: "تسليم السيارة" },
    body: { en: "Instantly locks PDF invoice contract, modifies inventory status to 'Sold', triggers audit log.", ar: "توليد العقد النهائي بصيغة PDF، تحديث حالة السيارة إلى 'مباعة'، وحفظ سجل الفحص." },
  },
];

/* ------------------------------------------------------------------ */
/* Calculator                                                           */
/* ------------------------------------------------------------------ */

export const CALC = {
  eyebrow: { en: "Financing", ar: "التمويل" },
  title: { en: "Showroom finance estimator", ar: "حاسبة التمويل التفاعلية" },
  lede: {
    en: "Empower your clients with credit breakdowns. Adjust vehicle values and downpayments in real time.",
    ar: "امنح عملاءك حسابات فورية لأقساط التمويل. اسحب المؤشرات لتعديل قيمة المركبة والتمويل في الوقت الفعلي.",
  },
  value: { en: "Vehicle Value", ar: "سعر المركبة" },
  down: { en: "Down Payment", ar: "الدفعة الأولى" },
  rate: { en: "Interest Rate (APR)", ar: "نسبة الفائدة السنوية" },
  term: { en: "Financing Term", ar: "فترة التمويل" },
  months: { en: "months", ar: "شهراً" },
  monthly: { en: "Monthly Installment", ar: "القسط الشهري المتوقع" },
  principal: { en: "Principal Amount", ar: "مبلغ التمويل الأساسي" },
  interest: { en: "Total Interest Cost", ar: "إجمالي الفوائد" },
  total: { en: "Total Paid Balance", ar: "إجمالي المدفوعات" },
} as const satisfies Record<string, Bi>;

/* ------------------------------------------------------------------ */
/* Accounting                                                           */
/* ------------------------------------------------------------------ */

export const ACCT = {
  eyebrow: { en: "Finance", ar: "المالية" },
  title: { en: "A real finance department, built in", ar: "قسم محاسبة متكامل داخل النظام" },
  lede: {
    en: "Double-entry general ledger, bank reconciliation, VAT returns, and installment tracking — no separate accounting software required.",
    ar: "دفتر أستاذ عام بقيد مزدوج، تسوية بنكية، إقرارات ضريبة القيمة المضافة، ومتابعة أقساط التمويل، دون الحاجة لأي برنامج محاسبي منفصل.",
  },
  saleCompleted: { en: "Sale completed", ar: "اكتمال عملية بيع" },
} as const satisfies Record<string, Bi>;

export type AcctFeature = Readonly<{ icon: "ledger" | "bank" | "vat" | "calendar"; d: number; title: Bi; body: Bi }>;

export const ACCT_FEATURES: readonly AcctFeature[] = [
  {
    icon: "ledger", d: 80,
    title: { en: "Double-Entry General Ledger", ar: "دفتر أستاذ عام بقيد مزدوج" },
    body: { en: "Every sale, expense, and payment auto-posts a balanced journal entry — no manual bookkeeping.", ar: "كل عملية بيع أو مصروف أو دفعة تُسجَّل تلقائياً كقيد محاسبي متوازن، دون إدخال يدوي." },
  },
  {
    icon: "bank", d: 180,
    title: { en: "Bank Accounts & Reconciliation", ar: "الحسابات البنكية والتسوية" },
    body: { en: "Upload a bank statement and get scored transaction matches — nothing is ever auto-confirmed without you.", ar: "ارفع كشف الحساب البنكي واحصل على مطابقات مقترحة للمعاملات، ولا يتم اعتماد أي تسوية دون مراجعتك." },
  },
  {
    icon: "vat", d: 280,
    title: { en: "VAT Return Reports", ar: "تقارير إقرار ضريبة القيمة المضافة" },
    body: { en: "Output vs. input VAT calculated from every sale, expense, and supplier payment — export as PDF or CSV.", ar: "احتساب ضريبة المخرجات مقابل ضريبة المدخلات من كل بيع ومصروف ودفعة مورد، مع تصدير بصيغة PDF أو CSV." },
  },
  {
    icon: "calendar", d: 380,
    title: { en: "Installment Due-Date Calendar", ar: "تقويم استحقاق الأقساط" },
    body: { en: "See every financed sale's upcoming installment in one collections calendar — never miss a due date.", ar: "شاهد جميع أقساط المبيعات الممولة القادمة في تقويم تحصيل واحد، ولا تفوّت أي تاريخ استحقاق." },
  },
];

/* ------------------------------------------------------------------ */
/* Integrations                                                         */
/* ------------------------------------------------------------------ */

export const GROW = {
  eyebrow: { en: "Growth", ar: "النمو" },
  pause: { en: "Pause rotation", ar: "إيقاف التدوير مؤقتاً" },
  play: { en: "Resume rotation", ar: "استئناف التدوير" },
  title: { en: "Grow beyond the showroom floor", ar: "انطلق خارج صالة العرض" },
  lede: {
    en: "A bilingual public website, a unified social inbox, and internal team chat — everything that touches a customer or a coworker, in one place.",
    ar: "موقع إلكتروني عام ثنائي اللغة، صندوق وارد موحّد لمنصات التواصل، ومحادثات داخلية للفريق، كل ما يتعلق بعميل أو زميل عمل، في مكان واحد.",
  },
} as const satisfies Record<string, Bi>;

export type Integration = Readonly<{ name: Bi; sub: Bi; color: string; d: string }>;

export const INTEGRATIONS: readonly Integration[] = [
  {
    name: { en: "WhatsApp", ar: "واتساب" }, sub: { en: "Leads and follow-ups in one thread", ar: "العملاء والمتابعات في محادثة واحدة" }, color: "#25D366",
    d: "M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .1-1.7-.1-.4-.1-.9-.3-1.5-.6-2.7-1.2-4.4-3.9-4.6-4.1-.1-.2-1-1.4-1-2.6s.6-1.8.9-2.1c.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.3 0 .5l-.4.5-.3.3c-.1.1-.2.3 0 .5.2.3.7 1.2 1.6 2 1.1.9 2 1.2 2.3 1.3.2.1.4.1.5-.1l.8-.9c.2-.2.3-.2.5-.1l2 .9c.2.1.4.2.4.3.1.2.1.6-.1 1.2z",
  },
  {
    name: { en: "Instagram", ar: "إنستغرام" }, sub: { en: "Comments and DMs become leads", ar: "التعليقات والرسائل تتحول لعملاء" }, color: "#E1306C",
    d: "M12 2.2c3.2 0 3.6 0 4.9.1 3.3.1 4.8 1.7 4.9 4.9.1 1.3.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 3.2-1.6 4.8-4.9 4.9-1.3.1-1.6.1-4.9.1s-3.6 0-4.8-.1c-3.3-.1-4.8-1.7-4.9-4.9-.1-1.3-.1-1.6-.1-4.8s0-3.6.1-4.8C2.4 4 3.9 2.4 7.2 2.3c1.2-.1 1.6-.1 4.8-.1zm0 5a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6zm0 7.9a3.1 3.1 0 1 1 0-6.2 3.1 3.1 0 0 1 0 6.2zm6.1-8.1a1.1 1.1 0 1 1-2.3 0 1.1 1.1 0 0 1 2.3 0z",
  },
  {
    name: { en: "Facebook", ar: "فيسبوك" }, sub: { en: "Auto-post vehicles when they go live", ar: "نشر السيارات تلقائياً عند توفرها" }, color: "#1877F2",
    d: "M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12z",
  },
  {
    name: { en: "Dealer site", ar: "موقع المعرض" }, sub: { en: "Bilingual site synced to live stock", ar: "موقع ثنائي اللغة مرتبط بمخزونك" }, color: "#3C48EC",
    d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 1.8c1.4 0 2.9 2.3 3.4 5.3H8.6C9.1 6.1 10.6 3.8 12 3.8zM4 12c0-.8.1-1.5.3-2.2h3.9a22 22 0 0 0 0 4.4H4.3c-.2-.7-.3-1.4-.3-2.2zm.9 4h3.5c.4 2 1 3.5 1.7 4.4A8.2 8.2 0 0 1 4.9 16zm3.3-8H4.9a8.2 8.2 0 0 1 5.2-4.4C9.4 4.5 8.8 6 8.4 8zm3.8 12.2c-1.4 0-2.9-2.3-3.4-5.2h6.8c-.5 2.9-2 5.2-3.4 5.2zm3.7-6.8H8.3a20 20 0 0 1 0-4.4h7.4a20 20 0 0 1 0 4.4zm.2 6.4c.7-.9 1.3-2.4 1.7-4.4h3.5a8.2 8.2 0 0 1-5.2 4.4zM16.1 8c-.4-2-1-3.5-1.7-4.4A8.2 8.2 0 0 1 19.6 8h-3.5zm3.6 6c.2-.7.3-1.4.3-2.2s-.1-1.5-.3-2.2h-3.9a22 22 0 0 1 0 4.4h3.9z",
  },
  {
    name: { en: "Bank statement", ar: "كشف الحساب" }, sub: { en: "Upload and get scored matches", ar: "ارفع الكشف واحصل على مطابقات" }, color: "#0F9D58",
    d: "M3 9.5L12 4l9 5.5v1.5H3V9.5zM5 13h2v6H5v-6zm4 0h2v6H9v-6zm4 0h2v6h-2v-6zm4 0h2v6h-2v-6zM3 20h18v2H3v-2z",
  },
  {
    name: { en: "CSV import", ar: "استيراد الملفات" }, sub: { en: "Columns mapped automatically", ar: "مطابقة الأعمدة تلقائياً" }, color: "#F0A81E",
    d: "M6 2h8l4 4v16H6V2zm7 1.5V7h3.5L13 3.5zM8.5 12h7v1.6h-7V12zm0 3.2h7v1.6h-7v-1.6zm0-6.4h3.5v1.6H8.5V8.8z",
  },
  {
    name: { en: "Mobile app", ar: "تطبيق الجوال" }, sub: { en: "Installable PWA for the floor", ar: "تطبيق قابل للتثبيت لفريق المعرض" }, color: "#3A3E46",
    d: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v13h10V5H7zm4 14.2h2v1.3h-2v-1.3z",
  },
];

/* ------------------------------------------------------------------ */
/* Voices                                                               */
/* ------------------------------------------------------------------ */

export const VOICES_HEAD = {
  eyebrow: { en: "Voices", ar: "آراء" },
  title: { en: "What dealerships say", ar: "ماذا تقول المعارض" },
  prev: { en: "Previous", ar: "السابق" },
  next: { en: "Next", ar: "التالي" },
} as const satisfies Record<string, Bi>;

export type Voice = Readonly<{ who: Bi; role: Bi; quote: Bi }>;

/** No portraits by design: a generated face must not be attached to a real
 *  person's name. Cards carry name, role and quote only. */
export const VOICES: readonly Voice[] = [
  {
    who: { en: "Alaa", ar: "علاء" },
    role: { en: "General Manager, multi-branch dealership", ar: "مدير عام، معرض متعدد الفروع" },
    quote: {
      en: "The approval queue alone changed how we work — nothing gets invoiced below margin without me seeing it first.",
      ar: "قائمة الاعتماد وحدها غيّرت طريقة عملنا، لا تصدر أي فاتورة تحت الهامش دون أن أراها أولاً.",
    },
  },
  {
    who: { en: "Thaer", ar: "ثائر" },
    role: { en: "Finance Lead", ar: "مدير الحسابات" },
    quote: {
      en: "We closed our first month without exporting anything to a separate accounting package. The ledger was already balanced.",
      ar: "أقفلنا أول شهر دون تصدير أي شيء إلى برنامج محاسبي منفصل، فدفتر الأستاذ كان متوازناً بالفعل.",
    },
  },
  {
    who: { en: "Mohammad", ar: "محمد" },
    role: { en: "Dealership Owner", ar: "مالك معرض" },
    quote: {
      en: "The Arabic interface is the real thing, not a mirrored layout. My reception team switched over in a day.",
      ar: "الواجهة العربية حقيقية وليست مجرد انعكاس للتصميم. فريق الاستقبال لدينا انتقل إليها خلال يوم واحد.",
    },
  },
];

/* ------------------------------------------------------------------ */
/* CTA band, pricing, FAQ, footer                                       */
/* ------------------------------------------------------------------ */

export const BAND = {
  title: { en: "From first enquiry to signed contract", ar: "من أول استفسار حتى توقيع العقد" },
  body: {
    en: "Move your stock, your customers and your books onto one workspace. Import templates and migration help included.",
    ar: "انقل مخزونك وعملاءك وسجلاتك المحاسبية إلى مساحة عمل واحدة، مع قوالب استيراد جاهزة ومساعدة كاملة في ترحيل البيانات.",
  },
} as const satisfies Record<string, Bi>;

export const PRICING = {
  eyebrow: { en: "Pricing", ar: "الأسعار" },
  title: { en: "Elite dealership plans", ar: "الاستثمار في التميز" },
  lede: { en: "Zero complexity. One plan built for high-performance showrooms.", ar: "لا توجد تعقيدات. باقة واحدة تشمل كل شيء، مصممة للمعارض التي لا ترضى بأقل من الكمال." },
  badge: { en: "Best Value", ar: "الأكثر طلباً" },
  plan: { en: "AutoFlow Complete", ar: "أوتوفلو المتكاملة" },
  note: { en: "One plan. Everything included.", ar: "باقة واحدة. كل شيء مشمول." },
  cta: { en: "Elevate Your Dealership Now", ar: "ارتقِ بمعرضك إلى النخبة الآن" },
} as const satisfies Record<string, Bi>;

export const PLAN_POINTS: readonly Bi[] = [
  { en: "Unlimited vehicles, customers and leads", ar: "عدد غير محدود من المركبات والعملاء" },
  { en: "Full accounting module & VAT returns", ar: "وحدة المحاسبة الكاملة وإقرارات الضريبة" },
  { en: "Bilingual dealer website included", ar: "موقع إلكتروني ثنائي اللغة للمعرض" },
  { en: "Instagram & Facebook social inbox", ar: "صندوق وارد إنستغرام وفيسبوك" },
  { en: "Multi-branch operations & approvals", ar: "إدارة متعددة الفروع وسلاسل الاعتماد" },
  { en: "Data migration & onboarding support", ar: "ترحيل البيانات ودعم التأسيس" },
];

export const FAQ_HEAD = {
  title: { en: "Frequently asked questions", ar: "الأسئلة الشائعة" },
  lede: { en: "Everything you need to know about migrating your showroom operations.", ar: "كل ما تود معرفته عن ترحيل بيانات معرضك ونظام أوتوفلو." },
} as const satisfies Record<string, Bi>;

export type Faq = Readonly<{ q: Bi; a: Bi }>;

export const FAQS: readonly Faq[] = [
  {
    q: { en: "Can we transfer our existing vehicle stock and customer list?", ar: "هل يمكننا نقل قائمة السيارات والعملاء الحالية لدينا بسهولة؟" },
    a: {
      en: "Absolutely. AutoFlow provides clean CSV and JSON templates to batch-import your entire inventory and customer history in minutes. Our tech staff is also available for direct database migrations.",
      ar: "بالتأكيد. يوفر أوتوفلو قوالب استيراد مرنة بصيغة CSV و JSON لرفع مخزونك وبيانات العملاء دفعة واحدة خلال دقائق. فريقنا التقني متواجد أيضاً لمساعدتك في نقل البيانات بالكامل.",
    },
  },
  {
    q: { en: "How do profit protection thresholds and approvals work?", ar: "كيف تعمل حماية هوامش أرباح الصفقات واعتماد المعاملات؟" },
    a: {
      en: "You set target profit percentages per brand or branch. If a salesperson configures a deal below these margins, AutoFlow automatically blocks invoicing and pushes a secure approval request to the manager dashboard with SMS notifications.",
      ar: "يمكنك تحديد هوامش الربح المستهدفة لكل علامة تجارية أو فرع. إذا حاول موظف المبيعات إدخال صفقة بأرباح أقل، يقوم النظام تلقائياً بتجميدها وإرسال طلب موافقة فوري لهاتف لوحة تحكم المدير لإقرارها أو رفضها.",
    },
  },
  {
    q: { en: "Is AutoFlow optimized for multi-branch dealerships?", ar: "هل يدعم أوتوفلو معارض السيارات ذات الفروع المتعددة؟" },
    a: {
      en: "Yes. Our enterprise plan supports granular branch-scoping, permitting salesmen to view local stock while enabling executives to monitor consolidated inventory, sales, and analytics across all regional sites.",
      ar: "نعم. يدعم أوتوفلو تقسيم الصلاحيات والمخزون للفروع المتعددة. حيث يمكن للموظف رؤية سيارات فرعه المحلي فقط، بينما يستطيع المسؤول العام تتبع كافة الفروع والتقارير المالية المدمجة بكفاءة.",
    },
  },
  {
    q: { en: "Can we control exactly what each employee sees and does?", ar: "هل يمكننا التحكم بدقة بما يراه ويفعله كل موظف؟" },
    a: {
      en: "Yes. AutoFlow ships with five role templates (Owner, Manager, Sales, Reception, Accountant) covering the most common dealership structures, and every permission is individually toggleable per role — so you can lock down cost prices, deletions, or financial views exactly the way you want.",
      ar: "نعم. يأتي أوتوفلو بخمسة قوالب أدوار جاهزة (مالك، مدير، مبيعات، استقبال، محاسب) تغطي أكثر الهياكل التنظيمية شيوعاً، وكل صلاحية قابلة للتفعيل أو التعطيل بشكل فردي لكل دور، فتستطيع التحكم بدقة في من يرى سعر التكلفة أو يحذف السجلات أو يصل للبيانات المالية.",
    },
  },
  {
    q: { en: "Is the Arabic interface a real translation or just a mirrored layout?", ar: "هل واجهة اللغة العربية ترجمة حقيقية أم مجرد انعكاس للتصميم؟" },
    a: {
      en: "It is a genuine right-to-left experience, not a CSS mirror trick. Every screen, form, and report is fully translated and laid out natively for Arabic, and switching languages is instant — no reload, no broken layouts.",
      ar: "هي تجربة عربية حقيقية بترتيب من اليمين لليسار، وليست مجرد انعكاس بصري بواسطة CSS. كل شاشة ونموذج وتقرير مترجم بالكامل ومصمم بشكل أصلي للغة العربية، والتبديل بين اللغتين فوري دون إعادة تحميل أو أي خلل في التصميم.",
    },
  },
  {
    q: { en: "Can AutoFlow build our dealership’s public website?", ar: "هل يمكن لأوتوفلو بناء الموقع الإلكتروني العام لمعرضنا؟" },
    a: {
      en: "Yes. Every org gets a bilingual, public-facing dealer website synced live to your inventory, with a choice of standard themes plus premium designs — no separate hosting or developer needed.",
      ar: "نعم. تحصل كل مؤسسة على موقع إلكتروني عام ثنائي اللغة مرتبط مباشرة بمخزونها الحي، مع تشكيلة من القوالب القياسية والتصاميم المميزة، دون الحاجة لاستضافة منفصلة أو مطور.",
    },
  },
  {
    q: { en: "Does AutoFlow connect to our Instagram and Facebook pages?", ar: "هل يتصل أوتوفلو بصفحاتنا على إنستغرام وفيسبوك؟" },
    a: {
      en: "Yes. Connect your pages to auto-post vehicles when they go available, capture every comment and DM into one Social Inbox, auto-reply to common questions, and convert engaged followers straight into leads.",
      ar: "نعم. اربط صفحاتك لنشر السيارات تلقائياً عند توفرها، وتجميع كل تعليق ورسالة خاصة في صندوق وارد اجتماعي واحد، مع رد تلقائي على الأسئلة الشائعة وتحويل المتابعين المتفاعلين إلى عملاء محتملين مباشرة.",
    },
  },
];

export const FOOTER = {
  blurb: {
    en: "The dealership operating system — inventory, CRM, sales, accounting and reporting in one bilingual workspace.",
    ar: "نظام تشغيل المعارض — المخزون وعلاقات العملاء والمبيعات والمحاسبة والتقارير في مساحة عمل واحدة ثنائية اللغة.",
  },
  product: { en: "Product", ar: "المنتج" },
  grow: { en: "Grow", ar: "النمو" },
  company: { en: "Company", ar: "الشركة" },
  inventory: { en: "Inventory", ar: "المخزون" },
  permissions: { en: "Permissions", ar: "الصلاحيات" },
  dealFlow: { en: "Deal Flow", ar: "دورة العمل" },
  accounting: { en: "Accounting", ar: "المحاسبة" },
  dealerSite: { en: "Dealer Website", ar: "موقع المعرض" },
  socialInbox: { en: "Social Inbox", ar: "صندوق الوارد الاجتماعي" },
  teamChat: { en: "Team Chat", ar: "محادثات الفريق" },
  pricing: { en: "Pricing", ar: "الأسعار" },
  contact: { en: "Contact Us", ar: "تواصل معنا" },
  privacy: { en: "Privacy Policy", ar: "سياسة الخصوصية" },
  terms: { en: "Terms of Service", ar: "شروط الخدمة" },
  rights: { en: "© 2026 AutoFlow. All rights reserved.", ar: "© 2026 أوتوفلو. جميع الحقوق محفوظة." },
} as const satisfies Record<string, Bi>;

export const REDUCED_MOTION = {
  notice: { en: "Your system has reduced motion on, so the animations are off.", ar: "إعداد تقليل الحركة مفعّل في جهازك، لذا الرسوم المتحركة معطّلة." },
  play: { en: "Play anyway", ar: "شغّلها على أي حال" },
} as const satisfies Record<string, Bi>;
