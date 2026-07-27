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
import { messagesEn, messagesAr } from "./domains/messages";
import { marketplaceEn, marketplaceAr } from "./domains/marketplace";
import { payrollEn, payrollAr } from "./domains/payroll";

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
  ...messagesEn,
  ...marketplaceEn,
  ...payrollEn,
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
  ...messagesAr,
  ...marketplaceAr,
  ...payrollAr,
} as unknown as typeof en;

export const dictionaries = {
  en,
  ar,
};

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}

/**
 * Every key the dictionaries actually define.
 *
 * Components that take a `t` prop should type it as `Translate` rather than
 * `(key: string) => string`. The loose form silently accepts a key that does
 * not exist, and `t` returns the key itself when it can't resolve one — so a
 * typo ships as raw text on screen (that is how "ExportPDF" ended up rendering
 * as a button label and "MessagesExpand" as an aria-label).
 */
export type TranslationKey = keyof typeof en;
export type Translate = (key: TranslationKey) => string;
// force reload 
