import { v } from "convex/values";
import type { ApiFromModules, FunctionReturnType } from "convex/server";
import { query } from "./_generated/server";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type * as applicationsModule from "./applications";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { deriveExpectedFees, summarizeFees, type ExpectedFeeRow } from "./financeDealCosts";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { loadActiveFees, unrecordedConfiguredFeePositions } from "./utils/settlementDeductions";
import {
  deriveStockManagementProfit,
  withPreparationExpenses,
  type DealProfit,
} from "./utils/financingEconomics";
import {
  deriveDealFinancialSummary,
  type DealFinancialSummary,
  type DealFinancialSummaryInputs,
} from "./utils/dealFinancialSummary";
import {
  deriveDealerPreparationExpenses,
  deriveVehicleCostBasis,
  MAX_COST_BASIS_EXPENSES,
  type DealerPreparationExpenses,
  type VehicleCostBasis,
} from "./utils/vehicleCostBasis";

/**
 * The cockpit payload, typed through a one-module api slice for the reason
 * `dealWorkspace.ts` documents: annotating through the generated `api` from
 * inside `convex/` is circular and degrades the whole api to `any`.
 */
type ApplicationsApi = ApiFromModules<{ applications: typeof applicationsModule }>;
type DealCockpitPayload = NonNullable<
  FunctionReturnType<ApplicationsApi["applications"]["dealCockpit"]>
>;
type CockpitMoney = NonNullable<DealCockpitPayload["money"]>;

export type FinancedDealOverview = Readonly<{
  /**
   * The financial overview, or `null` for a caller without `view:finance`.
   * Gated by the SAME predicate the cockpit gates `money` on — literally by
   * whether the cockpit served `money` — so this module cannot disclose a
   * figure the cockpit withholds. Every input is FINANCE-class in
   * `financeApplicationProjection` (funding composition, dealer contribution,
   * expected remittance, target selling amount, legal invoice) or is read off
   * `money` itself. The STOCK profit's VEHICLE_COST line is served under the
   * same gate the cash cockpit already serves it under (`sales.dealCockpit`
   * shows `view:finance` the vehicle cost inside the accounting profit).
   */
  financialSummary: DealFinancialSummary | null;
  /**
   * The vehicle's pre-deal cost basis, or `null` for a caller without
   * `view:cost_price` — the rule the vehicle queries already apply to
   * `purchasePrice`, and the class `vehiclePurchaseCostMinor` carries.
   */
  vehicleCostBasis: VehicleCostBasis | null;
  /**
   * SOURCED only, under the same `view:cost_price` gate: what the dealership
   * spent preparing the supplier's car before the deal — shown beside the
   * supplier's cost, never added to it. `null` on the dealership's own car
   * (those costs are capitalized into the basis above) and for a caller who
   * may not read costs.
   */
  dealerPreparation: DealerPreparationExpenses | null;
}>;

/**
 * The configured fees the DEALERSHIP bears, from the checklist the frozen
 * snapshot implies: the total, and how much of it is not yet covered by a
 * recorded actual. "Dealership-borne" is DEALER or EMPLOYEE — the same two
 * payers the cockpit's expense summary counts as the dealership's money. A
 * template the customer or the financier pays is not the dealership's outlay
 * and is left out of both; the checklist still lists it.
 *
 * Remaining is PER ROW, `max(expected − recorded actual, 0)`: a fee expected
 * at 250 and recorded at 100 so far still has 150 expected, and one recorded
 * above its expectation has nothing left — an actual row's existence alone
 * does not retire the expectation.
 */
export function dealerBorneExpected(
  source: ReturnType<typeof deriveExpectedFees>["source"],
  rows: ReadonlyArray<ExpectedFeeRow>,
  /** The deal's denomination; a matched actual in any other is refused, never netted. */
  dealCurrency: string
): DealFinancialSummaryInputs["expectedDealerBorne"] {
  if (source !== "COMPANY_RULE_SNAPSHOT") return { totalMinor: null, remainingMinor: null, reason: "NO_POLICY" };
  const dealerRows = rows.filter((row) => row.paidBy === "DEALER" || row.paidBy === "EMPLOYEE");
  // FAIL CLOSED: an actual recorded in another currency cannot be subtracted
  // from an expectation in this one, and a template or actual amount that is
  // not a safe non-negative integer is not a figure.
  const safe = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (dealerRows.some((row) => row.actual !== null && row.actual.currency !== dealCurrency)) {
    return { totalMinor: null, remainingMinor: null, reason: "MIXED_DENOMINATION" };
  }
  if (dealerRows.some((row) => !safe(row.expectedAmountMinor) || (row.actual?.actualAmountMinor !== undefined && !safe(row.actual.actualAmountMinor)))) {
    return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
  }
  const totalMinor = dealerRows.reduce((sum, row) => sum + row.expectedAmountMinor, 0);
  const remainingMinor = dealerRows.reduce(
    (sum, row) => sum + Math.max(0, row.expectedAmountMinor - (row.actual?.actualAmountMinor ?? 0)),
    0
  );
  if (!Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(remainingMinor)) {
    return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
  }
  return { totalMinor, remainingMinor, reason: null };
}

