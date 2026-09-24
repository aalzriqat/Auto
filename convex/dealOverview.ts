import { v } from "convex/values";
import type { ApiFromModules, FunctionReturnType } from "convex/server";
import { query } from "./_generated/server";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type * as applicationsModule from "./applications";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { deriveExpectedFees, summarizeFees, unreadableFeeAmounts, type ExpectedFeeRow } from "./financeDealCosts";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { loadActiveFees, unrecordedConfiguredFeePositions } from "./utils/settlementDeductions";
import {
  composeCustomerGapToDealer,
  deriveStockManagementProfit,
  isMinorAmount,
  withPreparationExpenses,
  type DealProfit,
} from "./utils/financingEconomics";
import {
  deriveDealFinancialSummary,
  type DealFinancialSummary,
  type DealFinancialSummaryInputs,
  type RecordedCostsReason,
} from "./utils/dealFinancialSummary";
import {
  deriveDealerPreparationExpenses,
  deriveVehicleCostBasis,
  MAX_COST_BASIS_EXPENSES,
  type DealerPreparationExpenses,
  type VehicleCostBasis,
} from "./utils/vehicleCostBasis";
import { toMinorUnits } from "./utils/money";

function frozenMajorAmountToMinorOrUnreadable(amount: number, currency: string): number {
  try {
    return toMinorUnits(amount, currency);
  } catch {
    return Number.NaN;
  }
}

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
   * `money` itself. The STOCK profit's VEHICLE_COST line is served under the
   * same gate the cash cockpit already serves it under (`sales.dealCockpit`
   * shows `view:finance` the vehicle cost inside the accounting profit).
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
   * spent preparing the supplier's car before the deal — shown beside the
   * supplier's cost, never added to it. `null` on the dealership's own car
   * (those costs are capitalized into the basis above) and for a caller who
   * may not read costs.
   */
  dealerPreparation: ServedDealerPreparation | null;
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
/**
 * Actuals that can consume the frozen single execution-fee expectation.
 *
 * The scalar adminFees authority has no template position, so an arbitrary
 * dealer-borne cost must never retire it. Only a live finance-company fee paid
 * by the dealership is evidence for that position. Invalid/overflowing actuals
 * return NaN deliberately so dealerBorneExpected fails closed as UNSAFE_AMOUNT.
 */
export function frozenExecutionFeeActualMinor(
  fees: ReadonlyArray<Doc<"financeDealFees">>,
  dealCurrency: string
): number {
  let total = 0;
  for (const fee of fees) {
    if (
      fee.voidedAt !== undefined ||
      fee.feeType !== "FINANCE_COMPANY_FEE" ||
      (fee.paidBy !== "DEALER" && fee.paidBy !== "EMPLOYEE") ||
      fee.currency !== dealCurrency ||
      fee.actualAmountMinor === undefined
    ) {
      continue;
    }
    if (!isMinorAmount(fee.actualAmountMinor)) return Number.NaN;
    total += fee.actualAmountMinor;
    if (!Number.isSafeInteger(total)) return Number.NaN;
  }
  return total;
}

