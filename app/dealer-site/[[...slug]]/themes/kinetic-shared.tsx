import { calculateUnifiedMurabaha } from "@/lib/financing";
import type { Lang, PublicSite, PublicVehicle } from "./theme-props";

/** Generic illustrative terms used when the seller hasn't picked one of their
 * configured finance companies (Settings > Finance) for the public calculator. */
export const DEFAULT_FINANCE_TERMS: NonNullable<PublicSite["financeCompany"]> = {
  name: "",
  profitRate: 4.5,
  maxTermMonths: 60,
  gracePeriodMonths: 0,
  insuranceRate: 0,
  adminFees: 0,
  commission: 0,
  includesCommissionInDebt: false,
};

export function estimateMonthlyInstallment({
  financeCompany,
  vehiclePrice,
  downPayment,
  termMonths,
}: {
  financeCompany: PublicSite["financeCompany"];
  vehiclePrice: number;
  downPayment: number;
  termMonths: number;
}) {
  const terms = financeCompany ?? DEFAULT_FINANCE_TERMS;
  return calculateUnifiedMurabaha({
    vehiclePrice,
    downPayment,
    commission: terms.commission,
    processingFees: terms.adminFees,
    annualProfitRate: terms.profitRate,
    annualInsuranceRate: terms.insuranceRate,
    termMonths,
    gracePeriodMonths: terms.gracePeriodMonths,
    includesCommissionInDebt: terms.includesCommissionInDebt,
  });
}