/**
 * The headline, route-specific.
 *
 * SOURCED (consigned): the cockpit's own management profit, consignment
 * economics, untouched (ACC-1). STOCK (the dealership's car): the cockpit
 * reports NoSupplierSettlement because there is no supplier, so the figure is
 * derived here against the vehicle's whole capitalized cost — the same rows
 * the GL's COGS authority sums (purchase price, landed cost, every
 * CAPITALIZED_INVENTORY expense, frozen once the car is SOLD because later
 * expenses are PERIOD_EXPENSE) — through `deriveVehicleCostBasis` with no
 * cutoff, so that an unreadable row REFUSES the profit rather than reading as
 * a zero cost and overstating it. Ownership is the cockpit's verdict
 * (`vehicle.consigned`), never inferred from which fields are populated.
 */
function routeSpecificProfit(args: {
  app: Doc<"financeApplications">;
  consigned: boolean | null;
  money: CockpitMoney;
  /** The vehicle's WHOLE book value (no cutoff), or why it cannot be stated. */
  fullCostBasis: VehicleCostBasis | null;
  /** SOURCED: the dealership's pre-deal preparation spend, subtracted once. */
  preparation: DealerPreparationExpenses | null;
  /**
   * The cockpit's own "fully settled" — money settled AND every cost line
   * carrying a CHECKED actual — as `buildCockpitMoney` classifies a
   * consignment figure. A STOCK figure is called actual on the same terms.
   */
  fullySettled: boolean;
}): DealProfit {
  const { app, money } = args;
  if (args.consigned === null) return money.profit;
  if (args.consigned) {
    // Consignment economics, the cockpit's own, less what the dealership
    // spent preparing the supplier's car. A management estimate stays one.
    if (money.profit.available && money.profit.basis !== "MANAGEMENT_ESTIMATE") return money.profit;
    return withPreparationExpenses(
      money.profit,
      args.preparation === null ? { available: false } : args.preparation
    );
  }

  const vehicleCostMinor =
    args.fullCostBasis !== null && args.fullCostBasis.available && !args.fullCostBasis.consigned
      ? args.fullCostBasis.totalBeforeDealMinor
      : undefined;
  return deriveStockManagementProfit({
    dealCancelled: app.status === "CANCELLED",
    approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
    vehicleCostMinor,
    dealerContributionMinor: app.dealerContributionMinor,
    customerDirectToDealerMinor:
      (app.customerGapCashToDealerMinor ?? 0) + (app.customerGapInstallmentToDealerMinor ?? 0),
    actualExpensesMinor: money.expenses.actualTotalMinor,
    currency: money.currency,
    fullySettled: args.fullySettled,
  });
}

/**
 * The Unified Deal FINANCIAL OVERVIEW read model for a financed deal.
 *
 * A sibling of `dealWorkspace.financedDealCockpit`, not a change to it: that
 * module is content-pinned as the reviewed P3 postimage
 * (`scripts/protectedSourcePins.test.ts`), so the overview is composed in a
 * module of its own on top of the same single authority.
 *
 * `applications.dealCockpit` remains authoritative for every figure in `money`
 * — the party balances, the expenses, the consignment profit and its
 * redaction. This query PROJECTS that payload plus the application's frozen
 * economics into the facts an operator reads, and adds what the cockpit does
 * not carry: the vehicle's cost basis before the deal, a STOCK profit, the
 * dealer-borne share of the configured fees, and the expected remittance
 * before a receivable exists. It recomputes nothing it can read.
 *
 * Composed in ONE read snapshot via `ctx.runQuery`, for the same reason the
 * workspace wrapper is: a summary that disagreed with the panel beside it about
 * custody of real cash would be the screen contradicting itself.
 */
