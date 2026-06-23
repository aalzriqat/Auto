import { calculateUnifiedMurabaha } from "../../lib/financing";
import { socialSmartReplyEn, socialSmartReplyAr } from "../../lib/i18n/domains/socialSmartReply";
import type { SmartReplyIntent } from "./smartReplyIntent";
import type { Doc } from "../_generated/dataModel";

interface BuildSmartReplyArgs {
  intent: Exclude<SmartReplyIntent, "complaint">;
  vehicle: Doc<"vehicles"> | null;
  orgSettings: Doc<"orgSettings"> | null;
  financeCompany: Doc<"financeCompanies"> | null;
  locale: "en" | "ar";
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`\\{${key}\\}`, "g"), String(value)),
    template
  );
}

/**
 * Builds the final reply text for a matched Smart Reply intent. Pure and
 * defensive -- never throws; falls back to generic copy (or null) on
 * incomplete data rather than failing the webhook handler it's called from.
 */
export function buildSmartReplyText({ intent, vehicle, orgSettings, financeCompany, locale }: BuildSmartReplyArgs): string | null {
  const strings = locale === "ar" ? socialSmartReplyAr : socialSmartReplyEn;
  const currency = orgSettings?.currencySymbol || orgSettings?.currency || "";

  if (intent === "location") {
    if (!orgSettings?.dealershipAddress) return strings.SmartReplyLocationFallback;
    const phoneSuffix = orgSettings.dealershipPhone ? ` (${orgSettings.dealershipPhone})` : "";
    return fill(strings.SmartReplyLocation, {
      dealershipName: orgSettings.dealershipName || "",
      dealershipAddress: orgSettings.dealershipAddress,
      phoneSuffix,
    });
  }

  if (intent === "greeting") {
    return strings.SmartReplyGreeting;
  }

  // Every remaining intent (price/financing/availability/vehicleInfo) needs a
  // resolved, non-deleted vehicle to answer about.
  if (!vehicle || vehicle.isDeleted) return null;

  if (intent === "availability") {
    if (vehicle.status === "AVAILABLE") {
      return fill(strings.SmartReplyAvailableYes, { model: vehicle.model, year: vehicle.year });
    }
    if (vehicle.status === "SOLD" || vehicle.status === "ARCHIVED") {
      return strings.SmartReplyAvailableSold;
    }
    return strings.SmartReplyAvailableUnclear;
  }

  if (intent === "price") {
    if (vehicle.status !== "AVAILABLE") return strings.SmartReplyAvailableUnclear;
    return fill(strings.SmartReplyPriceAvailable, {
      model: vehicle.model,
      year: vehicle.year,
      price: vehicle.sellingPrice,
      currency,
    });
  }

  if (intent === "financing") {
    const canCalculate =
      orgSettings?.smartReplyFinancingMode === "calculated" &&
      financeCompany &&
      financeCompany.isActive &&
      vehicle.status === "AVAILABLE";

    if (!canCalculate) {
      return fill(strings.SmartReplyFinancingGeneric, { model: vehicle.model, year: vehicle.year });
    }

    const downPaymentPercent = orgSettings?.smartReplyDefaultDownPaymentPercent ?? 20;
    const downPayment = vehicle.sellingPrice * (downPaymentPercent / 100);
    const { monthlyInstallment } = calculateUnifiedMurabaha({
      vehiclePrice: vehicle.sellingPrice,
      downPayment,
      commission: financeCompany.commission ?? 0,
      processingFees: financeCompany.adminFees ?? 0,
      annualProfitRate: financeCompany.profitRate,
      annualInsuranceRate: financeCompany.insuranceRate ?? 0,
      termMonths: financeCompany.maxTermMonths,
      gracePeriodMonths: financeCompany.gracePeriodMonths,
      includesCommissionInDebt: financeCompany.includesCommissionInDebt,
    });

    if (!monthlyInstallment) {
      return fill(strings.SmartReplyFinancingGeneric, { model: vehicle.model, year: vehicle.year });
    }

    return fill(strings.SmartReplyFinancingCalculated, {
      model: vehicle.model,
      year: vehicle.year,
      monthlyAmount: Math.round(monthlyInstallment),
      currency,
    });
  }

  if (intent === "vehicleInfo") {
    return fill(strings.SmartReplyVehicleInfo, {
      model: vehicle.model,
      year: vehicle.year,
      trimSuffix: vehicle.trim ? ` ${vehicle.trim}` : "",
      mileage: vehicle.mileage,
      color: vehicle.color,
      fuelType: vehicle.fuelType,
      transmission: vehicle.transmission,
    });
  }

  return null;
}
