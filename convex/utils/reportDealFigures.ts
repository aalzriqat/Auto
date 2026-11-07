import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { saleCompletedKey } from "../accounting/postingRules";
import { deriveFinancedOverviewFigures } from "./dealOverviewFigures";
import { composeCustomerGapToDealer, settlementIsComplete, type DealProfit } from "./financingEconomics";
import { financedSaleRecognitionApplies } from "./financedSaleRecognition";
import { applicationProvesFinancing } from "./financingProvenance";
import { saleEconomics, recordedConsignedMargin, recordedFinancedNetRevenue, recordedSupplierEntitlement,
  recordedSupplierGrossReceipt, recordedFinancedConsideration } from "./vehicleOwnership";
import { vehicleCapitalizedCostFromExpenses } from "./vehicleCost";
import { deriveVehicleCostBasis, deriveDealerPreparationExpenses, MAX_COST_BASIS_EXPENSES } from "./vehicleCostBasis";
import { profitCommissionsFromRows, normalizeProfitExpenses } from "./dealProfitReads";
import { deriveDealManagementCosts } from "./dealManagementNet";
import { cashAccountingProfit } from "./cashDealFigures";
import { cockpitFeeSummary, cockpitManagementProfit, resolveDealRoute, resolveFinancierLeg, resolveFinancierObligation, resolveSupplierSettlementMinor,
  saleMarginEvidence, saleSupplierEvidence, supplierObligationFromRows } from "./dealSettlementFigures";
import { customerInvoicePositionFromRows } from "./customerInvoiceObligation";
import { fromMinorUnits, toMinorSameCurrencyOrUndefined } from "./money";
import { MAX_LIVE_DEAL_FEE_LINES } from "./dealCostLimits";
import type { MarginEvidence } from "./dealSettlementFigures";

export const MAX_REPORT_SALES = 800;
const MAX_BATCH_CHILD_ROWS = 10000;

function refuseBatch(): never {
  throw new ConvexError("This report exceeds the safe read limit for related deal history. No partial report is available. Ask accounting to review the report scope and retained deal history.");
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return groups;
}

export type ReportDealFigures = {
  sale: Doc<"sales">;
  vehicle: Doc<"vehicles"> | null;
  economics: ReturnType<typeof saleEconomics>;
  vehicleCost: number;
  profit: DealProfit;
  profitBeforeCommissions: DealProfit;
  salePrice: number | null;
  salePriceUnavailableReason: "UNSAFE_AMOUNT" | "NOT_RECORDED" | "DEAL_UNAVAILABLE" | null;
  currency: string;
  commissionsTotal: number | null;
  commissionPending: boolean;
};

/** A card's operands cover the same complete row and denomination. */
export function reportContributionFor(figure: ReportDealFigures, orgCurrency: string):
  { available: true; revenueMinor: number; costMinor: number; netMinor: number } | { available: false } {
  const { economics, profitBeforeCommissions: profit } = figure;
  const revenueMinor = economics.recognizedRevenue === null ? undefined :
    toMinorSameCurrencyOrUndefined(economics.recognizedRevenue, orgCurrency, orgCurrency);
  if (!profit.available || figure.currency !== orgCurrency || revenueMinor === undefined) return { available: false };
  const costMinor = revenueMinor - profit.amountMinor;
  if (!Number.isSafeInteger(costMinor)) return { available: false };
  return { available: true, revenueMinor, costMinor, netMinor: profit.amountMinor };
}

type ReportBase = Omit<ReportDealFigures, "profit" | "profitBeforeCommissions" | "salePrice" | "salePriceUnavailableReason">;
type FinancedFigures = ReturnType<typeof deriveFinancedOverviewFigures>;

function sameProfit(left: DealProfit, right: DealProfit): boolean {
  if (left.available && right.available) return left.amountMinor === right.amountMinor;
  return !left.available && !right.available && left.reason === right.reason;
}

