import { commonEn, commonAr } from "./domains/common";
import { dashboardEn, dashboardAr } from "./domains/dashboard";
import { vehiclesEn, vehiclesAr } from "./domains/vehicles";
import { customersEn, customersAr } from "./domains/customers";
import { leadsEn, leadsAr } from "./domains/leads";
import { salesEn, salesAr } from "./domains/sales";
import { settingsEn, settingsAr } from "./domains/settings";
import { expensesEn, expensesAr } from "./domains/expenses";
import { reportsEn, reportsAr } from "./domains/reports";
import { chatEn, chatAr } from "./domains/chat";
import { socialInboxEn, socialInboxAr } from "./domains/socialInbox";
import { socialSmartReplyEn, socialSmartReplyAr } from "./domains/socialSmartReply";
import { notificationsEn, notificationsAr } from "./domains/notifications";

export type Locale = "en" | "ar";

const en = {
  ...commonEn,
  ...dashboardEn,
  ...vehiclesEn,
  ...customersEn,
  ...leadsEn,
  ...salesEn,
  ...settingsEn,
  ...expensesEn,
  ...reportsEn,
  ...chatEn,
  ...socialInboxEn,
  ...socialSmartReplyEn,
  ...notificationsEn,
};

const ar = {
  ...commonAr,
  ...dashboardAr,
  ...vehiclesAr,
  ...customersAr,
  ...leadsAr,
  ...salesAr,
  ...settingsAr,
  ...expensesAr,
  ...reportsAr,
  ...chatAr,
  ...socialInboxAr,
  ...socialSmartReplyAr,
  ...notificationsAr,
} as unknown as typeof en;

export const dictionaries = {
  en,
  ar,
};

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}
// force reload 
