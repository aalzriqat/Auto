import type { Doc } from "../_generated/dataModel";
import { toMinorSameCurrencyOrUndefined } from "./money";

/**
 * What the vehicle cost the dealership BEFORE this deal existed — the cost
 * basis the deal's margin is measured against, itemized.
 *
 * ## Which writers are counted, and why exactly these
 *
 * The base follows `computeVehicleCapitalizedCost`, the single authority on a
 * vehicle's book value, and this module says the same thing that function
 * says — it does not re-decide it:
 *
 * - STOCK (purchased) vehicle: `vehicles.purchasePrice` + `vehicles.landedCostTotal`.
 * - SOURCED (consigned) vehicle: `vehicles.sourceCost`, which is the SUPPLIER's
 *   entitlement, not money the dealership spent. It is served under the
 *   `consigned: true` flag so a screen must say so (ACC-1), and reconditioning
 *   is never capitalized onto a consigned car — `recordPaidExpenseSideEffects`
 *   writes it as PERIOD_EXPENSE — so the eligible-expense total is zero there
 *   by construction, not by omission.
 *
 * The eligible expenses are `expenses` rows that satisfy ALL of:
 *
 * 1. `vehicleId` is this vehicle (indexed by `by_org_vehicle`);
 * 2. `accountingTreatment === "CAPITALIZED_INVENTORY"` — the decision the
 *    expense writer recorded AT POSTING TIME (a PAID expense in a reconditioning
 *    category on an unsold stock vehicle). PENDING rows carry no treatment and
 *    are reported in `pendingCount`, never summed: a cost nobody has paid is not
 *    a cost basis. PERIOD_EXPENSE rows (marketing, fees, post-sale repairs) are
 *    excluded because the GL never put them in inventory;
 * 3. not deleted and not reversed (`isDeleted !== true`, `reversedAt === undefined`).
 *    `reverseExpense` soft-deletes AND stamps `reversedAt`; either mark alone is
 *    enough to exclude the row, and reversed rows are counted in
 *    `reversedCount` so the screen can say history exists;
 * 4. REGISTERED before the deal: `row._creationTime < cutoffCreationTime`,
 *    where the cutoff is the finance application's own `_creationTime`. A
 *    `null` cutoff means NO cutoff — the vehicle's whole book value, which is
 *    what a STOCK deal's profit is measured against (the same rows the GL's
 *    COGS authority sums, but refusing an unreadable row instead of reading it
 *    as zero). This
 *    is the row's write instant, not its business `date`: a repair dated last
 *    week but registered the day after the application was opened was booked
 *    under the deal, and a business-date comparison would have counted every
 *    same-day row registered after the deal as pre-deal. A row registered at
 *    or after the cutoff is counted in `afterCutoffCount`, not dropped; it
 *    still reaches the vehicle's book value through
 *    `computeVehicleCapitalizedCost`.
 *
 * Deal handover costs live in `financeDealFees`, a different table read by a
 * different module, and are NEVER read here — so a transfer fee cannot appear
 * both here and in the handover-cost panel.
 *
 * The amount summed is `capitalizedAmount` — the exact net-of-VAT figure the
 * GL debited to inventory — not `amount`, which includes input VAT. A
 * CAPITALIZED_INVENTORY row that carries NO `capitalizedAmount` is a row the
 * writer never finished; it is not zero, and the whole basis is withheld as
 * UNREADABLE rather than understated.
 *
 * ## Bounds
 *
 * The caller reads at most `MAX_COST_BASIS_EXPENSES + 1` rows through the
 * index. Past the cap the basis is withheld as TOO_MANY_ROWS: a prefix of a
 * vehicle's expenses is not its cost basis and must not read like one.
 *
 * ## Denomination
 *
 * `expenses` and `vehicles` carry major units in the ORGANIZATION's currency;
 * the deal's figures are minor units in `economicsCurrency`. The two agree on
 * every deal recorded so far (the currency lock freezes the org currency once
 * economics exist), but they are not the same field, so the conversion is the
 * guarded one and the whole basis is withheld — with the reason — when they
 * differ. No figure here is converted at a rate nobody agreed.
 */

/** How many expense rows one vehicle's basis read is allowed to carry. */
export const MAX_COST_BASIS_EXPENSES = 200;

/**
 * The expense categories that are PREPARING a car for sale — the same set
 * `CAPITALIZABLE_EXPENSE_CATEGORIES` in `vehicleCost.ts` names. On the
 * dealership's own car these capitalize; on a consigned car the writer books
 * them as PERIOD_EXPENSE, and they are still the dealership's money spent on
 * the deal.
 */
const PREPARATION_CATEGORIES: ReadonlySet<Doc<"expenses">["category"]> = new Set([
  "REPAIR",
  "MAINTENANCE",
  "DETAILING",
  "TRANSPORT",
]);

export type DealerPreparationExpense = Readonly<{
  id: Doc<"expenses">["_id"];
  title: string;
  category: Doc<"expenses">["category"];
  date: number;
  /** Net of input VAT: `amount − taxAmount`. */
  netMinor: number;
}>;