function overviewReportResult(base: ReportBase, figures: FinancedFigures): ReportDealFigures {
  const { summary, profitBeforeCommissions } = figures;
  if (summary.customerSalePrice) return { ...base, profit: summary.profit, profitBeforeCommissions,
    salePrice: fromMinorUnits(summary.customerSalePrice.amountMinor, base.currency), salePriceUnavailableReason: null };
  const unsafePrice = summary.unreadable.some((field) => field.field === "customerSalePrice");
  return { ...base, profit: summary.profit, profitBeforeCommissions, salePrice: null,
    salePriceUnavailableReason: unsafePrice ? "UNSAFE_AMOUNT" : "NOT_RECORDED" };
}

function cashReportResult(base: ReportBase, basis: ReturnType<typeof deriveVehicleCostBasis> | null,
  preparation: ReturnType<typeof deriveDealerPreparationExpenses> | null,
  commission: ReturnType<typeof profitCommissionsFromRows>): ReportDealFigures {
  const { sale, vehicle, economics, currency } = base;
  const showroomExpenses = vehicle?.sourceType !== "SOURCED" && basis && !basis.available
    ? { available: false as const, reason: "VehicleCostBasisUnreadable" as const } : preparation ?? { available: false as const };
  const management = deriveDealManagementCosts({ profit: cashAccountingProfit({ sale, economics, currency }), showroomExpenses, commissions: commission });
  const salePriceMinor = toMinorSameCurrencyOrUndefined(sale.salePrice, currency, currency);
  return { ...base, ...management, salePrice: salePriceMinor === undefined ? null : fromMinorUnits(salePriceMinor, currency),
    salePriceUnavailableReason: salePriceMinor === undefined ? "UNSAFE_AMOUNT" : null };
}
type PendingFinance = {
    app: Doc<"financeApplications">;
    route: ReturnType<typeof resolveDealRoute>;
    derive: (moneySettled: boolean) => FinancedFigures;
    resultFor: (figures: FinancedFigures) => ReportDealFigures;
    margin: MarginEvidence;
    supplierClaim: Doc<"vehicleSupplierReceivables"> | undefined;
    payableRows: Doc<"vehicleSupplierPayables">[];
};
type PreparedReportRow =
  | { kind: "READY"; base: ReportBase; result: ReportDealFigures; pending?: never }
  | { kind: "PENDING"; base: ReportBase; pending: PendingFinance; result?: never };

type ReportInputs = {
  orgId: Id<"organizations">;
  sales: Doc<"sales">[];
  orgCurrency: string;
};

export async function loadReportDealFigures(ctx: QueryCtx, args: ReportInputs): Promise<ReportDealFigures[]> {
  try {
    return await readReportDealFigures(ctx, args);
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    console.error("Report deal figure read failed", error);
    throw new ConvexError("The report could not be loaded. Please try again later.");
  }
}

/**
 * One snapshot, no query invocation per sale. Distinct referenced documents
 * are fetched once; each child collection is read once and grouped by its
 * actual parent. The shared budget refuses a prefix, including one caused by
 * unrelated retained history. It never manufactures unavailable row figures.
 */
