import type { Doc } from "../../_generated/dataModel";
import { buildSmartReplyText } from "../../utils/smartReplyBuilder";
import type { DraftLocale, SentenceAnswer } from "./draftAnswers";
import type { SentenceTable } from "./draftValidators";

interface SentenceSources {
  vehicle: Doc<"vehicles"> | null;
  orgSettings: Doc<"orgSettings"> | null;
  financeCompany: Doc<"financeCompanies"> | null;
}

/**
 * The built-in Smart Reply sentence of every approved answer, in both
 * languages. Fields are copied one by one: the Owner's custom templates
 * (`smartReplyCustomTemplatesEn/Ar`) are never passed on, so only the
 * repository's built-in sentence templates are used. Their slots are filled
 * with values the dealership entered (vehicle model, trim, colour, fuel type,
 * transmission, mileage, year, listed price, dealership name, address, phone,
 * currency) and the estimate the existing rule computes; neither the model nor
 * the customer controls any of it. The vehicle and finance company
 * must already belong to the conversation's organization.
 */
export function buildSentenceTable({ vehicle, orgSettings, financeCompany }: SentenceSources): SentenceTable {
  const settings = orgSettings && {
    currencySymbol: orgSettings.currencySymbol,
    currency: orgSettings.currency,
    dealershipName: orgSettings.dealershipName,
    dealershipAddress: orgSettings.dealershipAddress,
    dealershipPhone: orgSettings.dealershipPhone,
    smartReplyFinancingMode: orgSettings.smartReplyFinancingMode,
    smartReplyDefaultDownPaymentPercent: orgSettings.smartReplyDefaultDownPaymentPercent,
  };
  const projectedVehicle = vehicle && {
    model: vehicle.model,
    year: vehicle.year,
    trim: vehicle.trim,
    sellingPrice: vehicle.sellingPrice,
    status: vehicle.status,
    mileage: vehicle.mileage,
    color: vehicle.color,
    fuelType: vehicle.fuelType,
    transmission: vehicle.transmission,
    isDeleted: vehicle.isDeleted,
  };
  const company = financeCompany && {
    isActive: financeCompany.isActive,
    profitRate: financeCompany.profitRate,
    maxTermMonths: financeCompany.maxTermMonths,
    gracePeriodMonths: financeCompany.gracePeriodMonths,
    adminFees: financeCompany.adminFees,
    commission: financeCompany.commission,
    insuranceRate: financeCompany.insuranceRate,
    includesCommissionInDebt: financeCompany.includesCommissionInDebt,
  };
  const sentenceOf = (intent: SentenceAnswer, locale: DraftLocale): string | null =>
    buildSmartReplyText({ intent, vehicle: projectedVehicle, orgSettings: settings, financeCompany: company, locale });
  const forLocale = (locale: DraftLocale): SentenceTable["en"] => ({
    greeting: sentenceOf("greeting", locale),
    availability: sentenceOf("availability", locale),
    vehicleInfo: sentenceOf("vehicleInfo", locale),
    price: sentenceOf("price", locale),
    financing: sentenceOf("financing", locale),
    location: sentenceOf("location", locale),
  });
  return { en: forLocale("en"), ar: forLocale("ar") };
}