export function waLink(phone: string | null | undefined, message: string) {
  const digits = (phone ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export function telLink(phone: string | null | undefined) {
  return `tel:${(phone ?? "").replace(/\s+/g, "")}`;
}

export function vehicleTitle(v: PublicVehicle) {
  return `${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ""}`;
}

export function KineticVehicleImage({
  vehicle,
  className,
  iconClassName,
}: {
  vehicle: PublicVehicle;
  className?: string;
  iconClassName?: string;
}) {
  if (vehicle.imageUrls[0]) {
    return <img className={className} src={vehicle.imageUrls[0]} alt={vehicleTitle(vehicle)} />;
  }
  return (
    <div className={`flex items-center justify-center bg-surface-container text-outline-variant ${className ?? ""}`}>
      <span className={`material-symbols-outlined ${iconClassName ?? "text-4xl"}`}>directions_car</span>
    </div>
  );
}

/** Nav/footer brand mark: prefers the dealer's uploaded logo; falls back to a
 * reasonably-sized name instead of the oversized hero-scale wordmark, since a
 * real dealership name can run much longer than a short brand word. */
export function KineticBrand({
  profile,
  size = "md",
  light = false,
  className,
}: {
  profile: PublicSite["profile"];
  size?: "sm" | "md" | "lg";
  light?: boolean;
  className?: string;
}) {
  if (profile.logoUrl) {
    const heightClass = size === "lg" ? "h-16" : size === "sm" ? "h-9" : "h-12";
    return (
      <img
        src={profile.logoUrl}
        alt={profile.dealershipName}
        className={`${heightClass} w-auto max-w-[260px] object-contain ${className ?? ""}`}
      />
    );
  }
  const textSizeClass = size === "lg" ? "text-3xl md:text-4xl" : size === "sm" ? "text-xl" : "text-2xl md:text-3xl";
  const colorClass = light ? "text-white" : "text-luxury-gold dark:text-jod-gold";
  return (
    <span className={`font-display-luxury ${textSizeClass} ${colorClass} truncate max-w-[260px] ${className ?? ""}`}>
      {profile.dealershipName}
    </span>
  );
}

/**
 * [English, Arabic] pairs keyed by usage. Kept as one interleaved table
 * (rather than separate `en`/`ar` objects) so each translation pair sits on
 * one line — avoids two ~100-line blocks that mirror each other key-for-key,
 * which static analysis flags as duplicated code even though the values
 * differ per language.
 */
const KINETIC_TEXT = {
  whatsappSupport: ["WhatsApp Support", "دعم واتساب"],
  allRightsReserved: ["All Rights Reserved", "جميع الحقوق محفوظة"],
  quickLinks: ["Quick Links", "روابط سريعة"],
  policiesHeading: ["Policies", "السياسات"],
  financeCalculatorLabel: ["Finance Calculator", "حاسبة التمويل"],
  viewDetails: ["View Details", "عرض التفاصيل"],
  chat: ["Chat", "محادثة"],
  whatsapp: ["WhatsApp", "واتساب"],
  callNow: ["Call Now", "اتصل الآن"],
  allVehicles: ["All Vehicles", "جميع المركبات"],
  serviceCenter: ["Service Center", "مركز الخدمة"],
  contactUsHeading: ["Contact Us", "تواصل معنا"],
  contactUsButton: ["Contact Us", "تواصل معنا"],
  bookTestDrive: ["Book Test Drive", "احجز تجربة قيادة"],
  locations: ["Locations", "الفروع"],
  yearSpecLabel: ["Year", "السنة"],

  // Luxury home
  luxuryHeroTitle: ["Luxury Redefined", "فخامة بلا حدود"],
  luxuryHeroSubtitle: [
    "Experience the pinnacle of automotive excellence. Discover a curated collection of the world's most prestigious marques.",
    "استمتع بقمة التميز في عالم السيارات. اكتشف مجموعة مختارة من أرقى الماركات العالمية.",
  ],
  luxuryBrowseCollection: ["Browse Exclusive Collection", "تصفح المجموعة الحصرية"],
  luxuryPrivateVisit: ["Private Showroom Visit", "زيارة خاصة للمعرض"],
  luxuryStatHeritage: ["Years of Heritage", "سنوات من الإرث"],
  luxuryStatDeliveries: ["Elite Deliveries", "عملية تسليم مميزة"],
  luxuryStatSourcing: ["Global Sourcing", "توريد عالمي"],
  luxuryStatService: ["Private Service", "خدمة خاصة"],
  featuredInventory: ["Featured Inventory", "مركبات مميزة"],
  curatedMasterpieces: ["Curated Masterpieces", "تحف مختارة بعناية"],
  viewAllVehicles: ["View All Vehicles", "عرض جميع المركبات"],
  trustedExcellence: ["Trusted Excellence", "تميز موثوق"],
  establishedBadge: ["Est. 2009", "تأسست عام 2009"],
  theStandard: ["The Standard", "معيار"],
  beyondAcquisition: ["Beyond Acquisition", "أكثر من مجرد اقتناء"],
  whiteGloveTitle: ["White-Glove Service", "خدمة متكاملة"],
  whiteGloveDesc: [
    "Every vehicle undergoes a thorough inspection by certified technicians to ensure absolute perfection.",
    "تخضع كل مركبة لفحص دقيق من فنيين معتمدين لضمان الكمال المطلق.",
  ],
  intlSourcingTitle: ["International Sourcing", "توريد دولي"],
  intlSourcingDesc: [
    "If your dream car isn't in our showroom, our network will locate it and manage the entire process.",
    "إذا لم تكن سيارة أحلامك في معرضنا، فإن شبكتنا ستحدد موقعها وتتولى كامل عملية التوريد.",
  ],
  legacyTrustTitle: ["Legacy of Trust", "إرث من الثقة"],
  legacyTrustDesc: ["A heritage of serving the most discerning clients with dedication and care.", "إرث طويل في خدمة أرقى العملاء بتفانٍ واهتمام."],
  privateConsultationTitle: ["Interested in a Private Consultation?", "مهتم باستشارة خاصة؟"],
  privateConsultationDesc: ["Our specialists are available to discuss your requirements discreetly and professionally.", "خبراؤنا جاهزون لمناقشة متطلباتك بسرية واحترافية."],
  connectWhatsapp: ["Connect via WhatsApp", "تواصل عبر واتساب"],
  requestCallBack: ["Request a Call Back", "اطلب معاودة الاتصال"],
  footerExplore: ["Explore", "استكشف"],
  footerOurInventory: ["Our Inventory", "مخزوننا"],
  footerLuxuryConcierge: ["Concierge", "خدمة الكونسيرج"],
  footerFinanceOptions: ["Finance Options", "خيارات التمويل"],
  footerShowroomLocation: ["Showroom Location", "موقع المعرض"],
  footerCompany: ["Company", "الشركة"],
  footerShowroom: ["Showroom", "المعرض"],
  luxuryFooterSloganDefault: [
    "The destination for premium automotive experiences. Excellence in every detail, from showroom to garage.",
    "الوجهة الأولى لتجارب السيارات الفاخرة. تميز في كل التفاصيل، من المعرض إلى المرآب.",
  ],

  // Modern EV home
  evBadge: ["NEW ELECTRIC MODELS NOW AVAILABLE", "طرازات كهربائية جديدة متوفرة الآن"],
  evHeroTitle: ["The Future is Electric", "المستقبل كهربائي"],
  evHeroSubtitle: ["Experience the peak of automotive innovation. Precision engineered for the road ahead.", "اختبر ذروة الابتكار في عالم السيارات. هندسة دقيقة لطريقك القادم."],
  evExploreInventory: ["Explore EV Inventory", "استكشف مخزون السيارات الكهربائية"],
  evChargingGuide: ["Charging & Range Guide", "دليل الشحن والمدى"],
  premiumFleet: ["Premium Fleet", "أسطول متميز"],
  chargingSectionTitle: ["Powering Your Journey Home & Beyond", "نشحن رحلتك من المنزل وأبعد"],
  chargingSectionDesc: [
    "Say goodbye to gas stations. Our holistic charging ecosystem provides smart wall-boxes for your home and exclusive access to the fastest charging network.",
    "ودّع محطات الوقود. توفر منظومة الشحن لدينا محطات ذكية لمنزلك ووصولاً حصرياً لأسرع شبكة شحن.",
  ],
  homeChargerTitle: ["Home Charger", "شاحن منزلي"],
  homeChargerDesc: ["Full charge overnight with our smart home charging station.", "شحن كامل بين ليلة وضحاها مع محطة الشحن المنزلية الذكية."],
  nationwideNetworkTitle: ["Nationwide Network", "شبكة على مستوى الدولة"],
  nationwideNetworkDesc: ["Access to fast chargers across the country via our app.", "وصول إلى شواحن سريعة في مختلف أنحاء البلاد عبر تطبيقنا."],
  exploreInfrastructure: ["Explore Infrastructure", "استكشف البنية التحتية"],
  chargingNetworkPoints: ["Charging Points", "نقطة شحن"],
  publicChargingNetwork: ["Public Charging Network", "شبكة شحن عامة"],
  efficiencyAdvantage: ["The Efficiency Advantage", "ميزة الكفاءة"],
  monthlyDistance: ["Monthly Distance", "المسافة الشهرية"],
  gasPriceLabel: ["Gas Price (JOD/L)", "سعر الوقود (دينار/لتر)"],
  estimatedElectricityCost: ["Estimated Electricity Cost", "تكلفة الكهرباء المقدرة"],
  kwhAverage: ["/ kWh Average", "/ لكل كيلوواط ساعة"],
  estimatedYearlySavings: ["ESTIMATED YEARLY SAVINGS", "التوفير السنوي المقدر"],
  yearlySavingsNote: ["Based on local utility rates and average combustion engine efficiency.", "استناداً إلى أسعار الكهرباء المحلية ومتوسط كفاءة محرك الاحتراق."],
  startYourSwitch: ["Start Your Switch", "ابدأ التحول الآن"],
  intelligenceTitle: ["Intelligence in Every Kilowatt", "ذكاء في كل كيلوواط"],
  autopilotTitle: ["Advanced Assistance", "مساعدة متقدمة للقيادة"],
  autopilotDesc: ["Advanced sensor fusion for a safer, more relaxed drive.", "استشعار متقدم لقيادة أكثر أماناً وراحة."],
  otaTitle: ["OTA Updates", "تحديثات لاسلكية"],
  otaDesc: ["Your car gets better over time with wireless software upgrades.", "تتحسن سيارتك مع الوقت من خلال تحديثات البرامج اللاسلكية."],
  appCommandTitle: ["App Command", "تحكم عبر التطبيق"],
  appCommandDesc: ["Control climate, location, and security from your smartphone.", "تحكم بالتكييف والموقع والأمان من هاتفك الذكي."],
  safetyCoreTitle: ["Safety Core", "أمان أساسي"],
  safetyCoreDesc: ["Top safety ratings with reinforced battery protection.", "أعلى تصنيفات الأمان مع حماية معززة للبطارية."],
  evFooterOwnersHeading: ["Owners", "المالكون"],
  evFooterSloganDefault: ["Redefining how we move, one charge at a time.", "نعيد تعريف طريقة تنقلنا، شحنة تلو الأخرى."],

  // Sales home
  heroBadgeDefault: ["Quality Inspected · Trusted Dealer", "فحص شامل · وكيل موثوق"],
  salesHeroTitle: ["Find Your Next Car Today", "اعثر على سيارتك القادمة اليوم"],
  salesHeroSubtitle: [
    "The largest selection of premium used and new vehicles. Quality inspected. Finance approved. Ready for delivery.",
    "أكبر تشكيلة من السيارات المستعملة والجديدة المتميزة. مفحوصة بجودة. تمويل معتمد. جاهزة للتسليم.",
  ],
  viewAllInventory: ["View All Inventory", "عرض كل المخزون"],
  calculateMonthlyPayment: ["Calculate Monthly Payment", "احسب القسط الشهري"],
  weeklySpecial: ["Weekly Special", "عرض الأسبوع"],
  askAboutDeals: ["Ask About Our Deals", "اسأل عن عروضنا"],
  hotOffers: ["Hot Offers", "عروض ساخنة"],
  estimateInstallmentsTitle: ["Estimate your installments", "احسب أقساطك"],
  inTenSeconds: ["in 10 seconds", "في 10 ثوانٍ"],
  instantEstimateDesc: ["Get an instant monthly payment estimate. No commitment required.", "احصل على تقدير فوري للقسط الشهري. دون أي التزام."],
  fastApprovalTitle: ["Fast Approval", "موافقة سريعة"],
  lowInterestTitle: ["Low Interest", "فائدة منخفضة"],
  carPriceLabel: ["Car Price (JOD)", "سعر السيارة (دينار)"],
  downPaymentPercentLabel: ["Down Payment (%)", "الدفعة الأولى (%)"],
  estimatedMonthlyPayment: ["Estimated Monthly Payment", "القسط الشهري المقدر"],
  perMonth: ["/ month*", "/ شهرياً*"],
  applyForFinanceNow: ["Apply for Finance Now", "تقدم بطلب تمويل الآن"],
  financeTermsNote: ["*Terms and conditions apply. Rates may vary based on credit profile and bank approval.", "*تطبق الشروط والأحكام. قد تختلف الأسعار حسب الملف الائتماني وموافقة البنك."],
  readyToDriveDream: ["Ready to drive your dream car?", "جاهز لقيادة سيارة أحلامك؟"],
  chatWithSales: ["Chat with Sales", "تحدث مع المبيعات"],
  salesFooterGetInTouch: ["Get In Touch", "تواصل معنا"],
  salesFooterGetInTouchDesc: ["Have a question? Reach out and our team will respond shortly.", "لديك سؤال؟ تواصل معنا وسيرد فريقنا في أقرب وقت."],
  salesFooterSloganDefault: ["Bringing transparency and efficiency to every transaction.", "نجلب الشفافية والكفاءة إلى كل معاملة."],

  // Inventory list / card / detail
  filterInventory: ["Filter Inventory", "تصفية المخزون"],
  priceRangeLabel: ["Price Range", "نطاق السعر"],
  makeLabel: ["Make", "الصانع"],
  allMakes: ["All Makes", "جميع الصانعين"],
  searchPlaceholder: ["Search vehicle...", "ابحث عن مركبة..."],
  keySpecifications: ["Key Specifications", "المواصفات الرئيسية"],
  vehicleDescriptionHeading: ["Vehicle Description", "وصف المركبة"],
  vehicleDescriptionAvailable: ["is available now", "متوفرة الآن"],
  vehicleDescriptionMileage: ["with {mileage} km on the odometer", "بممشى {mileage} كم"],
  vehicleDescriptionTransmission: ["{transmission} transmission", "ناقل حركة {transmission}"],
  vehicleDescriptionFuel: ["running on {fuel}", "تعمل بـ {fuel}"],
  vehicleDescriptionContact: ["Contact us for a full inspection report and viewing appointment.", "تواصل معنا للحصول على تقرير فحص كامل وموعد معاينة."],
  interestedInCar: ["Interested in this car?", "مهتم بهذه المركبة؟"],
  speakWithSalesTeam: ["Speak with our sales team for personalized assistance.", "تحدث مع فريق المبيعات للحصول على مساعدة شخصية."],
  whatsappSalesAdvisor: ["WhatsApp Sales Advisor", "تواصل مع مستشار المبيعات عبر واتساب"],
  callShowroom: ["Call Showroom", "اتصل بالمعرض"],
  ourLocation: ["Our Location", "موقعنا"],
  similarInventory: ["Similar Inventory", "مركبات مشابهة"],
  homeBreadcrumb: ["Home", "الرئيسية"],
  downPaymentSuffix: ["Down Payment", "الدفعة الأولى"],
  termSuffix: ["Term", "المدة"],
  monthsUnit: ["Months", "أشهر"],
  yearsUnit: ["Years", "سنوات"],
  monthlyInstallment: ["Monthly Installment", "القسط الشهري"],
  applyForFinance: ["Apply for Finance", "تقدم بطلب تمويل"],
  inventoryFooterSloganDefault: ["Providing unparalleled vehicle sourcing and financing solutions.", "نقدم حلولاً لا مثيل لها لتوريد المركبات والتمويل."],

  // Finance calculator page
  customizeYourPlan: ["Customize Your Plan", "خصص خطتك"],
  vehiclePriceLabel: ["Vehicle Price (JOD)", "سعر المركبة (دينار)"],
  paymentPeriodLabel: ["Payment Period (Months)", "مدة السداد (أشهر)"],
  estimatedMonthlyInstallment: ["Estimated Monthly Installment", "القسط الشهري المقدر"],
  totalRepayment: ["Total Repayment", "إجمالي السداد"],
  fixedInterestRate: ["Fixed Interest Rate", "معدل الفائدة الثابت"],
  downPaymentAmount: ["Down Payment Amount", "مبلغ الدفعة الأولى"],
  submitFinanceApplication: ["Submit Finance Application", "تقديم طلب التمويل"],
  talkToSpecialist: ["Talk to Specialist", "تحدث مع مختص"],
  certifiedAdvisorsTitle: ["Certified Financial Advisors", "مستشارون ماليون معتمدون"],
  certifiedAdvisorsDesc: ["Our team ensures you get the best rates available.", "يضمن فريقنا حصولك على أفضل الأسعار المتاحة."],
  disclaimerLabel: ["DISCLAIMER:", "إخلاء مسؤولية:"],
  defaultFinancingDisclaimer: [
    "The values provided by this calculator are estimates for informational purposes only. Actual interest rates, monthly installments, and terms are subject to credit approval by our partner banking institutions.",
    "القيم المقدمة من هذه الحاسبة هي تقديرات لأغراض إعلامية فقط. تخضع أسعار الفائدة والأقساط الشهرية والمدد الفعلية لموافقة الائتمان من قبل البنوك الشريكة.",
  ],
  calculatorLinkLabel: ["Calculator", "الحاسبة"],
  financeFooterSloganDefault: ["Driving excellence in the automotive market.", "نقود التميز في سوق السيارات."],
} as const satisfies Record<string, readonly [string, string]>;

type KineticKey = keyof typeof KINETIC_TEXT;
type KineticStrings = Record<KineticKey, string>;

function buildKineticStrings(langIndex: 0 | 1): KineticStrings {
  const entries = (Object.keys(KINETIC_TEXT) as KineticKey[]).map(
    (key) => [key, KINETIC_TEXT[key][langIndex]] as const
  );
  return Object.fromEntries(entries) as KineticStrings;
}

const KINETIC_STRINGS_BY_LANG: Record<Lang, KineticStrings> = {
  en: buildKineticStrings(0),
  ar: buildKineticStrings(1),
};

export function useKineticStrings(lang: Lang): KineticStrings {
  return KINETIC_STRINGS_BY_LANG[lang];
}
