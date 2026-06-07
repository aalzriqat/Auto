import { commonEn, commonAr } from "./domains/common";
import { dashboardEn, dashboardAr } from "./domains/dashboard";
import { vehiclesEn, vehiclesAr } from "./domains/vehicles";
import { customersEn, customersAr } from "./domains/customers";
import { leadsEn, leadsAr } from "./domains/leads";
import { salesEn, salesAr } from "./domains/sales";
import { settingsEn, settingsAr } from "./domains/settings";

export type Locale = "en" | "ar";

const en = {
  ...commonEn,
  ...dashboardEn,
  ...vehiclesEn,
  ...customersEn,
  ...leadsEn,
  ...salesEn,
  ...settingsEn,
};

const ar: typeof en = {
  ...commonAr,
  ...dashboardAr,
  ...vehiclesAr,
  ...customersAr,
  ...leadsAr,
  ...salesAr,
  ...settingsAr,
};

export const dictionaries = {
  en,
  ar,
};

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}
