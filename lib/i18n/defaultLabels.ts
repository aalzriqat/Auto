import { Locale } from "./dictionaries";

// Translations for the English default values seeded by convex/orgLeadSources.ts,
// convex/orgPipelineStages.ts, and convex/orgCustomerStatuses.ts. Custom labels typed
// in by a dealer (anything not in these maps) pass through untranslated.

const LEAD_SOURCE_LABELS: Record<string, { en: string; ar: string }> = {
  "Walk-in": { en: "Walk-in", ar: "زيارة مباشرة" },
  Website: { en: "Website", ar: "الموقع الإلكتروني" },
  Facebook: { en: "Facebook", ar: "فيسبوك" },
  Instagram: { en: "Instagram", ar: "إنستغرام" },
  Referral: { en: "Referral", ar: "إحالة" },
  Phone: { en: "Phone", ar: "الهاتف" },
  Haraj: { en: "Haraj", ar: "حراج" },
  Other: { en: "Other", ar: "أخرى" },
};

const PIPELINE_STAGE_LABELS: Record<string, { en: string; ar: string }> = {
  New: { en: "New", ar: "جديد" },
  Contacted: { en: "Contacted", ar: "تم التواصل" },
  Interested: { en: "Interested", ar: "مهتم" },
  "Test Drive": { en: "Test Drive", ar: "تجربة قيادة" },
  Negotiation: { en: "Negotiation", ar: "تفاوض" },
  Reserved: { en: "Reserved", ar: "محجوز" },
  Won: { en: "Won", ar: "تم البيع" },
  Lost: { en: "Lost", ar: "خسارة" },
};

const CUSTOMER_STATUS_LABELS: Record<string, { en: string; ar: string }> = {
  "Social Security": { en: "Social Security", ar: "الضمان الاجتماعي" },
  "Salary Slip": { en: "Salary Slip", ar: "كشف راتب" },
  "ID Only": { en: "ID Only", ar: "الهوية فقط" },
  "Commercial Register": { en: "Commercial Register", ar: "سجل تجاري" },
  "Delivery Apps": { en: "Delivery Apps", ar: "تطبيقات التوصيل" },
};

function translate(
  label: string,
  locale: Locale,
  map: Record<string, { en: string; ar: string }>
): string {
  return map[label]?.[locale] ?? label;
}

export const translateLeadSourceLabel = (label: string, locale: Locale) =>
  translate(label, locale, LEAD_SOURCE_LABELS);

export const translatePipelineStageLabel = (label: string, locale: Locale) =>
  translate(label, locale, PIPELINE_STAGE_LABELS);

export const translateCustomerStatusLabel = (label: string, locale: Locale) =>
  translate(label, locale, CUSTOMER_STATUS_LABELS);
