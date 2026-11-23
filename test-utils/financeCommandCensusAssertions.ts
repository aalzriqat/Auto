import { expect } from "vitest";
import type { Graph } from "../scripts/economicCommandCensus";

export function expectFinanceAccountingEdges(graph: Graph): void {
  const costs = "utils/financeDealCosts/";
  const chartRead = "accounting/chartAccountsRead.";
  const chartProvision = "accounting/chartAccountsProvision.";
  const expected = [
    ["dealCostAccounting.assertCustodyAccountingReady", chartRead + "dealCustodyAccountingReadiness"],
    ["dealCostOverview.listDealCostsHandler", chartRead + "dealCustodyAccountingReadiness"],
    ["directFeePayment.assertDirectPaymentAccountingReady", chartRead + "isChartInitialized"],
    ["directFeePayment.assertDirectPaymentAccountingReady", chartRead + "isSystemAccountMapped"],
    ["directFeePayment.assertDirectPaymentAccountingReady", chartProvision + "ensureFinancedSettlementAccounts"],
    ["feeRecords.recomputeAfterSettlementInputChange", "financingEconomics.recomputeEconomicsForApplication"],
  ] as const;
  for (const [source, target] of expected) {
    expect(graph.edges.get(costs + source)?.has(target), source + " should reach " + target).toBe(true);
    expect(graph.rEdges.get(target)?.has(costs + source), target + " should retain " + source).toBe(true);
  }
}
