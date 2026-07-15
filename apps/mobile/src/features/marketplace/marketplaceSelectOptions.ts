import type { Locale } from "@autoflow/shared";

import { getJordanCityOptions, getVehicleMakeOptions } from "../../data/mobileOptions";

export function getMarketplaceSelectOptions(locale: Locale) {
  return {
    cityOptions: getJordanCityOptions(locale),
    makeOptions: getVehicleMakeOptions(),
    closeLabel: locale === "ar" ? "إغلاق" : "Close",
    customValueLabel: locale === "ar" ? 'استخدام "{value}"' : 'Use "{value}"',
    emptyLabel: locale === "ar" ? "لا توجد نتائج." : "No results found.",
    cityPlaceholder: locale === "ar" ? "اختر المدينة" : "Choose city",
    cityAnyPlaceholder: locale === "ar" ? "كل المدن" : "Any city",
    citySearchPlaceholder: locale === "ar" ? "بحث المدن" : "Search cities",
    makePlaceholder: locale === "ar" ? "اختر الماركة" : "Choose make",
    makeAnyPlaceholder: locale === "ar" ? "كل الماركات" : "Any make",
    makeSearchPlaceholder: locale === "ar" ? "بحث الماركات" : "Search makes",
  };
}