/**
 * What the DEALERSHIP spent preparing a CONSIGNED car before this deal —
 * shown separately from the supplier's entitlement and subtracted exactly once
 * from the consignment management profit. Never capitalized: a consigned car
 * is not the dealership's inventory, and the supplier's entitlement is not
 * touched by what the dealership chose to spend.
 *
 * Evidence is admitted only when it is safely distinguishable:
 *   - a preparation category (repair, maintenance, detailing, transport);
 *   - PAID and posted: `accountingTreatment === "PERIOD_EXPENSE"` — the
 *     writer's own decision for a consigned car (`recordPaidExpenseSideEffects`
 *     never capitalizes onto SOURCED). A row that was CAPITALIZED on a car that
 *     is consigned NOW is a car that changed ownership after the fact; that
 *     history is not this deal's evidence and is refused as ambiguous;
 *   - not deleted and not reversed;
 *   - REGISTERED before the deal (`_creationTime`), like the cost basis.
 * PENDING rows are counted, never summed; an unreadable amount withholds the
 * whole figure. Net of VAT: `amount − taxAmount`, since input VAT is
 * recoverable and is not a cost of the car.
 */
export type DealerPreparationExpenses =
  | Readonly<{
      available: true;
      currency: string;
      expenses: ReadonlyArray<DealerPreparationExpense>;
      totalMinor: number;
      excluded: Readonly<{ pendingCount: number; reversedCount: number; otherCount: number; afterCutoffCount: number }>;
    }>
  | Readonly<{
      available: false;
      reason: "MIXED_DENOMINATION" | "UNREADABLE_AMOUNT" | "TOO_MANY_ROWS" | "AMBIGUOUS_OWNERSHIP_HISTORY";
      currency: string;
    }>;

export function deriveDealerPreparationExpenses(args: {
  expenses: ReadonlyArray<Doc<"expenses">>;
  cutoffCreationTime: number | null;
  dealCurrency: string;
  orgCurrency: string;
}): DealerPreparationExpenses {
  const currency = args.dealCurrency;
  if (args.orgCurrency !== currency) return { available: false, reason: "MIXED_DENOMINATION", currency };
  if (args.expenses.length > MAX_COST_BASIS_EXPENSES) return { available: false, reason: "TOO_MANY_ROWS", currency };
  const excluded = { pendingCount: 0, reversedCount: 0, otherCount: 0, afterCutoffCount: 0 };
  const rows: DealerPreparationExpense[] = [];
  for (const row of args.expenses) {
    if (row.isDeleted === true || row.reversedAt !== undefined) {
      excluded.reversedCount += 1;
      continue;
    }
    if (!PREPARATION_CATEGORIES.has(row.category)) {
      excluded.otherCount += 1;
      continue;
    }
    if (row.accountingTreatment === "CAPITALIZED_INVENTORY") {
      return { available: false, reason: "AMBIGUOUS_OWNERSHIP_HISTORY", currency };
    }
    // PENDING is not spent, whatever treatment the row carries; a non-pending
    // row with no posting decision is unreadable legacy evidence, not zero.
    if (row.status === "PENDING") {
      excluded.pendingCount += 1;
      continue;
    }
    if (row.accountingTreatment === undefined) {
      return { available: false, reason: "UNREADABLE_AMOUNT", currency };
    }
    if (args.cutoffCreationTime !== null && row._creationTime >= args.cutoffCreationTime) {
      excluded.afterCutoffCount += 1;
      continue;
    }
    const net = row.amount - (row.taxAmount ?? 0);
    const netMinor = toMinorSameCurrencyOrUndefined(net, args.orgCurrency, currency);
    if (netMinor === undefined || netMinor < 0) return { available: false, reason: "UNREADABLE_AMOUNT", currency };
    rows.push({ id: row._id, title: row.title, category: row.category, date: row.date, netMinor });
  }
  rows.sort((a, b) => a.date - b.date);
  return {
    available: true,
    currency,
    expenses: rows,
    totalMinor: rows.reduce((sum, row) => sum + row.netMinor, 0),
    excluded,
  };
}

export type VehicleCostBasisExpense = Readonly<{
  id: Doc<"expenses">["_id"];
  title: string;
  category: Doc<"expenses">["category"];
  date: number;
  capitalizedMinor: number;
}>;

