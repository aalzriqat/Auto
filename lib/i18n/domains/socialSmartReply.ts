// Smart Reply (rule-based price/financing/availability/vehicleInfo/location
// auto-answers for Instagram/Facebook comments & DMs). These keys serve two
// consumers: the Settings UI (via useLanguage()/t()) AND
// convex/utils/smartReplyBuilder.ts, which imports the raw socialSmartReplyEn/
// socialSmartReplyAr objects directly (a Convex mutation can't use a React
// hook). Both read from this one file so the reply copy and settings labels
// never drift out of sync. Reply templates use plain {placeholder} tokens
// resolved via .replace(), matching the convention already used elsewhere
// (e.g. components/marketing/MarketingChatWidget.tsx).
export const socialSmartReplyEn = {
  SmartReplyPriceAvailable: "{model} ({year}) is priced at {price} {currency}. Would you like a sales rep to follow up?",
  SmartReplyFinancingCalculated: "Financing is available for {model} ({year}) — estimated monthly payments start from {monthlyAmount} {currency}/month, subject to approval.",
  SmartReplyFinancingGeneric: "Financing is available for {model} ({year}). Message us and a sales rep will share your personalized monthly rate.",
  SmartReplyAvailableYes: "Yes, {model} ({year}) is currently available. Would you like a sales rep to contact you?",
  SmartReplyAvailableSold: "This vehicle is no longer available — check our other listings or message us for similar options.",
  SmartReplyAvailableUnclear: "This vehicle isn't currently available for sale. Message us and we'll let you know about similar options.",
  SmartReplyVehicleInfo: "{model} ({year}{trimSuffix}): {mileage} km, {color}, {fuelType}, {transmission}.",
  SmartReplyLocation: "You can find us at {dealershipName}, {dealershipAddress}{phoneSuffix}.",
  SmartReplyLocationFallback: "Message us and we'll send you our location.",
  SmartReplyGreeting: "Hi! 👋 Ask us about price, financing, or availability for any vehicle.",

  SmartReplyTitle: "Instant Auto-Reply",
  SmartReplyDescription: "Automatically answer price, financing, and availability questions on Instagram and Facebook comments and DMs.",
  SmartReplyEnableInstagram: "Enable for Instagram",
  SmartReplyEnableFacebook: "Enable for Facebook",
  SmartReplyFinancingModeLabel: "Financing reply",
  SmartReplyFinancingModeCalculated: "Show an estimated monthly payment",
  SmartReplyFinancingModeGeneric: "Generic message only (no calculated number)",
  SmartReplyDownPaymentLabel: "Default down payment (%)",
  SmartReplyFinanceCompanyLabel: "Finance company used for the estimate",
  SmartReplyVisibilityLabel: "Reply visibility",
  SmartReplyVisibilityPublic: "Reply publicly under the comment",
  SmartReplyVisibilityDm: "Reply privately via DM",
  SmartReplySaved: "Smart Reply settings saved.",
};

export const socialSmartReplyAr = {
  SmartReplyPriceAvailable: "{model} ({year}) سعرها {price} {currency}. هل ترغب أن يتواصل معك أحد مندوبي المبيعات؟",
  SmartReplyFinancingCalculated: "التمويل متاح لسيارة {model} ({year}) — تبدأ الأقساط الشهرية التقديرية من {monthlyAmount} {currency}/شهرياً، حسب الموافقة.",
  SmartReplyFinancingGeneric: "التمويل متاح لسيارة {model} ({year}). راسلنا وسيقوم أحد مندوبي المبيعات بإرسال القسط الشهري المناسب لك.",
  SmartReplyAvailableYes: "نعم، سيارة {model} ({year}) متوفرة حالياً. هل ترغب أن يتواصل معك أحد مندوبي المبيعات؟",
  SmartReplyAvailableSold: "هذه السيارة لم تعد متوفرة — يمكنك الاطلاع على باقي السيارات أو مراسلتنا لخيارات مشابهة.",
  SmartReplyAvailableUnclear: "هذه السيارة غير متاحة للبيع حالياً. راسلنا وسنخبرك بخيارات مشابهة.",
  SmartReplyVehicleInfo: "{model} ({year}{trimSuffix}): الممشى {mileage} كم، اللون {color}، {fuelType}، {transmission}.",
  SmartReplyLocation: "يمكنك زيارتنا في {dealershipName}, {dealershipAddress}{phoneSuffix}.",
  SmartReplyLocationFallback: "راسلنا وسنرسل لك موقعنا.",
  SmartReplyGreeting: "أهلاً! 👋 اسألنا عن السعر أو التمويل أو التوفر لأي سيارة.",

  SmartReplyTitle: "الرد التلقائي الفوري",
  SmartReplyDescription: "الرد تلقائياً على أسئلة السعر والتمويل والتوفر في تعليقات ورسائل إنستغرام وفيسبوك.",
  SmartReplyEnableInstagram: "تفعيل لإنستغرام",
  SmartReplyEnableFacebook: "تفعيل لفيسبوك",
  SmartReplyFinancingModeLabel: "رد التمويل",
  SmartReplyFinancingModeCalculated: "إظهار قسط شهري تقديري",
  SmartReplyFinancingModeGeneric: "رسالة عامة فقط (بدون رقم محسوب)",
  SmartReplyDownPaymentLabel: "الدفعة الأولى الافتراضية (%)",
  SmartReplyFinanceCompanyLabel: "شركة التمويل المستخدمة للتقدير",
  SmartReplyVisibilityLabel: "ظهور الرد",
  SmartReplyVisibilityPublic: "الرد علناً تحت التعليق",
  SmartReplyVisibilityDm: "الرد بشكل خاص عبر رسالة مباشرة",
  SmartReplySaved: "تم حفظ إعدادات الرد التلقائي الفوري.",
};
