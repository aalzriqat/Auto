import type { Doc } from "../_generated/dataModel";
import { mayReadFinanceEconomics } from "./financeApplicationProjection";
import type { ManagementProfitClassification } from "./financingEconomics";
import { fromMinorUnits } from "./money";
import type { ReportDealFigures } from "./reportDealFigures";

/** One signed term of a report row's working, in the row's own currency (major units). */
export type ReportProfitLine = { key: string; sign: 1 | -1; amount: number };

/**
 * The working behind a row's profit before commissions: the deal page's own signed lines, served as they are so the
 * screen adds nothing up itself. Empty when the profit is unavailable (a dash on screen, never a zero). Commissions
 * are never part of this working; they are the row's separate commission column.
 *
 * The lines carry finance-only amounts (dealer contribution, approval excess, planned customer payment, closing fee),
 * so the deal page money panel's predicate (`mayReadFinanceEconomics`) decides whether the `profitLines` key exists at
 * all: for any other caller it is absent, never an empty array. The classification reveals no amount and is always
 * served.
 */
export function reportRowWorking(
  figure: Pick<ReportDealFigures, "profitBeforeCommissions" | "currency">,
  role: Doc<"roles">,
): { profitLines?: ReportProfitLine[]; profitClassification: ManagementProfitClassification | null } {
  const { profitBeforeCommissions: profit, currency } = figure;
  const classification = profit.available && "classification" in profit ? profit.classification : null;
  if (!mayReadFinanceEconomics(role)) return { profitClassification: classification };
  if (!profit.available || !("lines" in profit)) return { profitLines: [], profitClassification: null };
  return {
    profitLines: profit.lines.map((line) => ({ key: line.key, sign: line.sign, amount: fromMinorUnits(line.amountMinor, currency) })),
    profitClassification: classification,
  };
}
