import { calculateUnifiedMurabaha } from "../../lib/financing";
import { socialSmartReplyEn, socialSmartReplyAr } from "../../lib/i18n/domains/socialSmartReply";
import type { SmartReplyIntent } from "./smartReplyIntent";
import type { Doc } from "../_generated/dataModel";

type TemplateMap = Record<string, string>;

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

function parseCustomTemplates(json: string | undefined): TemplateMap {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as TemplateMap) : {};
  } catch {
    return {};
  }
}

function tpl(
  custom: TemplateMap,
  key: string,
  fallback: string
): string {
  const override = custom[key];
  return override && override.trim() ? override.trim() : fallback;
}

/**
 * Builds the final reply text for a matched Smart Reply intent. Pure and
 * defensive -- never throws; falls back to generic copy (or null) on
 * incomplete data rather than failing the webhook handler it's called from.
 */
export function buildSmartReplyText({ intent, vehicle, orgSettings, financeCompany, locale }: BuildSmartReplyArgs): string | null {
  const strings = locale === "ar" ? socialSmartReplyAr : socialSmartReplyEn;
  const rawCustom = locale === "ar"
    ? orgSettings?.smartReplyCustomTemplatesAr
    : orgSettings?.smartReplyCustomTemplatesEn;
  const custom = parseCustomTemplates(rawCustom);
  const currency = orgSettings?.currencySymbol || orgSettings?.currency || "";

  if (intent === "location") {
    if (!orgSettings?.dealershipAddress) {
      return tpl(custom, "locationFallback", strings.SmartReplyLocationFallback);
    }
    const phoneSuffix = orgSettings.dealershipPhone ? ` (${orgSettings.dealershipPhone})` : "";
    return fill(tpl(custom, "location", strings.SmartReplyLocation), {
      dealershipName: orgSettings.dealershipName || "",
      dealershipAddress: orgSettings.dealershipAddress,
      phoneSuffix,
    });
  }

  if (intent === "greeting") {
    return tpl(custom, "greeting", strings.SmartReplyGreeting);
  }

  // Every remaining intent (price/financing/availability/vehicleInfo) needs a
  // resolved, non-deleted vehicle to answer about.
  if (!vehicle || vehicle.isDeleted) return null;

  if (intent === "availability") {
    if (vehicle.status === "AVAILABLE") {
      return fill(tpl(custom, "availableYes", strings.SmartReplyAvailableYes), { model: vehicle.model, year: vehicle.year });
    }
    if (vehicle.status === "SOLD" || vehicle.status === "ARCHIVED") {
      return tpl(custom, "availableSold", strings.SmartReplyAvailableSold);
    }
    return tpl(custom, "availableUnclear", strings.SmartReplyAvailableUnclear);
  }

  if (intent === "price") {
    if (vehicle.status !== "AVAILABLE") return tpl(custom, "availableUnclear", strings.SmartReplyAvailableUnclear);
    return fill(tpl(custom, "priceAvailable", strings.SmartReplyPriceAvailable), {
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
      return fill(tpl(custom, "financingGeneric", strings.SmartReplyFinancingGeneric), { model: vehicle.model, year: vehicle.year });
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
      return fill(tpl(custom, "financingGeneric", strings.SmartReplyFinancingGeneric), { model: vehicle.model, year: vehicle.year });
    }

    return fill(tpl(custom, "financingCalculated", strings.SmartReplyFinancingCalculated), {
      model: vehicle.model,
      year: vehicle.year,
      monthlyAmount: Math.round(monthlyInstallment),
      currency,
    });
  }

  if (intent === "vehicleInfo") {
    return fill(tpl(custom, "vehicleInfo", strings.SmartReplyVehicleInfo), {
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