export function dealerBorneExpected(
  source: ReturnType<typeof deriveExpectedFees>["source"],
  rows: ReadonlyArray<ExpectedFeeRow>,
  /** The deal's denomination; a matched actual in any other is refused, never netted. */
  dealCurrency: string,
  /**
   * Whether ANY live dealer-borne line — matched to a template or not — is
   * denominated otherwise (`dealerBorneLinesMixed`). The rows above see only
   * the configured positions; an unplanned foreign line is invisible to them
   * and would leave this figure standing beside a recorded total that had
   * silently dropped it.
   */
  dealerBorneLineForeign = false,
  estimatedDealerBorneExpensesMinor?: number,
  dealerBorneActualMinor = 0
): DealFinancialSummaryInputs["expectedDealerBorne"] {
  // If the application carries a frozen expected fee total (Execution Fees / adminFees):
  if (estimatedDealerBorneExpensesMinor !== undefined) {
    if (dealerBorneLineForeign) {
      return { totalMinor: null, remainingMinor: null, reason: "MIXED_DENOMINATION" };
    }
    if (!isMinorAmount(estimatedDealerBorneExpensesMinor) || !isMinorAmount(dealerBorneActualMinor)) {
      return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
    }
    const totalMinor = estimatedDealerBorneExpensesMinor;
    const remainingMinor = Math.max(0, totalMinor - dealerBorneActualMinor);
    if (!Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(remainingMinor)) {
      return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
    }
    return { totalMinor, remainingMinor, reason: null };
  }

  if (source !== "COMPANY_RULE_SNAPSHOT") return { totalMinor: null, remainingMinor: null, reason: "NO_POLICY" };
  const dealerRows = rows.filter((row) => row.paidBy === "DEALER" || row.paidBy === "EMPLOYEE");
  // FAIL CLOSED: an actual recorded in another currency cannot be subtracted
  // from an expectation in this one, and a template estimate the checklist
  // already withheld (`expectedAmountMinor === null`), or one that reaches
  // here unreadable anyway, or an actual that is not a readable figure, is
  // not an operand.
  if (dealerBorneLineForeign || dealerRows.some((row) => row.actual !== null && row.actual.currency !== dealCurrency)) {
    return { totalMinor: null, remainingMinor: null, reason: "MIXED_DENOMINATION" };
  }
  const readable: Array<{ expectedAmountMinor: number; actualAmountMinor: number | undefined }> = [];
  for (const row of dealerRows) {
    const actualAmountMinor = row.actual?.actualAmountMinor;
    if (
      row.expectedAmountMinor === null ||
      !isMinorAmount(row.expectedAmountMinor) ||
      (actualAmountMinor !== undefined && !isMinorAmount(actualAmountMinor))
    ) {
      return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
    }
    readable.push({ expectedAmountMinor: row.expectedAmountMinor, actualAmountMinor });
  }
  const totalMinor = readable.reduce((sum, row) => sum + row.expectedAmountMinor, 0);
  const remainingMinor = readable.reduce(
    (sum, row) => sum + Math.max(0, row.expectedAmountMinor - (row.actualAmountMinor ?? 0)),
    0
  );
  if (!Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(remainingMinor)) {
    return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
  }
  return { totalMinor, remainingMinor, reason: null };
}

/**
 * Whether any live line the DEALERSHIP bears (paid by it or by an employee)
 * is denominated in a currency other than the deal's.
 *
 * The cockpit's expense total sums same-currency lines only and counts the
 * rest as "awaiting" — right for the screen it serves, but as an operand of
 * an outlay total or a profit it is a partial sum: a 200 USD licensing fee
 * the dealership paid is a real cost that the JOD total does not carry. Every
 * live line is inspected, not just the configured positions, because an
 * UNPLANNED foreign line is exactly the one the checklist cannot see. A
 * customer- or financier-borne foreign line is not the dealership's outlay
 * and does not withhold it.
 */
