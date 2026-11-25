import type { DealProfit, ManagementProfitClassification } from "./financingEconomics";
import { fromMinorUnits } from "./money";

/** One signed term of a report row's working, in the row's own currency (major units). */
export type ReportProfitLine = { key: string; sign: 1 | -1; amount: number };

/**
 * The working behind a row's profit before commissions: the deal page's own signed lines, served as they are so the
 * screen adds nothing up itself. Empty when the profit is unavailable (a dash on screen, never a zero). Commissions
 * are never part of this working; they are the row's separate commission column.
 */
export function reportRowWorking(profit: DealProfit, currency: string): {
  profitLines: ReportProfitLine[];
  profitClassification: ManagementProfitClassification | null;
} {
  if (!profit.available || !("lines" in profit)) return { profitLines: [], profitClassification: null };
  return {
    profitLines: profit.lines.map((line) => ({ key: line.key, sign: line.sign, amount: fromMinorUnits(line.amountMinor, currency) })),
    profitClassification: "classification" in profit ? profit.classification : null,
  };
}
