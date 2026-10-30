/**
 * SCRUM-858 (owner ruling c23884): how the customer record presents `customers.getRelations`' deposits.
 *
 * Pure and dependency-free so every rule is directly unit-testable. The server owns what a role may see
 * (VIEW_SALES), the 100-row bound and the deleted-row filter; this module only decides how a returned row
 * reads: its classification, its status, its amount and which row is first.
 *
 * Money display follows the sales wizard policy (SCRUM-684, lib/moneyDisplay.ts): Western digits in both
 * languages (numbering system set explicitly so an Arabic locale cannot switch to Arabic-Indic digits),
 * and the currency's FULL minor-unit scale so JOD fils are never rounded away. Unlike the wizard, a whole
 * amount keeps its zero decimals here ("100.000"), because the owner asked for three decimals on this
 * screen and an accountant reads a column of amounts more safely when every row has the same shape.
 */
import { moneyDisplayScale } from "@/lib/moneyDisplay";

export type CustomerDepositStatus = "HELD" | "APPLIED" | "REFUNDED" | "FORFEITED" | "VOIDED";

export interface CustomerDepositRow {
  _id: string;
  status: CustomerDepositStatus;
  amountMinor?: number;
  /** Major units. Only used when a legacy row has no minor-unit figure. */
  amount: number;
  currency?: string;
  vehicleId?: string;
  vehicleDesc?: string;
  origin?: "OPENING";
  openingDepositKind?: "SECURITY" | "RESERVATION";
  createdAt: number;
}

/** Newest first. The server already returns the index order; this keeps the screen right if that ever changes. */
export function sortDepositsNewestFirst<T extends Pick<CustomerDepositRow, "createdAt">>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort((first, second) => second.createdAt - first.createdAt);
}

/**
 * The deposit's classification. An opening deposit is named SECURITY or RESERVATION. An ordinary deposit
 * (taken against a quote or a reservation) carries no such name and is shown as a plain deposit, never
 * guessed into one of the two.
 */
export function depositClassificationKey(
  row: Pick<CustomerDepositRow, "openingDepositKind">
): "OpeningDepositType_SECURITY" | "OpeningDepositType_RESERVATION" | "CustomerDepositKindOrdinary" {
  if (row.openingDepositKind === "SECURITY") return "OpeningDepositType_SECURITY";
  if (row.openingDepositKind === "RESERVATION") return "OpeningDepositType_RESERVATION";
  return "CustomerDepositKindOrdinary";
}

export function depositStatusKey(
  status: CustomerDepositStatus
): "DepositStatusHeld" | "DepositStatusApplied" | "DepositStatusRefunded" | "DepositStatusForfeited" | "CustomerDepositStatusVoided" {
  switch (status) {
    case "HELD":
      return "DepositStatusHeld";
    case "APPLIED":
      return "DepositStatusApplied";
    case "REFUNDED":
      return "DepositStatusRefunded";
    case "FORFEITED":
      return "DepositStatusForfeited";
    default:
      return "CustomerDepositStatusVoided";
  }
}

/**
 * The amount at the currency's full scale, Western digits ("100.000", "1,234.500"). The currency is the
 * row's own, else the organization's; `null` when neither is known, so the caller shows the figure
 * without inventing a currency.
 */
export function formatDepositAmount(
  row: Pick<CustomerDepositRow, "amountMinor" | "amount" | "currency">,
  organizationCurrency: string | undefined
): { amount: string; currency: string | null } {
  const currency = (row.currency ?? organizationCurrency)?.trim().toUpperCase() || null;
  const scale = currency ? moneyDisplayScale(currency) : 3;
  const major = row.amountMinor === undefined ? row.amount : row.amountMinor / 10 ** scale;
  if (!Number.isFinite(major)) return { amount: "—", currency };
  const amount = new Intl.NumberFormat("en-US", {
    numberingSystem: "latn",
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(major);
  return { amount, currency };
}