export const financedDealOverview = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args): Promise<FinancedDealOverview | null> => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    // The one authorization boundary for the money. `dealCockpit` returns
    // null for a missing application or a foreign org, and `money: null` for a
    // caller it withholds the figures from.
    const cockpit: DealCockpitPayload | null = await ctx.runQuery(api.applications.dealCockpit, {
      orgId: args.orgId,
      applicationId: args.applicationId,
    });
    if (cockpit === null) return null;

    // TEN-1: this handler takes an orgId and a caller-supplied id, so it proves
    // ownership of the row it reads LOCALLY, whatever the cockpit just proved.
    const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", args.applicationId);
    const orgCurrency = await getOrgCurrency(ctx, args.orgId);
    const dealCurrency = app.economicsCurrency ?? orgCurrency;
    const vehicleRow = await ctx.db.get(app.vehicleId);
    const vehicle = vehicleRow !== null && vehicleRow.orgId === args.orgId ? vehicleRow : null;

    // The vehicle's expense rows, read ONCE, indexed by (org, vehicle) and
    // BOUNDED — one row past the cap so the helper can refuse a prefix. Both
    // derivations below read them; what each caller may SEE is gated below.
    const expenses =
      vehicle === null
        ? []
        : await ctx.db
            .query("expenses")
            .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", vehicle._id))
            .take(MAX_COST_BASIS_EXPENSES + 1);
    const costBasisFor = (cutoffCreationTime: number | null): VehicleCostBasis | null =>
      vehicle === null
        ? null
        : deriveVehicleCostBasis({ vehicle, expenses, cutoffCreationTime, dealCurrency, orgCurrency });
    // Ownership is the cockpit's verdict; the preparation figure exists only
    // for a consigned car, cut off at the deal's registration like the basis.
    const consignedByCockpit = cockpit.vehicle?.consigned ?? null;
    const preparation: DealerPreparationExpenses | null =
      vehicle !== null && consignedByCockpit === true
        ? deriveDealerPreparationExpenses({
            expenses,
            cutoffCreationTime: app._creationTime,
            dealCurrency,
            orgCurrency,
          })
        : null;

    let financialSummary: DealFinancialSummary | null = null;
    if (cockpit.money !== null) {
      // The configured-fee checklist, as the handover-cost panel derives it —
      // the same function, the same snapshot, the same live lines.
      const fees = await loadActiveFees(ctx, app._id);
      const expected = deriveExpectedFees({
        snapshot: app.companyRuleSnapshot,
        fees,
        currency: cockpit.money.currency,
        actualTotalMinor: cockpit.money.expenses.actualTotalMinor,
      });
      const consigned = cockpit.vehicle?.consigned ?? null;
      /**
       * "Fully settled" on the cockpit's own terms, so a STOCK headline is
       * called ACTUAL exactly when a consignment one would be. Money settled
       * is the SETTLEMENT stage, which the cockpit derives from
       * `settlementFacts.moneySettled`; the expense half is FULL
       * reconciliation in the closure's own sense: `summarizeFees.fullyReconciled`
       * (at least one live line, none awaiting an actual, none awaiting a
       * checked reconciliation), every live line in the deal's currency, and
       * — per `settlementDeductions` — no configured fee position still
       * without a recorded actual. A deal with no cost lines at all, or with a
       * configured fee nobody has recorded, has not finished its costs and is
       * never called ACTUAL. RECORDED and RECONCILED are different claims.
       */
      const moneySettled =
        cockpit.stages.find((stage) => stage.key === "SETTLEMENT")?.state === "COMPLETE";
      const sameCurrencyFees = fees.filter((fee) => fee.currency === cockpit.money.currency);
      const feeSummary = summarizeFees(sameCurrencyFees);
      const expensesFullyReconciled =
        sameCurrencyFees.length === fees.length &&
        feeSummary.fullyReconciled &&
        unrecordedConfiguredFeePositions(app.companyRuleSnapshot, fees).length === 0;
      const fullySettled = moneySettled && expensesFullyReconciled;
      financialSummary = deriveDealFinancialSummary({
        currency: cockpit.money.currency,
        routeKnown: cockpit.money.routeKnown,
        settlesDirectToSupplier: cockpit.money.settlesDirectToSupplier,
        parties: cockpit.money.parties,
        expenses: cockpit.money.expenses,
        profit: routeSpecificProfit({
          app,
          consigned,
          money: cockpit.money,
          fullCostBasis: costBasisFor(null),
          preparation,
          fullySettled,
        }),
        vehicleConsigned: consigned,
        app,
        expectedDealerBorne: dealerBorneExpected(expected.source, expected.rows, cockpit.money.currency),
      });
    }

    let vehicleCostBasis: VehicleCostBasis | null = null;
    let dealerPreparation: DealerPreparationExpenses | null = null;
    const mayReadCost =
      isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);
    if (mayReadCost) {
      // The PRE-DEAL basis: the same rows, cut off at the application's own
      // registration instant.
      vehicleCostBasis = costBasisFor(app._creationTime);
      dealerPreparation = preparation;
    }

    return { financialSummary, vehicleCostBasis, dealerPreparation };
  },
});