export type VehicleCostBasis =
  | Readonly<{
      available: true;
      currency: string;
      /** SOURCED — the base is the supplier's entitlement, not a dealer cost. */
      consigned: boolean;
      baseMinor: number;
      /** Only meaningful on a STOCK vehicle; `null` on a consigned one. */
      landedCostMinor: number | null;
      expenses: ReadonlyArray<VehicleCostBasisExpense>;
      eligibleExpensesMinor: number;
      totalBeforeDealMinor: number;
      /** How many rows were seen but NOT counted, and why — so absence is visible. */
      excluded: Readonly<{
        pendingCount: number;
        reversedCount: number;
        periodExpenseCount: number;
        afterCutoffCount: number;
      }>;
      /** The application's `_creationTime` — rows registered at or after it are not pre-deal; null = no cutoff. */
      cutoffCreationTime: number | null;
    }>
  | Readonly<{
      available: false;
      reason:
        | "NO_COST_RECORDED"
        | "MIXED_DENOMINATION"
        | "UNREADABLE_AMOUNT"
        | "TOO_MANY_ROWS"
        /** A CAPITALIZED row on a car that is consigned NOW: its ownership changed after the fact. */
        | "AMBIGUOUS_OWNERSHIP_HISTORY";
      currency: string;
      consigned: boolean;
    }>;

export function deriveVehicleCostBasis(args: {
  vehicle: Pick<
    Doc<"vehicles">,
    "sourceType" | "sourceCost" | "purchasePrice" | "landedCostTotal"
  >;
  /** At most `MAX_COST_BASIS_EXPENSES + 1` rows; one past the cap means truncation. */
  expenses: ReadonlyArray<Doc<"expenses">>;
  /** The application's `_creationTime`: rows registered at or after it are not pre-deal. `null` = no cutoff. */
  cutoffCreationTime: number | null;
  /** The deal's own denomination. */
  dealCurrency: string;
  /** What `expenses`/`vehicles` major amounts are recorded in. */
  orgCurrency: string;
}): VehicleCostBasis {
  const consigned = args.vehicle.sourceType === "SOURCED";
  const currency = args.dealCurrency;
  if (args.orgCurrency !== currency) {
    return { available: false, reason: "MIXED_DENOMINATION", currency, consigned };
  }
  if (args.expenses.length > MAX_COST_BASIS_EXPENSES) {
    return { available: false, reason: "TOO_MANY_ROWS", currency, consigned };
  }
  const minor = (major: number): number | undefined =>
    toMinorSameCurrencyOrUndefined(major, args.orgCurrency, currency);

  const baseMajor = consigned ? args.vehicle.sourceCost : args.vehicle.purchasePrice;
  if (baseMajor === undefined || baseMajor === null) {
    return { available: false, reason: "NO_COST_RECORDED", currency, consigned };
  }
  const baseMinor = minor(baseMajor);
  const landedCostMinor = consigned ? null : (minor(args.vehicle.landedCostTotal ?? 0) ?? undefined);
  if (baseMinor === undefined || landedCostMinor === undefined) {
    return { available: false, reason: "UNREADABLE_AMOUNT", currency, consigned };
  }

  const excluded = { pendingCount: 0, reversedCount: 0, periodExpenseCount: 0, afterCutoffCount: 0 };
  const eligible: VehicleCostBasisExpense[] = [];
  for (const row of args.expenses) {
    if (row.isDeleted === true || row.reversedAt !== undefined) {
      excluded.reversedCount += 1;
      continue;
    }
    // PENDING is "not paid yet": counted, never summed, whatever else the row
    // says. A row that is NOT pending and yet carries no posting decision is
    // legacy or half-written evidence — unreadable, not zero.
    if (row.status === "PENDING") {
      excluded.pendingCount += 1;
      continue;
    }
    if (row.accountingTreatment === undefined) {
      return { available: false, reason: "UNREADABLE_AMOUNT", currency, consigned };
    }
    if (row.accountingTreatment !== "CAPITALIZED_INVENTORY") {
      excluded.periodExpenseCount += 1;
      continue;
    }
    // A capitalized row on a car that is consigned NOW is a car whose
    // ownership changed after the row was posted. It is never added to the
    // supplier's entitlement, and the history is too ambiguous to state.
    if (consigned) {
      return { available: false, reason: "AMBIGUOUS_OWNERSHIP_HISTORY", currency, consigned };
    }
    if (args.cutoffCreationTime !== null && row._creationTime >= args.cutoffCreationTime) {
      excluded.afterCutoffCount += 1;
      continue;
    }
    // A capitalized row with no capitalized figure is not a zero.
    if (row.capitalizedAmount === undefined) {
      return { available: false, reason: "UNREADABLE_AMOUNT", currency, consigned };
    }
    const capitalizedMinor = minor(row.capitalizedAmount);
    if (capitalizedMinor === undefined) {
      return { available: false, reason: "UNREADABLE_AMOUNT", currency, consigned };
    }
    eligible.push({
      id: row._id,
      title: row.title,
      category: row.category,
      date: row.date,
      capitalizedMinor,
    });
  }
  eligible.sort((a, b) => a.date - b.date);
  const eligibleExpensesMinor = eligible.reduce((sum, row) => sum + row.capitalizedMinor, 0);

  return {
    available: true,
    currency,
    consigned,
    baseMinor,
    landedCostMinor,
    expenses: eligible,
    eligibleExpensesMinor,
    totalBeforeDealMinor: baseMinor + (landedCostMinor ?? 0) + eligibleExpensesMinor,
    excluded,
    cutoffCreationTime: args.cutoffCreationTime,
  };
}
