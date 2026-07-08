import type { Lang, PublicSite, PublicVehicle } from "./theme-props";

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
    const heightClass = size === "lg" ? "h-12" : size === "sm" ? "h-8" : "h-10";
    return (
      <img
        src={profile.logoUrl}
        alt={profile.dealershipName}
        className={`${heightClass} w-auto max-w-[220px] object-contain ${className ?? ""}`}
      />
    );
  }
  const textSizeClass = size === "lg" ? "text-2xl md:text-3xl" : size === "sm" ? "text-lg" : "text-xl md:text-2xl";
  const colorClass = light ? "text-white" : "text-luxury-gold dark:text-jod-gold";
  return (
    <span className={`font-display-luxury ${textSizeClass} ${colorClass} truncate max-w-[260px] ${className ?? ""}`}>
      {profile.dealershipName}
    </span>
  );
}

type KineticStrings = { [K in keyof typeof KINETIC_STRINGS.en]: string };

export function useKineticStrings(lang: Lang): KineticStrings {
  return KINETIC_STRINGS[lang];
}

export const KINETIC_STRINGS = {
  en: {
    whatsappSupport: "WhatsApp Support",
    allRightsReserved: "All Rights Reserved",
    quickLinks: "Quick Links",
    policiesHeading: "Policies",
    financeCalculatorLabel: "Finance Calculator",
    viewDetails: "View Details",
    chat: "Chat",
    whatsapp: "WhatsApp",
    callNow: "Call Now",
    allVehicles: "All Vehicles",
    serviceCenter: "Service Center",
    contactUsHeading: "Contact Us",
    contactUsButton: "Contact Us",
    bookTestDrive: "Book Test Drive",
    locations: "Locations",
    yearSpecLabel: "Year",

    // Luxury home
    luxuryHeroTitle: "Luxury Redefined",
    luxuryHeroSubtitle:
      "Experience the pinnacle of automotive excellence. Discover a curated collection of the world's most prestigious marques.",
    luxuryBrowseCollection: "Browse Exclusive Collection",
    luxuryPrivateVisit: "Private Showroom Visit",
    luxuryStatHeritage: "Years of Heritage",
    luxuryStatDeliveries: "Elite Deliveries",
    luxuryStatSourcing: "Global Sourcing",
    luxuryStatService: "Private Service",
    featuredInventory: "Featured Inventory",
    curatedMasterpieces: "Curated Masterpieces",
    viewAllVehicles: "View All Vehicles",
    trustedExcellence: "Trusted Excellence",
    establishedBadge: "Est. 2009",
    theStandard: "The Standard",
    beyondAcquisition: "Beyond Acquisition",
    whiteGloveTitle: "White-Glove Service",
    whiteGloveDesc: "Every vehicle undergoes a thorough inspection by certified technicians to ensure absolute perfection.",
    intlSourcingTitle: "International Sourcing",
    intlSourcingDesc: "If your dream car isn't in our showroom, our network will locate it and manage the entire process.",
    legacyTrustTitle: "Legacy of Trust",
    legacyTrustDesc: "A heritage of serving the most discerning clients with dedication and care.",
    privateConsultationTitle: "Interested in a Private Consultation?",
    privateConsultationDesc: "Our specialists are available to discuss your requirements discreetly and professionally.",
    connectWhatsapp: "Connect via WhatsApp",
    requestCallBack: "Request a Call Back",
    footerExplore: "Explore",
    footerOurInventory: "Our Inventory",
    footerLuxuryConcierge: "Concierge",
    footerFinanceOptions: "Finance Options",
    footerShowroomLocation: "Showroom Location",
    footerCompany: "Company",
    footerShowroom: "Showroom",
    luxuryFooterSloganDefault: "The destination for premium automotive experiences. Excellence in every detail, from showroom to garage.",

    // Modern EV home
    evBadge: "NEW ELECTRIC MODELS NOW AVAILABLE",
    evHeroTitle: "The Future is Electric",
    evHeroSubtitle: "Experience the peak of automotive innovation. Precision engineered for the road ahead.",
    evExploreInventory: "Explore EV Inventory",
    evChargingGuide: "Charging & Range Guide",
    premiumFleet: "Premium Fleet",
    chargingSectionTitle: "Powering Your Journey Home & Beyond",
    chargingSectionDesc:
      "Say goodbye to gas stations. Our holistic charging ecosystem provides smart wall-boxes for your home and exclusive access to the fastest charging network.",
    homeChargerTitle: "Home Charger",
    homeChargerDesc: "Full charge overnight with our smart home charging station.",
    nationwideNetworkTitle: "Nationwide Network",
    nationwideNetworkDesc: "Access to fast chargers across the country via our app.",
    exploreInfrastructure: "Explore Infrastructure",
    chargingNetworkPoints: "Charging Points",
    publicChargingNetwork: "Public Charging Network",
    efficiencyAdvantage: "The Efficiency Advantage",
    monthlyDistance: "Monthly Distance",
    gasPriceLabel: "Gas Price (JOD/L)",
    estimatedElectricityCost: "Estimated Electricity Cost",
    kwhAverage: "/ kWh Average",
    estimatedYearlySavings: "ESTIMATED YEARLY SAVINGS",
    yearlySavingsNote: "Based on local utility rates and average combustion engine efficiency.",
    startYourSwitch: "Start Your Switch",
    intelligenceTitle: "Intelligence in Every Kilowatt",
    autopilotTitle: "Advanced Assistance",
    autopilotDesc: "Advanced sensor fusion for a safer, more relaxed drive.",
    otaTitle: "OTA Updates",
    otaDesc: "Your car gets better over time with wireless software upgrades.",
    appCommandTitle: "App Command",
    appCommandDesc: "Control climate, location, and security from your smartphone.",
    safetyCoreTitle: "Safety Core",
    safetyCoreDesc: "Top safety ratings with reinforced battery protection.",
    evFooterOwnersHeading: "Owners",
    evFooterSloganDefault: "Redefining how we move, one charge at a time.",

    // Sales home
    carsAvailableSuffix: "Cars Available",
    salesHeroTitle: "Find Your Next Car Today",
    salesHeroSubtitle: "The largest selection of premium used and new vehicles. Quality inspected. Finance approved. Ready for delivery.",
    viewAllInventory: "View All Inventory",
    calculateMonthlyPayment: "Calculate Monthly Payment",
    weeklySpecial: "Weekly Special",
    askAboutDeals: "Ask About Our Deals",
    hotOffers: "Hot Offers",
    estimateInstallmentsTitle: "Estimate your installments",
    inTenSeconds: "in 10 seconds",
    instantEstimateDesc: "Get an instant monthly payment estimate. No commitment required.",
    fastApprovalTitle: "Fast Approval",
    fastApprovalDesc: "Response within 24 hours",
    lowInterestTitle: "Low Interest",
    lowInterestDesc: "Starting from 4.5% annually",
    carPriceLabel: "Car Price (JOD)",
    downPaymentPercentLabel: "Down Payment (%)",
    estimatedMonthlyPayment: "Estimated Monthly Payment",
    perMonth: "/ month*",
    applyForFinanceNow: "Apply for Finance Now",
    financeTermsNote: "*Terms and conditions apply. Rates may vary based on credit profile and bank approval.",
    readyToDriveDream: "Ready to drive your dream car?",
    chatWithSales: "Chat with Sales",
    salesFooterGetInTouch: "Get In Touch",
    salesFooterGetInTouchDesc: "Have a question? Reach out and our team will respond shortly.",
    salesFooterSloganDefault: "Bringing transparency and efficiency to every transaction.",

    // Inventory list / card / detail
    filterInventory: "Filter Inventory",
    priceRangeLabel: "Price Range",
    makeLabel: "Make",
    allMakes: "All Makes",
    searchPlaceholder: "Search vehicle...",
    keySpecifications: "Key Specifications",
    vehicleDescriptionHeading: "Vehicle Description",
    vehicleDescriptionAvailable: "is available now",
    vehicleDescriptionMileage: "with {mileage} km on the odometer",
    vehicleDescriptionTransmission: "{transmission} transmission",
    vehicleDescriptionFuel: "running on {fuel}",
    vehicleDescriptionContact: "Contact us for a full inspection report and viewing appointment.",
    interestedInCar: "Interested in this car?",
    speakWithSalesTeam: "Speak with our sales team for personalized assistance.",
    whatsappSalesAdvisor: "WhatsApp Sales Advisor",
    callShowroom: "Call Showroom",
    ourLocation: "Our Location",
    similarInventory: "Similar Inventory",
    homeBreadcrumb: "Home",
    downPaymentSuffix: "Down Payment",
    termSuffix: "Term",
    monthsUnit: "Months",
    yearsUnit: "Years",
    monthlyInstallment: "Monthly Installment",
    applyForFinance: "Apply for Finance",
    inventoryFooterSloganDefault: "Providing unparalleled vehicle sourcing and financing solutions.",

    // Finance calculator page
    customizeYourPlan: "Customize Your Plan",
    vehiclePriceLabel: "Vehicle Price (JOD)",
    paymentPeriodLabel: "Payment Period (Months)",
    estimatedMonthlyInstallment: "Estimated Monthly Installment",
    totalRepayment: "Total Repayment",
    fixedInterestRate: "Fixed Interest Rate",
    downPaymentAmount: "Down Payment Amount",
    submitFinanceApplication: "Submit Finance Application",
    talkToSpecialist: "Talk to Specialist",
    certifiedAdvisorsTitle: "Certified Financial Advisors",
    certifiedAdvisorsDesc: "Our team ensures you get the best rates available.",
    disclaimerLabel: "DISCLAIMER:",
    defaultFinancingDisclaimer:
      "The values provided by this calculator are estimates for informational purposes only. Actual interest rates, monthly installments, and terms are subject to credit approval by our partner banking institutions.",
    calculatorLinkLabel: "Calculator",
    financeFooterSloganDefault: "Driving excellence in the automotive market.",
  },
  ar: {
    whatsappSupport: "دعم واتساب",
    allRightsReserved: "جميع الحقوق محفوظة",
    quickLinks: "روابط سريعة",
    policiesHeading: "السياسات",
    financeCalculatorLabel: "حاسبة التمويل",
    viewDetails: "عرض التفاصيل",
    chat: "محادثة",
    whatsapp: "واتساب",
    callNow: "اتصل الآن",
    allVehicles: "جميع المركبات",
    serviceCenter: "مركز الخدمة",
    contactUsHeading: "تواصل معنا",
    contactUsButton: "تواصل معنا",
    bookTestDrive: "احجز تجربة قيادة",
    locations: "الفروع",
    yearSpecLabel: "السنة",

    // Luxury home
    luxuryHeroTitle: "فخامة بلا حدود",
    luxuryHeroSubtitle: "استمتع بقمة التميز في عالم السيارات. اكتشف مجموعة مختارة من أرقى الماركات العالمية.",
    luxuryBrowseCollection: "تصفح المجموعة الحصرية",
    luxuryPrivateVisit: "زيارة خاصة للمعرض",
    luxuryStatHeritage: "سنوات من الإرث",
    luxuryStatDeliveries: "عملية تسليم مميزة",
    luxuryStatSourcing: "توريد عالمي",
    luxuryStatService: "خدمة خاصة",
    featuredInventory: "مركبات مميزة",
    curatedMasterpieces: "تحف مختارة بعناية",
    viewAllVehicles: "عرض جميع المركبات",
    trustedExcellence: "تميز موثوق",
    establishedBadge: "تأسست عام 2009",
    theStandard: "معيار",
    beyondAcquisition: "أكثر من مجرد اقتناء",
    whiteGloveTitle: "خدمة متكاملة",
    whiteGloveDesc: "تخضع كل مركبة لفحص دقيق من فنيين معتمدين لضمان الكمال المطلق.",
    intlSourcingTitle: "توريد دولي",
    intlSourcingDesc: "إذا لم تكن سيارة أحلامك في معرضنا، فإن شبكتنا ستحدد موقعها وتتولى كامل عملية التوريد.",
    legacyTrustTitle: "إرث من الثقة",
    legacyTrustDesc: "إرث طويل في خدمة أرقى العملاء بتفانٍ واهتمام.",
    privateConsultationTitle: "مهتم باستشارة خاصة؟",
    privateConsultationDesc: "خبراؤنا جاهزون لمناقشة متطلباتك بسرية واحترافية.",
    connectWhatsapp: "تواصل عبر واتساب",
    requestCallBack: "اطلب معاودة الاتصال",
    footerExplore: "استكشف",
    footerOurInventory: "مخزوننا",
    footerLuxuryConcierge: "خدمة الكونسيرج",
    footerFinanceOptions: "خيارات التمويل",
    footerShowroomLocation: "موقع المعرض",
    footerCompany: "الشركة",
    footerShowroom: "المعرض",
    luxuryFooterSloganDefault: "الوجهة الأولى لتجارب السيارات الفاخرة. تميز في كل التفاصيل، من المعرض إلى المرآب.",

    // Modern EV home
    evBadge: "طرازات كهربائية جديدة متوفرة الآن",
    evHeroTitle: "المستقبل كهربائي",
    evHeroSubtitle: "اختبر ذروة الابتكار في عالم السيارات. هندسة دقيقة لطريقك القادم.",
    evExploreInventory: "استكشف مخزون السيارات الكهربائية",
    evChargingGuide: "دليل الشحن والمدى",
    premiumFleet: "أسطول متميز",
    chargingSectionTitle: "نشحن رحلتك من المنزل وأبعد",
    chargingSectionDesc: "ودّع محطات الوقود. توفر منظومة الشحن لدينا محطات ذكية لمنزلك ووصولاً حصرياً لأسرع شبكة شحن.",
    homeChargerTitle: "شاحن منزلي",
    homeChargerDesc: "شحن كامل بين ليلة وضحاها مع محطة الشحن المنزلية الذكية.",
    nationwideNetworkTitle: "شبكة على مستوى الدولة",
    nationwideNetworkDesc: "وصول إلى شواحن سريعة في مختلف أنحاء البلاد عبر تطبيقنا.",
    exploreInfrastructure: "استكشف البنية التحتية",
    chargingNetworkPoints: "نقطة شحن",
    publicChargingNetwork: "شبكة شحن عامة",
    efficiencyAdvantage: "ميزة الكفاءة",
    monthlyDistance: "المسافة الشهرية",
    gasPriceLabel: "سعر الوقود (دينار/لتر)",
    estimatedElectricityCost: "تكلفة الكهرباء المقدرة",
    kwhAverage: "/ لكل كيلوواط ساعة",
    estimatedYearlySavings: "التوفير السنوي المقدر",
    yearlySavingsNote: "استناداً إلى أسعار الكهرباء المحلية ومتوسط كفاءة محرك الاحتراق.",
    startYourSwitch: "ابدأ التحول الآن",
    intelligenceTitle: "ذكاء في كل كيلوواط",
    autopilotTitle: "مساعدة متقدمة للقيادة",
    autopilotDesc: "استشعار متقدم لقيادة أكثر أماناً وراحة.",
    otaTitle: "تحديثات لاسلكية",
    otaDesc: "تتحسن سيارتك مع الوقت من خلال تحديثات البرامج اللاسلكية.",
    appCommandTitle: "تحكم عبر التطبيق",
    appCommandDesc: "تحكم بالتكييف والموقع والأمان من هاتفك الذكي.",
    safetyCoreTitle: "أمان أساسي",
    safetyCoreDesc: "أعلى تصنيفات الأمان مع حماية معززة للبطارية.",
    evFooterOwnersHeading: "المالكون",
    evFooterSloganDefault: "نعيد تعريف طريقة تنقلنا، شحنة تلو الأخرى.",

    // Sales home
    carsAvailableSuffix: "سيارة متوفرة",
    salesHeroTitle: "اعثر على سيارتك القادمة اليوم",
    salesHeroSubtitle: "أكبر تشكيلة من السيارات المستعملة والجديدة المتميزة. مفحوصة بجودة. تمويل معتمد. جاهزة للتسليم.",
    viewAllInventory: "عرض كل المخزون",
    calculateMonthlyPayment: "احسب القسط الشهري",
    weeklySpecial: "عرض الأسبوع",
    askAboutDeals: "اسأل عن عروضنا",
    hotOffers: "عروض ساخنة",
    estimateInstallmentsTitle: "احسب أقساطك",
    inTenSeconds: "في 10 ثوانٍ",
    instantEstimateDesc: "احصل على تقدير فوري للقسط الشهري. دون أي التزام.",
    fastApprovalTitle: "موافقة سريعة",
    fastApprovalDesc: "رد خلال 24 ساعة",
    lowInterestTitle: "فائدة منخفضة",
    lowInterestDesc: "ابتداءً من 4.5% سنوياً",
    carPriceLabel: "سعر السيارة (دينار)",
    downPaymentPercentLabel: "الدفعة الأولى (%)",
    estimatedMonthlyPayment: "القسط الشهري المقدر",
    perMonth: "/ شهرياً*",
    applyForFinanceNow: "تقدم بطلب تمويل الآن",
    financeTermsNote: "*تطبق الشروط والأحكام. قد تختلف الأسعار حسب الملف الائتماني وموافقة البنك.",
    readyToDriveDream: "جاهز لقيادة سيارة أحلامك؟",
    chatWithSales: "تحدث مع المبيعات",
    salesFooterGetInTouch: "تواصل معنا",
    salesFooterGetInTouchDesc: "لديك سؤال؟ تواصل معنا وسيرد فريقنا في أقرب وقت.",
    salesFooterSloganDefault: "نجلب الشفافية والكفاءة إلى كل معاملة.",

    // Inventory list / card / detail
    filterInventory: "تصفية المخزون",
    priceRangeLabel: "نطاق السعر",
    makeLabel: "الصانع",
    allMakes: "جميع الصانعين",
    searchPlaceholder: "ابحث عن مركبة...",
    keySpecifications: "المواصفات الرئيسية",
    vehicleDescriptionHeading: "وصف المركبة",
    vehicleDescriptionAvailable: "متوفرة الآن",
    vehicleDescriptionMileage: "بممشى {mileage} كم",
    vehicleDescriptionTransmission: "ناقل حركة {transmission}",
    vehicleDescriptionFuel: "تعمل بـ {fuel}",
    vehicleDescriptionContact: "تواصل معنا للحصول على تقرير فحص كامل وموعد معاينة.",
    interestedInCar: "مهتم بهذه المركبة؟",
    speakWithSalesTeam: "تحدث مع فريق المبيعات للحصول على مساعدة شخصية.",
    whatsappSalesAdvisor: "تواصل مع مستشار المبيعات عبر واتساب",
    callShowroom: "اتصل بالمعرض",
    ourLocation: "موقعنا",
    similarInventory: "مركبات مشابهة",
    homeBreadcrumb: "الرئيسية",
    downPaymentSuffix: "الدفعة الأولى",
    termSuffix: "المدة",
    monthsUnit: "أشهر",
    yearsUnit: "سنوات",
    monthlyInstallment: "القسط الشهري",
    applyForFinance: "تقدم بطلب تمويل",
    inventoryFooterSloganDefault: "نقدم حلولاً لا مثيل لها لتوريد المركبات والتمويل.",

    // Finance calculator page
    customizeYourPlan: "خصص خطتك",
    vehiclePriceLabel: "سعر المركبة (دينار)",
    paymentPeriodLabel: "مدة السداد (أشهر)",
    estimatedMonthlyInstallment: "القسط الشهري المقدر",
    totalRepayment: "إجمالي السداد",
    fixedInterestRate: "معدل الفائدة الثابت",
    downPaymentAmount: "مبلغ الدفعة الأولى",
    submitFinanceApplication: "تقديم طلب التمويل",
    talkToSpecialist: "تحدث مع مختص",
    certifiedAdvisorsTitle: "مستشارون ماليون معتمدون",
    certifiedAdvisorsDesc: "يضمن فريقنا حصولك على أفضل الأسعار المتاحة.",
    disclaimerLabel: "إخلاء مسؤولية:",
    defaultFinancingDisclaimer:
      "القيم المقدمة من هذه الحاسبة هي تقديرات لأغراض إعلامية فقط. تخضع أسعار الفائدة والأقساط الشهرية والمدد الفعلية لموافقة الائتمان من قبل البنوك الشريكة.",
    calculatorLinkLabel: "الحاسبة",
    financeFooterSloganDefault: "نقود التميز في سوق السيارات.",
  },
} as const;
