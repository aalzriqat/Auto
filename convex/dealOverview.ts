import { deriveFinancedOverviewFigures } from "./utils/dealOverviewFigures";
export { frozenExecutionFeeActualMinor, dealerBorneExpected, dealerBorneLinesMixed } from "./utils/dealOverviewFigures";
import { v } from "convex/values";
import type { ApiFromModules, FunctionReturnType } from "convex/server";
import { query } from "./_generated/server";
import { api } from "./_generated/api";
import type * as applicationsModule from "./applications";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { canReadVehicleCost } from "./utils/vehicleCostVisibility";
import { loadActiveFees } from "./utils/settlementDeductions";
import type { DealFinancialSummary } from "./utils/dealFinancialSummary";
import {
  deriveDealerPreparationExpenses,
  deriveVehicleCostBasis,
  type DealerPreparationExpenses,
  type VehicleCostBasis,
} from "./utils/vehicleCostBasis";
import { loadProfitCommissions, loadVehicleProfitExpenses } from "./utils/dealProfitReads";




/**
 * The cockpit payload, typed through a one-module api slice for the reason
 * `dealWorkspace.ts` documents: annotating through the generated `api` from
 * inside `convex/` is circular and degrades the whole api to `any`.
 */
type ApplicationsApi = ApiFromModules<{ applications: typeof applicationsModule }>;
type DealCockpitPayload = NonNullable<
  FunctionReturnType<ApplicationsApi["applications"]["dealCockpit"]>
>;

/**
 * A cost figure as SERVED: the aggregate, with its line-level rows only when
 * the caller may read expense lines.
 *
 * `view:cost_price` authorizes the vehicle's cost — the totals the margin is
 * measured against. It does not authorize the expense LEDGER: which repair,
 * on which date, for how much, is `view:expenses` (the rule
 * `expenses.listExpenses` already applies). So the available arm is served in
 * two explicit tiers, discriminated by `lineDetail`: SERVED carries the rows,
 * WITHHELD carries no `expenses` key at all — the field does not exist in the
 * payload rather than being emptied, so a screen cannot mistake "not allowed
 * to see" for "there are none". The unavailable arm carries no line detail
 * to redact and is served as is.
 */
type CostLinesTier<T extends VehicleCostBasis | DealerPreparationExpenses> =
  | Exclude<T, { available: true }>
  | (Extract<T, { available: true }> & Readonly<{ lineDetail: "SERVED" }>)
  | (Omit<Extract<T, { available: true }>, "expenses"> & Readonly<{ lineDetail: "WITHHELD" }>);

export type ServedVehicleCostBasis = CostLinesTier<VehicleCostBasis>;
export type ServedDealerPreparation = CostLinesTier<DealerPreparationExpenses>;

/** Each tier built field by field — nothing spread from the derivation, so a field added to it later cannot slip past the redaction. */
function serveVehicleCostBasis(basis: VehicleCostBasis, mayReadLines: boolean): ServedVehicleCostBasis {
  if (!basis.available) return basis;
  const totals = {
    available: true as const,
    currency: basis.currency,
    consigned: basis.consigned,
    baseMinor: basis.baseMinor,
    landedCostMinor: basis.landedCostMinor,
    eligibleExpensesMinor: basis.eligibleExpensesMinor,
    totalBeforeDealMinor: basis.totalBeforeDealMinor,
    excluded: basis.excluded,
    cutoffCreationTime: basis.cutoffCreationTime,
  };
  return mayReadLines
    ? { ...totals, expenses: basis.expenses, lineDetail: "SERVED" }
    : { ...totals, lineDetail: "WITHHELD" };
}

function serveDealerPreparation(
  preparation: DealerPreparationExpenses,
  mayReadLines: boolean
): ServedDealerPreparation {
  if (!preparation.available) return preparation;
  const totals = {
    available: true as const,
    currency: preparation.currency,
    totalMinor: preparation.totalMinor,
    excluded: preparation.excluded,
  };
  return mayReadLines
    ? { ...totals, expenses: preparation.expenses, lineDetail: "SERVED" }
    : { ...totals, lineDetail: "WITHHELD" };
}