export function dealerBorneLinesMixed(
  fees: ReadonlyArray<Pick<Doc<"financeDealFees">, "paidBy" | "currency" | "voidedAt">>,
  dealCurrency: string
): boolean {
  return fees.some(
    (fee) =>
      fee.voidedAt === undefined &&
      (fee.paidBy === "DEALER" || fee.paidBy === "EMPLOYEE") &&
      fee.currency !== dealCurrency
  );
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
  expectedExpensesMinor?: number;
  /**
   * The cockpit's own "fully settled" — money settled AND every cost line
   * carrying a CHECKED actual — as `buildCockpitMoney` classifies a
   * consignment figure. A STOCK figure is called actual on the same terms.
   */
  fullySettled: boolean;
  /** A dealer-borne line in another currency: the expense operand is partial, so no figure is stated. */
  expensesMixed: boolean;
  /** A live line's amount is not a safe non-negative integer, or the lines overflow: the expense operand is corrupt. */
  expensesUnreadable: boolean;
}): DealProfit {
  const { app, money } = args;
  // Refused before either route: both derive against `actualExpensesMinor`,
  // and on a mixed deal that figure is missing a cost the dealership bore.
  // A profit computed over a partial cost is an overstatement with a reason
  // nobody would see; this one names it. An unreadable line is the same
  // refusal for the other failure: the cockpit's total was accumulated
  // unchecked, and NaN slips past the consignment builder's `< 0` guard.
  if (args.expensesMixed) return { available: false, reason: "ExpensesMixedDenomination" };
  if (args.expensesUnreadable) return { available: false, reason: "ExpensesUnreadable" };
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
  // Cancellation first, as the derivers themselves order it: a cancelled
  // deal has no profit whatever its inputs look like. Then the gap
  // contribution, composed at the shared boundary with each component
  // validated BEFORE the addition — added inline, a corrupt pair cancelled
  // into a safe operand.
  const dealCancelled = app.status === "CANCELLED";
  if (dealCancelled) return { available: false, reason: "DealCancelled" };
  const customerGapToDealer = composeCustomerGapToDealer(app);
  if (!customerGapToDealer.readable) return { available: false, reason: "CorruptInput" };
  return deriveStockManagementProfit({
    dealCancelled,
    approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
    vehicleCostMinor,
    dealerContributionMinor: app.dealerContributionMinor,
    customerDirectToDealerMinor: customerGapToDealer.amountMinor,
    actualExpensesMinor: money.expenses.actualTotalMinor,
    expectedExpensesMinor: args.expectedExpensesMinor,
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
      // The readable-total contract over EVERY live line: a NaN, fractional,
      // negative or unsafe amount, or lines that overflow, make the cockpit's
      // unchecked total a non-figure. It is then served nowhere — not as the
      // checklist's actual, not as the recorded outlay, not inside a profit.
      const expensesUnreadable = unreadableFeeAmounts(fees) !== null;
      const expected = deriveExpectedFees({
        snapshot: app.companyRuleSnapshot,
        fees,
        currency: cockpit.money.currency,
        actualTotalMinor: expensesUnreadable ? null : cockpit.money.expenses.actualTotalMinor,
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
      // Every live line, template or unplanned: a dealer-borne one in another
      // currency withholds the recorded, committed and expected outlay and the
      // profit built on them, with the reason — never a partial JOD total.
      const expensesMixed = dealerBorneLinesMixed(fees, cockpit.money.currency);
      const expensesReason: RecordedCostsReason | null = expensesMixed
        ? "MIXED_DENOMINATION"
        : expensesUnreadable
          ? "UNSAFE_AMOUNT"
          : null;
      // The estimate's evidence is EVERY live line, whoever pays it: the
      // financier's withholdings are settlement-deducted fees of any payer.
      // The same two verdicts, unreadable first (a corrupt amount is not a
      // figure in any currency), then denomination across all live lines.
      const feeEvidence: DealFinancialSummaryInputs["feeEvidence"] = {
        reason: expensesUnreadable
          ? "UNSAFE_AMOUNT"
          : sameCurrencyFees.length !== fees.length
            ? "MIXED_DENOMINATION"
            : null,
      };
      const frozenEstimatedFees =
        app.estimatedDealerBorneExpensesMinor ??
        (app.companyRuleSnapshot?.adminFees !== undefined
          ? frozenMajorAmountToMinorOrUnreadable(
              app.companyRuleSnapshot.adminFees,
              cockpit.money.currency
            )
          : undefined);
      const expectedDealerBorne = dealerBorneExpected(
        expected.source,
        expected.rows,
        cockpit.money.currency,
        expensesMixed,
        frozenEstimatedFees,
        frozenExecutionFeeActualMinor(fees, cockpit.money.currency)
      );
      financialSummary = deriveDealFinancialSummary({
        currency: cockpit.money.currency,
        routeKnown: cockpit.money.routeKnown,
        settlesDirectToSupplier: cockpit.money.settlesDirectToSupplier,
        parties: cockpit.money.parties,
        expenses:
          expensesReason !== null
            ? { actualTotalMinor: null, awaitingActuals: cockpit.money.expenses.awaitingActuals, reason: expensesReason }
            : { ...cockpit.money.expenses, reason: null },
        profit: routeSpecificProfit({
          app,
          consigned,
          money: cockpit.money,
          fullCostBasis: costBasisFor(null),
          preparation,
          expectedExpensesMinor: expectedDealerBorne.totalMinor ?? undefined,
          fullySettled,
          expensesMixed,
          expensesUnreadable:
            expensesUnreadable ||
            (frozenEstimatedFees !== undefined &&
              expectedDealerBorne.reason === "UNSAFE_AMOUNT"),
        }),
        vehicleConsigned: consigned,
        app: {
          ...app,
          dealerContributionSettlement:
            app.dealerContributionSettlement ?? app.companyRuleSnapshot?.dealerContributionSettlement,
        },
        expectedDealerBorne,
        feeEvidence,
      });
    }

    let vehicleCostBasis: ServedVehicleCostBasis | null = null;
    let dealerPreparation: ServedDealerPreparation | null = null;
    const owner = isSystemOwnerRole(role);
    const mayReadCost = owner || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);
    // The LINES are the expense ledger, gated as `expenses.listExpenses` gates it.
    const mayReadLines = owner || role.permissions.includes(PERMISSIONS.VIEW_EXPENSES);
    if (mayReadCost) {
      // The PRE-DEAL basis: the same rows, cut off at the application's own
      // registration instant.
      const basis = costBasisFor(app._creationTime);
      vehicleCostBasis = basis === null ? null : serveVehicleCostBasis(basis, mayReadLines);
      dealerPreparation = preparation === null ? null : serveDealerPreparation(preparation, mayReadLines);
    }

    return { financialSummary, vehicleCostBasis, dealerPreparation };
  },
});