async function readReportDealFigures(ctx: QueryCtx, args: ReportInputs): Promise<ReportDealFigures[]> {
  const { orgId, sales, orgCurrency } = args;
  if (sales.length > MAX_REPORT_SALES) refuseBatch();
  if (sales.length === 0) return [];
  const vehicleIds = [...new Set(sales.map((sale) => sale.vehicleId))];
  const appIds = [...new Set(sales.flatMap((sale) => sale.applicationId ? [sale.applicationId] : []))];
  const [vehicles, applications] = await Promise.all([
    Promise.all(vehicleIds.map((id) => ctx.db.get(id))),
    Promise.all(appIds.map((id) => ctx.db.get(id))),
  ]);
  const vehicleMap = new Map(vehicles.flatMap((v) => v?.orgId === orgId ? [[v._id, v] as const] : []));
  const appMap = new Map(applications.flatMap((app) => app?.orgId === orgId ? [[app._id, app] as const] : []));
  let remaining = MAX_BATCH_CHILD_ROWS;
  const accept = <T>(rows: T[]): T[] => {
    if (rows.length > remaining) refuseBatch();
    remaining -= rows.length;
    return rows;
  };
  const expenses = accept(await ctx.db.query("expenses").withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId)).take(remaining + 1));
  const workOrders = expenses.some((e) => e.accountingTreatment === undefined && e.status === "PAID" && !e.isDeleted && e.reversedAt === undefined)
    ? accept(await ctx.db.query("workOrders").withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId)).take(remaining + 1)) : [];
  // SCRUM-928 "Keep today's view": report profit is authorized by report and
  // cost access. Read its full operands, then project commission fields at the
  // query boundary using the report's separate view:commissions permission.
  const commissions = accept(await ctx.db.query("dealCommissionLines").withIndex("by_org_sale", (q) => q.eq("orgId", orgId)).take(remaining + 1));
  // The deal page's authority is application-keyed, including a malformed
  // tenant stamp on a linked fee. Preserve that input set without publishing
  // any intervening application's rows. A bounded envelope may over-refuse.
  const sortedAppIds = [...appIds].sort();
  const fees = sortedAppIds.length ? accept(await ctx.db.query("financeDealFees").withIndex("by_application", (q) =>
    q.gte("applicationId", sortedAppIds[0]).lte("applicationId", sortedAppIds[sortedAppIds.length - 1])).take(remaining + 1)) : [];
  const claims = appIds.length ? accept(await ctx.db.query("vehicleSupplierReceivables").withIndex("by_org_sale", (q) => q.eq("orgId", orgId)).take(remaining + 1)) : [];
  const payables = appIds.length ? accept(await ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(remaining + 1)) : [];
  const expensesByVehicle = groupBy(expenses, (e) => e.vehicleId);
  const ordersByVehicle = groupBy(workOrders, (e) => e.vehicleId);
  const commissionsBySale = groupBy(commissions, (e) => e.saleId);
  const feesByApp = groupBy(fees.filter((f) => f.voidedAt === undefined), (f) => f.applicationId);
  const claimsBySale = groupBy(claims, (c) => c.saleId);
  const payablesBySale = groupBy(payables, (p) => "saleId" in p ? p.saleId : undefined);

  const prepared = sales.map<PreparedReportRow>((sale) => {
    const vehicle = vehicleMap.get(sale.vehicleId) ?? null;
    const rawExpenses = expensesByVehicle.get(sale.vehicleId) ?? [];
    const expenseRows = normalizeProfitExpenses(rawExpenses.slice(0, MAX_COST_BASIS_EXPENSES + 1),
      (ordersByVehicle.get(sale.vehicleId) ?? []).slice(0, MAX_COST_BASIS_EXPENSES + 1));
    const app = sale.applicationId ? appMap.get(sale.applicationId) ?? null : null;
    const proven = applicationProvesFinancing(app, sale);
    const currency = app ? app.economicsCurrency ?? orgCurrency : sale.consignedMarginCurrency ?? orgCurrency;
    const vehicleCost = vehicle ? vehicleCapitalizedCostFromExpenses(vehicle, rawExpenses) : 0;
    const economics = saleEconomics({
      salePrice: sale.salePrice, vehicle, capitalizedCost: vehicleCost,
      supplierSettlementRoute: sale.supplierSettlementRoute, recordedMargin: recordedConsignedMargin(sale),
      recordedNetRevenue: recordedFinancedNetRevenue(sale, orgCurrency),
      recordedSupplierEntitlement: recordedSupplierEntitlement(sale), recordedSupplierGrossReceipt: recordedSupplierGrossReceipt(sale),
      recordedConsideration: recordedFinancedConsideration(sale), hasFinancingApplication: proven,
      externallyFinanced: sale.financingType === "FINANCED" || sale.financingType === "LEASE",
    });
    const commission = profitCommissionsFromRows({ sale, rows: commissionsBySale.get(sale._id) ?? [], currency,
      mayReadCommissions: true });
    const basis = vehicle ? deriveVehicleCostBasis({ vehicle, expenses: expenseRows, cutoffCreationTime: null, dealCurrency: currency, orgCurrency }) : null;
    const preparation = vehicle && !vehicle.isDeleted ? deriveDealerPreparationExpenses({
      expenses: expenseRows, cutoffCreationTime: null, dealCurrency: currency, orgCurrency,
      consigned: economics.isAgentSale,
    }) : null;
    const base = { sale, vehicle, economics, vehicleCost, currency,
      commissionsTotal: commission.available ? fromMinorUnits(commission.totalMinor, currency) : null,
      commissionPending: !commission.available && commission.reason === "CommissionsPending" };
    if (!sale.applicationId) {
      return { kind: "READY", base, result: cashReportResult(base, basis, preparation, commission) };
    }
    if (!app || !proven) {
      return { kind: "READY", base, result: { ...base, profit: { available: false, reason: "UnknownMargin" },
        profitBeforeCommissions: { available: false, reason: "UnknownMargin" }, salePrice: null, salePriceUnavailableReason: "DEAL_UNAVAILABLE" } };
    }
    const liveFees = feesByApp.get(app._id) ?? [];
    if (liveFees.length > MAX_LIVE_DEAL_FEE_LINES) refuseBatch();
    const feeSummary = cockpitFeeSummary(app, liveFees, currency);
    const supplierClaim = (claimsBySale.get(sale._id) ?? []).find((c) => c.status !== "CANCELLED");
    const payableRows = payablesBySale.get(sale._id) ?? [];
    const margin = saleMarginEvidence(sale, app, { consigned: economics.isAgentSale, currency, supplierClaim });
    const supplierEntitlement = saleSupplierEvidence(sale, app, { consigned: economics.isAgentSale, currency });
    const route = resolveDealRoute(app, { vehicle, consigned: economics.isAgentSale, sale });
    const supplierSettlementMinor = resolveSupplierSettlementMinor({
      ...route, supplierEntitlement, margin, payable: payableRows.find((p) => p.status !== "CANCELLED"), currency,
    });
    const derive = (moneySettled: boolean) => {
      const profit = cockpitManagementProfit({ app, saleCancelled: route.saleCancelled,
        supplierSettlementMinor, actualExpensesMinor: feeSummary.actualExpensesMinor,
        executionFee: feeSummary.executionFee, currency, fullySettled: moneySettled && feeSummary.expensesFullyReconciled,
      });
      return deriveFinancedOverviewFigures({ app, consigned: economics.isAgentSale, moneySettled, fees: liveFees,
        commissions: commission, preparation, fullCostBasis: basis, mayReadCost: true,
        money: { currency, routeKnown: route.routeKnown, settlesDirectToSupplier: route.settlesDirect,
          parties: [], expenses: { actualTotalMinor: feeSummary.actualExpensesMinor,
            awaitingActuals: feeSummary.feesAwaitingActuals }, profit },
      });
    };
    const unsettled = derive(false);
    const settled = derive(true);
    const resultFor = (figures: FinancedFigures): ReportDealFigures => overviewReportResult(base, figures);
    if (sameProfit(unsettled.summary.profit, settled.summary.profit) &&
      sameProfit(unsettled.profitBeforeCommissions, settled.profitBeforeCommissions)) {
      return { kind: "READY", base, result: resultFor(unsettled) };
    }
    return { kind: "PENDING", base, pending: { app, route, derive, resultFor, margin, supplierClaim, payableRows } };
  });

  const pending = prepared.flatMap((row) => row.pending ? [row] : []);
  const invoiceIds = [...new Set(pending.flatMap((row) => row.base.sale.canonicalReceivableDocumentId ? [row.base.sale.canonicalReceivableDocumentId] : []))];
  const invoiceRows = await Promise.all(invoiceIds.map((id) => ctx.db.get(id)));
  const invoices = new Map(invoiceRows.flatMap((d) => d ? [[d._id, d] as const] : []));
  // Match the existing by_receivable reader even for malformed foreign linked
  // allocations. Scope the one range to the referenced canonical ids, then group.
  const sortedInvoiceIds = [...invoiceIds].sort();
  const allocations = sortedInvoiceIds.length ? accept(await ctx.db.query("paymentAllocations").withIndex("by_receivable", (q) =>
    q.gte("receivableDocumentId", sortedInvoiceIds[0]).lte("receivableDocumentId", sortedInvoiceIds[sortedInvoiceIds.length - 1])).take(remaining + 1)) : [];
  const allocationsByInvoice = groupBy(allocations, (a) => a.receivableDocumentId);
  const events = invoiceIds.length ? accept(await ctx.db.query("accountingEvents").withIndex("by_org_idempotency", (q) =>
    q.eq("orgId", orgId).gte("idempotencyKey", "sale_completed_").lt("idempotencyKey", "sale_completed_\uffff")).take(remaining + 1)) : [];
  const firstEvents = new Map<string, Doc<"accountingEvents">>();
  for (const event of events) if (!firstEvents.has(event.idempotencyKey)) firstEvents.set(event.idempotencyKey, event);
  const pendingKeys = new Set(pending.map((row) => saleCompletedKey(row.base.sale._id)));
  const journalIds = [...new Set([...firstEvents.values()].flatMap((e) => pendingKeys.has(e.idempotencyKey) && e.journalEntryId ? [e.journalEntryId] : []))];
  const journals = new Map((await Promise.all(journalIds.map((id) => ctx.db.get(id)))).flatMap((j) => j ? [[j._id, j] as const] : []));
  const quoteIds = [...new Set(pending.flatMap((row) => row.pending && row.pending.app.quoteModeAtSubmission === undefined ? [row.pending.app.quoteId] : []))];
  const quotes = new Map((await Promise.all(quoteIds.map((id) => ctx.db.get(id)))).flatMap((q) => q?.orgId === orgId ? [[q._id, q] as const] : []));
  return prepared.map((row) => {
    let result: ReportDealFigures;
    if (row.kind === "READY") result = row.result;
    else {
      const { app, route, derive, resultFor, margin, supplierClaim, payableRows } = row.pending;
      const { sale, currency, economics } = row.base;
      const mode = app.quoteModeAtSubmission ?? quotes.get(app.quoteId)?.mode;
      const leg = resolveFinancierLeg(app, route, sale, mode);
      const event = firstEvents.get(saleCompletedKey(sale._id)) ?? null;
      const invoice = sale.canonicalReceivableDocumentId ? invoices.get(sale.canonicalReceivableDocumentId) ?? null : null;
      const customer = leg !== "NONE" && financedSaleRecognitionApplies(app, { settlesDirect: route.settlesDirect }) && !composeCustomerGapToDealer(app).readable
        ? "UNKNOWN" : customerInvoicePositionFromRows({ sale, scope: { orgId, currency }, receivable: invoice, event,
          journal: event?.journalEntryId ? journals.get(event.journalEntryId) ?? null : null,
          allocations: invoice ? allocationsByInvoice.get(invoice._id) ?? [] : [] }).state;
      const moneySettled = !route.saleCancelled && settlementIsComplete({
        financier: resolveFinancierObligation(app, route.settlesDirect, leg),
        supplier: supplierObligationFromRows(app, { settlesDirect: route.settlesDirect, consigned: economics.isAgentSale, currency, supplierClaim, margin }, payableRows),
        customer,
      });
      result = resultFor(derive(moneySettled));
    }
    return result;
  });
}