export type FinancedDealOverview = Readonly<{
  /**
   * The financial overview, or `null` for a caller without `view:finance`.
   * Gated by the SAME predicate the cockpit gates `money` on — literally by
   * whether the cockpit served `money` — so this module cannot disclose a
   * figure the cockpit withholds. Every input is FINANCE-class in
   * `financeApplicationProjection` (funding composition, dealer contribution,
   * expected remittance, target selling amount, legal invoice) or is read off
   * `money` itself. The management profit and its entire breakdown also require
   * `view:cost_price`: a headline beside the sale price would otherwise reveal
   * the cost even if its VEHICLE_COST line alone were removed.
   */
  financialSummary: DealFinancialSummary | null;
  /**
   * The vehicle's pre-deal cost basis, or `null` for a caller without
   * `view:cost_price` — the rule the vehicle queries already apply to
   * `purchasePrice`, and the class `vehiclePurchaseCostMinor` carries. Its
   * expense LINES need `view:expenses` as well (see `CostLinesTier`).
   */
  vehicleCostBasis: ServedVehicleCostBasis | null;
  /**
   * SOURCED only, under the same `view:cost_price` gate: what the dealership
   * paid in live showroom expenses on the supplier's car, in every category
   * and regardless of registration date. `null` on the dealership's own car
   * (its period costs still reduce management net) and for a caller who
   * may not read costs.
   */
  dealerPreparation: ServedDealerPreparation | null;
}>;

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
    const owner = isSystemOwnerRole(role);
    const mayReadCost = canReadVehicleCost(role);
    // Neither branch of this response is visible to this role. Return after
    // the existing authorization and ownership checks, before reading costs.
    if (cockpit.money === null && !mayReadCost) {
      return { financialSummary: null, vehicleCostBasis: null, dealerPreparation: null };
    }
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
        : await loadVehicleProfitExpenses(ctx, vehicle);
    const costBasisFor = (cutoffCreationTime: number | null): VehicleCostBasis | null =>
      vehicle === null
        ? null
        : deriveVehicleCostBasis({ vehicle, expenses, cutoffCreationTime, dealCurrency, orgCurrency });
    // Management costs have no registration cutoff. STOCK capitalized costs
    // stay in its full basis; only additional costs enter this operand.
    const consignedByCockpit = cockpit.vehicle?.consigned ?? null;
    const preparation: DealerPreparationExpenses | null =
      vehicle !== null && !vehicle.isDeleted && consignedByCockpit !== null
        ? deriveDealerPreparationExpenses({
            expenses,
            cutoffCreationTime: null,
            dealCurrency,
            orgCurrency,
            consigned: consignedByCockpit,
          })
        : null;

    let financialSummary: DealFinancialSummary | null = null;
    if (cockpit.money !== null) {
      const commissions = await loadProfitCommissions(ctx, {
        orgId: args.orgId, saleId: app.finalizedSaleId ?? null, currency: cockpit.money.currency,
        mayReadCommissions: owner || role.permissions.includes(PERMISSIONS.VIEW_COMMISSIONS),
      });
      // The configured-fee checklist, as the handover-cost panel derives it —
      // the same function, the same snapshot, the same live lines.
      const fees = await loadActiveFees(ctx, app._id);
      financialSummary = deriveFinancedOverviewFigures({
        app, money: cockpit.money, consigned: consignedByCockpit,
        moneySettled: cockpit.stages.find((stage) => stage.key === "SETTLEMENT")?.state === "COMPLETE",
        fees, commissions, preparation, fullCostBasis: costBasisFor(null), mayReadCost,
      }).summary;
    }

    let vehicleCostBasis: ServedVehicleCostBasis | null = null;
    let dealerPreparation: ServedDealerPreparation | null = null;
    // The LINES are the expense ledger, gated as `expenses.listExpenses` gates it.
    const mayReadLines = owner || role.permissions.includes(PERMISSIONS.VIEW_EXPENSES);
    if (mayReadCost) {
      // The PRE-DEAL basis: the same rows, cut off at the application's own
      // registration instant.
      const basis = costBasisFor(app._creationTime);
      vehicleCostBasis = basis === null ? null : serveVehicleCostBasis(basis, mayReadLines);
      dealerPreparation = preparation === null || consignedByCockpit !== true ? null : serveDealerPreparation(preparation, mayReadLines);
    }

    return { financialSummary, vehicleCostBasis, dealerPreparation };
  },
});
