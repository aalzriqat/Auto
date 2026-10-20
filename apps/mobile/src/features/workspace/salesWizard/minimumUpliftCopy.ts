/**
 * SCRUM-260: the per-vehicle minimum measures the quoted price against the
 * LIST price, not against cost, so the mobile wizard must not call that spread
 * "profit". Mirrors the web wizard copy (lib/i18n/domains/sales.ts).
 */
export type UpliftLocale = "ar" | "en";

export function upliftFieldLabel(locale: UpliftLocale): string {
  return locale === "ar" ? "الإضافة على السعر الأساسي" : "Markup added to base price";
}

export function upliftBelowMinimumBody(locale: UpliftLocale, uplift: string, minimum: string): string {
  return locale === "ar"
    ? `سعر البيع النهائي مطروحاً منه سعر القائمة (${uplift}) أقل من الحد الأدنى للزيادة فوق سعر القائمة لهذه المركبة (${minimum}). هذا الفحص لا يمنع بيعاً بخسارة.`
    : `The final sale price minus the list price (${uplift}) is below this vehicle's Minimum Price Uplift (${minimum}). This check does not prevent a loss-making sale.`;
}

export function upliftRejectedText(locale: UpliftLocale): string {
  return locale === "ar"
    ? "رُفض هذا المبلغ — ارفع الزيادة فوق سعر القائمة أو اطلب مجدداً."
    : "This amount was rejected — raise the price uplift or request again.";
}

export function upliftRequestActionText(locale: UpliftLocale): string {
  return locale === "ar" ? "طلب اعتماد الزيادة فوق سعر القائمة" : "Request Price Uplift Approval";
}

export function upliftApprovedText(locale: UpliftLocale): string {
  return locale === "ar"
    ? "تم اعتماد الزيادة فوق سعر القائمة — يمكنك المتابعة."
    : "Price uplift approved by management — you may proceed.";
}
