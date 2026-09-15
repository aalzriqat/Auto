import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Briefcase,
  CalendarCheck2,
  Gauge,
  HandCoins,
  Landmark,
  ScrollText,
  Settings,
} from "lucide-react";

/**
 * The eight-group information architecture of the Accounting workspace.
 *
 * Presentation only: each section hosts the existing tab components unchanged.
 * `id` doubles as the `?section=` query value, so it is part of the deep-link
 * contract once shipped — rename with care.
 */
export type AccountingSectionId =
  | "overview"
  | "receivables"
  | "cash"
  | "journal"
  | "reconcile"
  | "statements"
  | "assets"
  | "settings";

export type AccountingSection = {
  id: AccountingSectionId;
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  admin?: boolean;
};

export const ACCOUNTING_SECTIONS: readonly AccountingSection[] = [
  { id: "overview", labelKey: "AccountingOverview", descriptionKey: "AccountingOverviewDesc", icon: Gauge },
  {
    id: "receivables",
    labelKey: "AccountingReceivablesPayables",
    descriptionKey: "AccountingReceivablesPayablesDesc",
    icon: HandCoins,
  },
  { id: "cash", labelKey: "AccountingCashBank", descriptionKey: "AccountingCashBankDesc", icon: Landmark },
  { id: "journal", labelKey: "AccountingJournal", descriptionKey: "AccountingJournalDesc", icon: ScrollText },
  {
    id: "reconcile",
    labelKey: "AccountingReconcileClose",
    descriptionKey: "AccountingReconcileCloseDesc",
    icon: CalendarCheck2,
  },
  { id: "statements", labelKey: "AccountingStatements", descriptionKey: "AccountingStatementsDesc", icon: BarChart3 },
  {
    id: "assets",
    labelKey: "AccountingAssetsAdjustments",
    descriptionKey: "AccountingAssetsAdjustmentsDesc",
    icon: Briefcase,
    admin: true,
  },
  { id: "settings", labelKey: "AccountingSettings", descriptionKey: "AccountingSettingsDesc", icon: Settings, admin: true },
];

export const DEFAULT_ACCOUNTING_SECTION: AccountingSectionId = "overview";

export function isAccountingSectionId(value: string | null | undefined): value is AccountingSectionId {
  return ACCOUNTING_SECTIONS.some((section) => section.id === value);
}
