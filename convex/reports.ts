import { loadReportDealFigures, reportContributionFor, MAX_REPORT_SALES } from "./utils/reportDealFigures";
import { v, ConvexError } from "convex/values";
import { resolvePrepaidScheduleSource } from "./utils/openingPrepaidBasis";
import { query, QueryCtx } from "./_generated/server";
import { Id, Doc } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { projectSaleRow } from "./utils/saleRowProjection";
import { grossTransactionValueForTransaction } from "./utils/grossTransactionValue";
import { PERMISSIONS } from "./utils/permissions";
import { rateLimiter } from "./rateLimit";
import {
  computeAmortizationInfo,
  amortizationInfoFromScheduleProgress,
  recognizedAmountInRangeWithReversal,
  PREPAID_LOOKBACK_MS,
} from "./utils/expenseAmortization";
import {
  loadOrgPrepaidRecognitionByMonth,
  recognizedAmountInRangeFromEvents,
  queuedEntryCountsInRange,
  type RecognitionState,
} from "./utils/prepaidRecognitionEvents";

import { isShowroomBorne } from "./utils/costBearer";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { fromMinorUnits } from "./utils/money";
import { isSystemOwnerRole } from "./utils/permissions";

/** Longest span an interactive report may request. */
const MAX_REPORT_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Interactive reports collect their whole result set, so an unbounded or
 * inverted range is both a correctness bug (silently empty results) and a cost
 * one. Reject rather than clamp: a caller asking for ten years should be told,
 * not quietly handed one.
 */
function assertReportRange(startDate: number, endDate: number): void {
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) {
    throw new ConvexError("Report start and end dates must be valid timestamps.");
  }
  if (startDate > endDate) {
    throw new ConvexError("Report start date must not be after the end date.");
  }
  if (endDate - startDate > MAX_REPORT_RANGE_MS) {
    throw new ConvexError("Interactive reports are limited to 366 days. Narrow the range.");
  }
}

export const getSalesAndProfitReport = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);
    // SCRUM-902: per-sale cost and profit are acquisition-cost figures. Withheld as a whole (null), never zeroed, and
    // never thrown: the reports screen subscribes to this query while it loads.
    if (!(isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE))) return null;
    // Employees' pay is not part of view:reports.
    const canSeeCommissions =
      isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COMMISSIONS);

    const rateStatus = await rateLimiter.check(ctx, "heavyRead");
    if (!rateStatus.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(rateStatus.retryAfter / 1000)}s`);
    }

    assertReportRange(args.startDate, args.endDate);

    // Both bounds belong in the index range. With only `gte(startDate)` indexed
    // and `lte(endDate)` in .filter(), the scan was proportional to everything
    // sold AFTER startDate — a one-day report on an old date walked the org's
    // entire subsequent sales history before discarding almost all of it.
    const salesInDateRange = await ctx.db
      .query("sales")
      .withIndex("by_org_saleDate", (q) =>
        q
          .eq("orgId", args.orgId)
          .gte("saleDate", args.startDate)
          .lte("saleDate", args.endDate)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "COMPLETED"),
          q.neq(q.field("isDeleted"), true)
        )
      )
      .take(MAX_REPORT_SALES + 1);

    let totalRevenue = 0;
    let totalCost = 0;
    let totalProfit = 0;
    // Consigned sales are the dealership's SERVICE, not its stock. Their gross
    // is real and worth showing — it is the size of the deal arranged — but it
    // is not turnover, so it is reported alongside rather than inside it.
    let totalGrossTransactionValue = 0;
    let totalSupplierSettlement = 0;
    let agentSaleCount = 0;
    // Rows lacking complete revenue and management net in the report currency
    // are excluded from all three cards and disclosed together.
    let unknownMarginSaleCount = 0;
    let unknownSupplierSettlementSaleCount = 0;

    const orgCurrency = await getOrgCurrency(ctx, args.orgId);
    const figures = await loadReportDealFigures(ctx, {
      orgId: args.orgId, sales: salesInDateRange, orgCurrency, mayReadCommissions: canSeeCommissions,
      mayReadFinance: isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_FINANCE),
    });
    let totalCommissions = 0;
    let totalNetProfitAfterCommissions = 0;
    let commissionIncompleteSaleCount = 0;
    const enrichedSales = figures.map((figure) => {
      const { sale, vehicle, economics, profit, currency } = figure;
      const contribution = reportContributionFor(figure, orgCurrency);
      const included = contribution.available;
      const netProfit = profit.available ? fromMinorUnits(profit.amountMinor, currency) : null;
      const recognizedRevenue = contribution.available ? fromMinorUnits(contribution.revenueMinor, orgCurrency) : null;
      // Reconciliation between recognized revenue and the deal page's net.
      // Labelled as costs AND reconciliation, not as actual cash spending.
      const totalDealCost = contribution.available ? fromMinorUnits(contribution.costMinor, orgCurrency) : null;
      if (!included) unknownMarginSaleCount += 1;
      if (economics.supplierSettlement === null) unknownSupplierSettlementSaleCount += 1;
      totalRevenue += recognizedRevenue ?? 0;
      totalCost += totalDealCost ?? 0;
      if (contribution.available) totalProfit += fromMinorUnits(contribution.netMinor, orgCurrency);
      totalGrossTransactionValue += economics.grossTransactionValue;
      totalSupplierSettlement += economics.supplierSettlement ?? 0;
      if (economics.isAgentSale) agentSaleCount += 1;
      if (canSeeCommissions) {
        if (!contribution.available || figure.commissionsTotal === null) commissionIncompleteSaleCount += 1;
        else {
          totalCommissions += figure.commissionsTotal;
          totalNetProfitAfterCommissions += fromMinorUnits(contribution.netMinor, orgCurrency);
        }
      }
      return {
        ...projectSaleRow(sale, role),
        salePrice: figure.salePrice,
        salePriceUnavailableReason: figure.salePriceUnavailableReason,
        currency,
        commissionsTotal: figure.commissionsTotal,
        commissionPending: figure.commissionPending,
        netProfitAfterCommissions: netProfit,
        profitUnavailableReason: profit.available ? null : profit.reason,
        includedInTotals: included,
        vehicleMake: vehicle?.make, vehicleModel: vehicle?.model,
        vehicleYear: vehicle?.year, vehicleVin: vehicle?.vin,
        vehicleCost: figure.vehicleCost,
        totalCost: totalDealCost,
        netProfit,
        isAgentSale: economics.isAgentSale, settlementRoute: economics.settlementRoute,
        grossTransactionValue: economics.grossTransactionValue,
        supplierSettlement: economics.supplierSettlement,
        recognizedRevenue,
      };
    });

    enrichedSales.sort((a, b) => b.saleDate - a.saleDate);

    return {
      figureBasis: "DEAL_MANAGEMENT_NET_V1" as const,
      // Turnover. Excludes the gross of every consigned sale — the dealership
      // never owned those cars and may recognize only its margin on them.
      totalRevenue,
      totalCost,
      totalProfit,
      // Recorded commercial deal volume, separate from customer invoice price
      // and recognized dealership revenue.
      totalGrossTransactionValue,
      // What of that gross belongs to suppliers and never was the dealership's.
      totalSupplierSettlement,
      agentSaleCount,
      /**
       * Rows left out of revenue, costs and profit. These totals describe the
       * included rows only; an excluded deal might make a loss.
       */
      unknownMarginSaleCount,
      /**
       * The same thing for `totalSupplierSettlement`, and deliberately a
       * SEPARATE number. A row can have a known margin and an unknown
       * entitlement, in which case revenue and profit are exact while the
       * supplier total is a floor — one counter cannot say that, and folding
       * the two made the counter above claim exclusions it had not made.
       */
      unknownSupplierSettlementSaleCount,
      /**
       * Employee commissions are already included in management net. Null when the caller lacks view:commissions. The two totals
       * cover only the sales whose margin and commission are both known, and
       * `commissionIncompleteSaleCount` says how many were left out.
       */
      totalCommissions: canSeeCommissions ? totalCommissions : null,
      totalNetProfitAfterCommissions: canSeeCommissions ? totalNetProfitAfterCommissions : null,
      commissionIncompleteSaleCount: canSeeCommissions ? commissionIncompleteSaleCount : null,
      sales: enrichedSales,
    };
  },
});

export const getInventoryReport = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);
    // SCRUM-902: purchase price, sourceCost and total investment per vehicle are acquisition cost. See the sales report.
    if (!(isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE))) return null;

    const rateStatus = await rateLimiter.check(ctx, "heavyRead");
    if (!rateStatus.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(rateStatus.retryAfter / 1000)}s`);
    }

    // Fetch AVAILABLE, RESERVED and SOURCING vehicles via index — avoids
    // scanning sold/archived. SOURCING is included so special-order cars appear
    // in the sourced/committed figure below; they are never part of owned
    // inventory value.
    const [availableVehicles, reservedVehicles, sourcingVehicles] = await Promise.all([
      ctx.db
        .query("vehicles")
        .withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", "AVAILABLE")
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .collect(),
      ctx.db
        .query("vehicles")
        .withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", "RESERVED")
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .collect(),
      ctx.db
        .query("vehicles")
        .withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", "SOURCING")
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .collect(),
    ]);

    const activeInventory = [...availableVehicles, ...reservedVehicles, ...sourcingVehicles];

    // Fetch expenses only for active inventory vehicles
    const expensesByVehicle = new Map<string, any[]>();
    await Promise.all(
      activeInventory.map(async (vehicle) => {
        const exps = await ctx.db
          .query("expenses")
          .withIndex("by_org_vehicle", (q) =>
            q.eq("orgId", args.orgId).eq("vehicleId", vehicle._id)
          )
          .collect();
        expensesByVehicle.set(vehicle._id, exps);
      })
    );

    // Owned stock and sourced (drop-ship) cars are two different things and
    // must not share a total. A SOURCED vehicle is located at another dealer on
    // a customer's behalf: it never enters physical inventory, never posts to
    // Vehicle Inventory (postVehicleAcquisitionIfOwned returns early for it),
    // and on sale credits AP — Vehicle Suppliers. Summing it into "Inventory
    // Value" overstated the org's assets against its own general ledger by the
    // sum of every sourced car's cost, and presented a liability as an asset.
    let ownedValue = 0;
    let sourcedCommitment = 0;
    let ownedCount = 0;
    let sourcedCount = 0;

    const enrichedInventory = activeInventory.map((vehicle) => {
      // Deleted and reversed expenses are not part of a vehicle's cost. The
      // previous sum took every row, so a mistake that was deleted or reversed
      // still inflated reported inventory investment.
      // Supplier-borne costs (SCRUM-389) are a receivable, not investment.
      const expenses = (expensesByVehicle.get(vehicle._id) ?? []).filter(
        (exp) => exp.isDeleted !== true && exp.reversedAt == null && isShowroomBorne(exp)
      );
      const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

      // Mirrors computeVehicleCapitalizedCost (utils/vehicleCost.ts), which is
      // the authoritative basis the GL and commissions use — kept inline rather
      // than called so this report doesn't issue a second expense query per
      // vehicle on top of the one above.
      //
      // This was `landedCostTotal ?? purchasePrice ?? sellingPrice ?? 0`. That
      // is a FALLBACK, but landedCostTotal holds only the landed-cost items
      // (shipping, customs) and is additive to purchasePrice — so any vehicle
      // with landed costs recorded had its entire purchase price dropped from
      // the org's reported inventory value. A 20,000 car with 500 of shipping
      // reported 500, and recording more landed costs made it worse.
      const capitalizedExpenses = expenses
        .filter((exp) => exp.accountingTreatment === "CAPITALIZED_INVENTORY")
        .reduce((sum, exp) => sum + (exp.capitalizedAmount ?? 0), 0);
      const isSourced = vehicle.sourceType === "SOURCED";
      const totalInvestment = isSourced
        ? (vehicle.sourceCost ?? 0)
        : (vehicle.purchasePrice ?? 0) + (vehicle.landedCostTotal ?? 0) + capitalizedExpenses;

      if (isSourced) {
        sourcedCommitment += totalInvestment;
        sourcedCount += 1;
      } else {
        ownedValue += totalInvestment;
        ownedCount += 1;
      }

      return {
        ...vehicle,
        purchasePrice: vehicle.purchasePrice ?? 0,
        totalExpenses,
        totalInvestment,
        isSourced,
      };
    });

    return {
      // Owned stock only. This query now also pulls SOURCING vehicles in, so
      // counting the whole set here would have reported cars still sitting at
      // another dealer as available inventory — the mobile workspace renders
      // this straight into its "Inventory" metric beside the owned-only value.
      availableCount: ownedCount,
      // Everything the report covers, owned and sourced, for callers that want
      // the full active set rather than owned stock.
      activeCount: activeInventory.length,
      ownedCount,
      sourcedCount,
      // Owned stock only — this is the figure that reconciles to the GL's
      // Vehicle Inventory account.
      totalValue: ownedValue,
      // What the dealership will owe source dealers for cars it has committed
      // to but does not own. An obligation, not an asset.
      sourcedCommitment,
      vehicles: enrichedInventory,
    };
  },
});

/**
 * Every expense whose own debit has NOT reached the ledger, and why — keyed by
 * expenseId.
 *
 * The outbox is the whole authority here, and can be, because a PAID expense
 * never has "no GL event at all": hookExpensePosted either posts immediately or
 * durably enqueues (workflowHooks.ts — an org with no chart of accounts enqueues
 * with "No chart of accounts or open period at operation time"), and a drained
 * row is patched to POSTED rather than deleted. So a PENDING/FAILED row here is
 * exactly the set whose debit the income statement does not yet carry, and an
 * expense absent from this map has posted.
 *
 * One indexed scan of the outbox — which is a queue, not a history — rather than
 * a per-expense event lookup, or an org-wide scan of EXPENSE_POSTED, which is
 * the highest-volume event type there is.
 */
async function loadUnpostedExpenseDebitStates(
  ctx: QueryCtx,
  orgId: Id<"organizations">
): Promise<Map<string, RecognitionState>> {
  const byExpenseId = new Map<string, RecognitionState>();
  for (const status of ["PENDING", "FAILED"] as const) {
    const queued = await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
      .collect();
    for (const entry of queued) {
      if (entry.kind !== "POST" || entry.eventType !== "EXPENSE_POSTED") continue;
      // FAILED wins over PENDING: an expense with a dead-lettered debit needs
      // attention even if some other row for it is still waiting its turn.
      if (status === "FAILED" || !byExpenseId.has(entry.sourceId)) {
        byExpenseId.set(entry.sourceId, status === "FAILED" ? "failed" : "pending");
      }
    }
  }
  return byExpenseId;
}

export type GlState = "POSTED" | "CAPITALIZED" | "PENDING" | "FAILED" | "MIXED";

/**
 * The row's headline posting state. Posted is only "posted to the P&L" — a cost
 * capitalized into Vehicle Inventory really did reach the ledger, but as an
 * asset the Income Statement never shows, so it can't be lumped in with expenses
 * that did. MIXED = some posted, some still queued (only a schedule can be it).
 */
function glStateFor(row: {
  postedAmount: number;
  capitalizedAmount: number;
  pendingCount: number;
  failedCount: number;
}): GlState {
  const queued = row.pendingCount + row.failedCount;
  if (queued > 0) {
    const settled = row.postedAmount !== 0 || row.capitalizedAmount !== 0;
    if (settled || (row.pendingCount > 0 && row.failedCount > 0)) return "MIXED";
    return row.failedCount > 0 ? "FAILED" : "PENDING";
  }
  if (row.capitalizedAmount !== 0 && row.postedAmount === 0) return "CAPITALIZED";
  return "POSTED";
}

export const getExpensesReport = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);
    // SCRUM-902: vehicle-linked expenses are landed cost per car. Withheld as a whole (null), as the sales report is.
    if (!(isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE))) return null;

    const rateStatus = await rateLimiter.check(ctx, "heavyRead");
    if (!rateStatus.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(rateStatus.retryAfter / 1000)}s`);
    }

    // The net-of-VAT fallback (a prepaid expense with no schedule row yet) is
    // computed on the same integer minor-unit basis as the GL (see
    // expenseAmortization.ts), so the org currency is required to convert each
    // expense's amount to minor units identically.
    const currency = await getOrgCurrency(ctx, args.orgId);

    // Use index range — avoids collecting ALL org expenses. Only PAID expenses
    // count: a PENDING expense has no GL impact yet, so including it would make
    // this operational P&L disagree with the ledger.
    //
    // A reversed expense is soft-deleted but stays in scope (`reversedAt` set):
    // it really did post to the ledger in its own month, and the ledger still
    // reports it there — the reversing entry is dated separately. Excluding it
    // on isDeleted alone retroactively restated already-posted (and possibly
    // already-closed) months to zero while the income statement kept them. An
    // expense deleted *before* it ever posted has no reversedAt and no GL
    // footprint, so it stays correctly invisible.
    const expensesInDateRange = await ctx.db
      .query("expenses")
      .withIndex("by_org_date", (q) =>
        q.eq("orgId", args.orgId).gte("date", args.startDate)
      )
      .filter((q) =>
        q.and(
          q.lte(q.field("date"), args.endDate),
          q.or(q.neq(q.field("isDeleted"), true), q.neq(q.field("reversedAt"), undefined)),
          q.neq(q.field("status"), "PENDING")
        )
      )
      .collect();

    // Authoritative prepaid schedules for this org — one row per prepaid
    // expense (low-volume: rent/insurance/licences, not per-transaction). The
    // report reads recognition from the schedule's posted GL events (below),
    // not the row's mutable totalMinor/termMonths, so it can never diverge
    // from the GL and a long-term prepaid dated well before the window is
    // still found without an arbitrary date-lookback cap.
    const schedules = await ctx.db
      .query("prepaidExpenseSchedules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const scheduleByExpenseId = new Map(schedules.flatMap((schedule) =>
      schedule.kind === "OPENING" ? [] : [[schedule.expenseId, schedule] as const]));
    const openingSources = new Map<string, { title: string; basisDate: number }>();
    for (const schedule of schedules) {
      const source = await resolvePrepaidScheduleSource(ctx, args.orgId, schedule._id);
      if (source.kind === "UNAVAILABLE") throw new ConvexError(source.reason);
      if (source.kind === "OPENING") openingSources.set(schedule._id, source);
    }
    const recognitionEvents = await loadOrgPrepaidRecognitionByMonth(ctx, args.orgId, args.startDate, args.endDate);
    const unpostedExpenseDebits = await loadUnpostedExpenseDebitStates(ctx, args.orgId);

    // Any status, INCLUDING CANCELLED: cancellation only stops future
    // recognition, it never un-happens history. A cancelled schedule's
    // already-posted months (and an accelerated write-off's own month) must
    // keep showing up in the report they originally posted into, so it always
    // stays the event path — never the expense-doc fallback, which would
    // double count months the schedule already reported before cancellation.
    const scheduledRecognitionFor = (exp: Doc<"expenses">) => {
      const schedule = scheduleByExpenseId.get(exp._id);
      return exp.isPrepaid && schedule ? schedule : null;
    };

    // A PREPAID expense (e.g. 6 months of rent paid up front) recognizes only
    // 1/6th per month, so its `date` — the day it was paid — can fall well
    // before this report's startDate while it's still amortizing into this
    // window. The range query above only sees expenses dated inside the window,
    // so pull each still-amortizing prior expense two ways, deduped by id:
    //   (1) every non-cancelled schedule (authoritative, uncapped), and
    //   (2) a bounded lookback for prepaid expenses that have NO schedule row
    //       (legacy / not-yet-backfilled) — the net-of-VAT fallback.
    const inRangeIds = new Set(expensesInDateRange.map((e) => e._id));
    const priorById = new Map<Id<"expenses">, Doc<"expenses">>();

    for (const schedule of schedules) {
      if (schedule.kind === "OPENING") continue;
      if (inRangeIds.has(schedule.expenseId)) continue;
      // `=== 0`, not `<= 0`: a window holding only this schedule's reversal nets
      // negative and still has to report that credit.
      if (
        recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency) === 0
      ) {
        continue;
      }
      const exp = await ctx.db.get(schedule.expenseId);
      if (exp && (exp.isDeleted !== true || exp.reversedAt !== undefined)) priorById.set(exp._id, exp);
    }

    const priorUnscheduledPrepaid = await ctx.db
      .query("expenses")
      .withIndex("by_org_date", (q) =>
        q.eq("orgId", args.orgId).gte("date", args.startDate - PREPAID_LOOKBACK_MS)
      )
      .filter((q) =>
        q.and(
          q.lt(q.field("date"), args.startDate),
          q.eq(q.field("isPrepaid"), true),
          q.or(q.neq(q.field("isDeleted"), true), q.neq(q.field("reversedAt"), undefined)),
          q.neq(q.field("status"), "PENDING")
        )
      )
      .collect();
    for (const exp of priorUnscheduledPrepaid) {
      // A scheduled prepaid (any status) is handled above via its GL events;
      // skip anything with a schedule row so it's never double-counted here.
      if (scheduleByExpenseId.has(exp._id) || inRangeIds.has(exp._id) || priorById.has(exp._id)) continue;
      if (recognizedAmountInRangeWithReversal(exp, args.startDate, args.endDate, currency) === 0) continue;
      priorById.set(exp._id, exp);
    }

    // An expense dated before this window but REVERSED inside it: the reversing
    // credit belongs in this window, yet a `by_org_date` range scan can never
    // reach the row (its own date is far behind startDate). Indexed on
    // reversedAt, so the cost is proportional to reversals in the window, not to
    // history. Scheduled prepaids are skipped — their reversal already arrives
    // through the GL-event path above.
    const reversedIntoWindow = await ctx.db
      .query("expenses")
      .withIndex("by_org_reversedAt", (q) =>
        q.eq("orgId", args.orgId).gte("reversedAt", args.startDate).lte("reversedAt", args.endDate)
      )
      .collect();
    for (const exp of reversedIntoWindow) {
      if (scheduleByExpenseId.has(exp._id) || inRangeIds.has(exp._id) || priorById.has(exp._id)) continue;
      if (exp.status === "PENDING") continue;
      if (recognizedAmountInRangeWithReversal(exp, args.startDate, args.endDate, currency) === 0) continue;
      priorById.set(exp._id, exp);
    }

    // SCRUM-389: a supplier-borne cost posts Dr Receivable from Suppliers, not
    // an expense account, so the ledger this report mirrors never holds it.
    const allExpenses: Doc<"expenses">[] = [...expensesInDateRange, ...priorById.values()].filter(isShowroomBorne);

    let totalExpenses = 0;

    const vehicleIds = Array.from(
      new Set(allExpenses.map(e => e.vehicleId).filter(Boolean))
    ) as Id<"vehicles">[];
    const vehicles = await Promise.all(vehicleIds.map(id => ctx.db.get(id)));
    const vehicleMap = new Map(
      vehicles.filter((v): v is NonNullable<typeof v> => v !== null).map(v => [v._id, v])
    );

    let totalPosted = 0;
    let totalCapitalized = 0;
    let totalPending = 0;
    let totalFailed = 0;
    let pendingEntryCount = 0;
    let failedEntryCount = 0;

    const enrichedExpenses = allExpenses.map((exp) => {
      // Prefer the authoritative schedule's own GL events; fall back to the
      // net-of-VAT expense doc only for a prepaid expense that has no
      // schedule row yet.
      const schedule = scheduledRecognitionFor(exp);
      const recognizedAmount = schedule
        ? recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency)
        : recognizedAmountInRangeWithReversal(exp, args.startDate, args.endDate, currency);

      // How much of this row the ledger has taken, and where. A cost capitalized
      // into Vehicle Inventory posted for real but hit an ASSET account the
      // Income Statement never shows — so it is its own bucket, not "posted",
      // which here means "posted to the P&L". Otherwise the all-clear below
      // would call a repair sitting in inventory reconciled against a P&L that
      // never mentions it. A prepaid schedule is never capitalized (the two
      // treatments are mutually exclusive — classifyExpensePosting), so the
      // capitalized bucket only ever applies on the single-debit path.
      let postedAmount = 0;
      let capitalizedAmount = 0;
      let pendingAmount = 0;
      let failedAmount = 0;
      let rowPendingCount = 0;
      let rowFailedCount = 0;
      if (schedule) {
        postedAmount = recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency, "posted");
        pendingAmount = recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency, "pending");
        failedAmount = recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency, "failed");
        const counts = queuedEntryCountsInRange(recognitionEvents, schedule._id, args.startDate, args.endDate);
        rowPendingCount = counts.pending;
        rowFailedCount = counts.failed;
      } else {
        const debitState = unpostedExpenseDebits.get(exp._id.toString());
        const capitalized = exp.accountingTreatment === "CAPITALIZED_INVENTORY";
        if (debitState === "pending") {
          pendingAmount = recognizedAmount;
          rowPendingCount = 1;
        } else if (debitState === "failed") {
          failedAmount = recognizedAmount;
          rowFailedCount = 1;
        } else if (capitalized) {
          capitalizedAmount = recognizedAmount;
        } else {
          postedAmount = recognizedAmount;
        }
      }
      totalPosted += postedAmount;
      totalCapitalized += capitalizedAmount;
      totalPending += pendingAmount;
      totalFailed += failedAmount;
      pendingEntryCount += rowPendingCount;
      failedEntryCount += rowFailedCount;

      totalExpenses += recognizedAmount;
      let vehicleDesc = "General";

      if (exp.vehicleId) {
        const vehicle = vehicleMap.get(exp.vehicleId);
        if (vehicle) {
          vehicleDesc = `${vehicle.year} ${vehicle.make} ${vehicle.model} (${vehicle.vin})`;
        }
      }

      return {
        ...exp,
        sourceKind: "EXPENSE" as const,
        vehicleDesc,
        recognizedAmount,
        postedAmount,
        capitalizedAmount,
        pendingAmount,
        failedAmount,
        glState: glStateFor({ postedAmount, capitalizedAmount, pendingCount: rowPendingCount, failedCount: rowFailedCount }),
        amortization: schedule
          ? amortizationInfoFromScheduleProgress(schedule)
          : computeAmortizationInfo(exp, args.endDate, currency),
      };
    });

    // Opening recognition has a real schedule/event source, never a fabricated
    // paid expense. Keep its identity explicit in the shared report row union.
    const openingExpenses = schedules.flatMap((schedule) => {
      const source = openingSources.get(schedule._id);
      if (!source) return [];
      const recognizedAmount = recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency);
      const counts = queuedEntryCountsInRange(recognitionEvents, schedule._id, args.startDate, args.endDate);
      if (recognizedAmount === 0 && counts.pending === 0 && counts.failed === 0) return [];
      const postedAmount = recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency, "posted");
      const pendingAmount = recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency, "pending");
      const failedAmount = recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency, "failed");
      totalExpenses += recognizedAmount;
      totalPosted += postedAmount;
      totalPending += pendingAmount;
      totalFailed += failedAmount;
      pendingEntryCount += counts.pending;
      failedEntryCount += counts.failed;
      return [{ sourceKind: "OPENING" as const, _id: schedule._id, title: source.title,
        notes: source.title, category: schedule.expenseSystemKey, date: source.basisDate,
        currency: schedule.currency, amount: fromMinorUnits(schedule.totalMinor, schedule.currency),
        vehicleDesc: "General", recognizedAmount, postedAmount, pendingAmount, failedAmount,
        capitalizedAmount: 0, glState: glStateFor({ postedAmount, capitalizedAmount: 0, pendingCount: counts.pending, failedCount: counts.failed }),
        amortization: amortizationInfoFromScheduleProgress(schedule) }];
    });
    const reportExpenses = [...enrichedExpenses, ...openingExpenses].sort((a, b) => b.date - a.date);

    return {
      // The operational figure — what the schedules and expense rows say
      // happened this window, posted or not, expense or capitalized. Kept as-is
      // so it stays the single number this report has always meant, with the
      // split beside it rather than silently redefining it. It equals
      // totalPosted + totalCapitalized + totalPending + totalFailed.
      totalExpenses,
      // What reached a P&L expense account — the only bucket the ledger-backed
      // Income Statement can equal, and only when nothing else is outstanding.
      totalPosted,
      // Posted, but to Vehicle Inventory (an asset) — real GL, never on the P&L.
      totalCapitalized,
      totalPending,
      totalFailed,
      // Counts, not amounts: whether anything is still unresolved must not ride
      // on a signed monetary net that two offsetting queued entries cancel.
      pendingEntryCount,
      failedEntryCount,
      hasUnpostedEntries: pendingEntryCount + failedEntryCount > 0,
      expenses: reportExpenses,
    };
  },
});

export const getSalespersonPerformance = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);
    // SCRUM-902: per-rep profit is revenue less acquisition cost. Withheld as a whole (null), as the sales report is.
    if (!(isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE))) return null;
    const canSeeCommissions =
      isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COMMISSIONS);

    const rateStatus = await rateLimiter.check(ctx, "heavyRead");
    if (!rateStatus.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(rateStatus.retryAfter / 1000)}s`);
    }

    assertReportRange(args.startDate, args.endDate);

    // Both bounds belong in the index range. With only `gte(startDate)` indexed
    // and `lte(endDate)` in .filter(), the scan was proportional to everything
    // sold AFTER startDate — a one-day report on an old date walked the org's
    // entire subsequent sales history before discarding almost all of it.
    const salesInDateRange = await ctx.db
      .query("sales")
      .withIndex("by_org_saleDate", (q) =>
        q
          .eq("orgId", args.orgId)
          .gte("saleDate", args.startDate)
          .lte("saleDate", args.endDate)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "COMPLETED"),
          q.neq(q.field("isDeleted"), true)
        )
      )
      .take(MAX_REPORT_SALES + 1);

    const salesBySalesperson: Record<string, Doc<"sales">[]> = {};
    for (const sale of salesInDateRange) {
      if (sale.salespersonId) {
        if (!salesBySalesperson[sale.salespersonId]) {
          salesBySalesperson[sale.salespersonId] = [];
        }
        salesBySalesperson[sale.salespersonId].push(sale);
      }
    }

    const userIds = Object.keys(salesBySalesperson) as Id<"users">[];
    const users = await Promise.all(userIds.map((id) => ctx.db.get(id)));
    const userMap = new Map(users.flatMap((user) => user ? [[user._id, user] as const] : []));
    const orgCurrency = await getOrgCurrency(ctx, args.orgId);
    const figures = await loadReportDealFigures(ctx, {
      orgId: args.orgId, sales: salesInDateRange, orgCurrency, mayReadCommissions: canSeeCommissions,
      mayReadFinance: isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_FINANCE),
    });
    const figuresBySale = new Map(figures.map((figure) => [figure.sale._id, figure]));

    const result = Object.entries(salesBySalesperson).map(([userId, userSales]) => {
      let totalRevenue = 0;
      let totalProfit = 0;
      let totalGrossTransactionValue = 0;
      // Same rule as getSalesAndProfitReport: a rep is never ranked on an
      // earning nobody can substantiate, and never on an implicit zero either.
      let unknownMarginSaleCount = 0;
      // Employee commissions on the rep's deals (display only). Sales whose
      // margin or salesperson commission is unknown are counted, not zeroed.
      let totalCommissions = 0;
      let totalNetProfitAfterCommissions = 0;
      let commissionIncompleteSaleCount = 0;

      const user = userMap.get(userId as Id<"users">);
      const userName = (user && "name" in user ? user.name : null) ?? "Unknown";

      for (const sale of userSales) {
        const figure = figuresBySale.get(sale._id);
        if (!figure) throw new Error("Missing report sale figure");
        const { economics } = figure;
        const contribution = reportContributionFor(figure, orgCurrency);
        if (!contribution.available) unknownMarginSaleCount += 1;
        else {
          totalRevenue += fromMinorUnits(contribution.revenueMinor, orgCurrency);
          totalProfit += fromMinorUnits(contribution.netMinor, orgCurrency);
        }
        totalGrossTransactionValue += economics.grossTransactionValue;
        if (canSeeCommissions) {
          if (!contribution.available || figure.commissionsTotal === null) commissionIncompleteSaleCount += 1;
          else {
            totalCommissions += figure.commissionsTotal;
            totalNetProfitAfterCommissions += fromMinorUnits(contribution.netMinor, orgCurrency);
          }
        }
      }

      return {
        userId,
        figureBasis: "DEAL_MANAGEMENT_NET_V1" as const,
        userName,
        vehiclesSold: userSales.length,
        totalRevenue,
        totalProfit,
        totalGrossTransactionValue,
        /** Of `vehiclesSold`, how many contributed nothing because their earning is unknown. */
        unknownMarginSaleCount,
        /**
         * Whether `totalRevenue` and `totalProfit` account for every sale in
         * `vehiclesSold`, or only for the ones whose earning could be
         * established.
         *
         * `false` makes the row's two halves legible: the count is over ALL the
         * rep's sales and the money is over a subset, and without this the
         * table shows them side by side as one complete statement.
         */
        marginComplete: unknownMarginSaleCount === 0,
        totalCommissions: canSeeCommissions ? totalCommissions : null,
        totalNetProfitAfterCommissions: canSeeCommissions ? totalNetProfitAfterCommissions : null,
        commissionIncompleteSaleCount: canSeeCommissions ? commissionIncompleteSaleCount : null,
      };
    });

    /**
     * Complete rows ranked by profit; incomplete rows after all of them.
     *
     * The incomplete ones are NOT ranked among the others, because the number
     * that would rank them is missing a sale — a rep whose known-only profit is
     * larger than a colleague's complete total was placed above them, which is
     * a claim about who earned more that the data does not support. Ordering
     * them by profit *within* their own group would make the same claim on a
     * smaller stage, so they are ordered by name instead: a list, not a ranking.
     */
    return result.sort((a, b) => {
      if (a.marginComplete !== b.marginComplete) return a.marginComplete ? -1 : 1;
      if (!a.marginComplete) return a.userName.localeCompare(b.userName);
      return b.totalProfit - a.totalProfit;
    });
  },
});

export const getLeadConversionReport = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);

    const rateStatus = await rateLimiter.check(ctx, "heavyRead");
    if (!rateStatus.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(rateStatus.retryAfter / 1000)}s`);
    }

    // No compound index on creationTime — scan up to 50 000 rows and filter
    // in memory. The response includes a `truncated` flag so the UI can warn
    // users when the org has more leads than the cap.
    const LEAD_SCAN_LIMIT = 50_000;
    const allLeads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(LEAD_SCAN_LIMIT);
    const leadScanTruncated = allLeads.length === LEAD_SCAN_LIMIT;

    const leadsInDateRange = allLeads.filter(
      (lead) =>
        lead._creationTime >= args.startDate && lead._creationTime <= args.endDate
    );

    const stageCounts: Record<string, number> = {
      NEW: 0, CONTACTED: 0, INTERESTED: 0, TEST_DRIVE: 0,
      NEGOTIATION: 0, RESERVED: 0, WON: 0, LOST: 0,
    };

    const totalLeads = leadsInDateRange.length;
    let wonLeads = 0;

    for (const lead of leadsInDateRange) {
      stageCounts[lead.stage] = (stageCounts[lead.stage] || 0) + 1;
      if (lead.stage === "WON") wonLeads++;
    }

    const overallConversionRate = totalLeads > 0 ? (wonLeads / totalLeads) * 100 : 0;

    const leadsBySalesperson: Record<string, { total: number; won: number }> = {};
    for (const lead of leadsInDateRange) {
      if (lead.assignedUserId) {
        if (!leadsBySalesperson[lead.assignedUserId]) {
          leadsBySalesperson[lead.assignedUserId] = { total: 0, won: 0 };
        }
        leadsBySalesperson[lead.assignedUserId].total++;
        if (lead.stage === "WON") leadsBySalesperson[lead.assignedUserId].won++;
      }
    }

    const userIds = Array.from(new Set(Object.keys(leadsBySalesperson))) as Id<"users">[];
    const users = await Promise.all(userIds.map(id => ctx.db.get(id)));
    const userMap = new Map(
      users.filter((u): u is NonNullable<typeof u> => u !== null).map(u => [u._id, u])
    );

    const salespersonMetrics = Object.entries(leadsBySalesperson).map(([userId, stats]) => {
      const user = userMap.get(userId as Id<"users">);
      const userName = (user && "name" in user ? user.name : null) ?? "Unknown";
      const conversionRate = stats.total > 0 ? (stats.won / stats.total) * 100 : 0;

      return { userId, userName, totalLeads: stats.total, wonLeads: stats.won, conversionRate };
    });

    salespersonMetrics.sort((a, b) => b.conversionRate - a.conversionRate);

    return { totalLeads, wonLeads, overallConversionRate, stageCounts, salespersonMetrics, truncated: leadScanTruncated };
  },
});

async function journalAccountType(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  accountId: Id<"chartOfAccounts">,
  accountTypes: Map<Id<"chartOfAccounts">, string>
): Promise<string> {
  const cached = accountTypes.get(accountId);
  if (cached !== undefined) return cached;
  const account = await ctx.db.get(accountId);
  if (!account || account.orgId !== orgId) {
    throw new ConvexError("Financial report is unavailable because a journal account is missing.");
  }
  accountTypes.set(accountId, account.type);
  return account.type;
}

async function readForfeitureJournalLines(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  event: Doc<"accountingEvents">,
  errorMessage: string
): Promise<Doc<"journalLines">[]> {
  const entry = event.journalEntryId ? await ctx.db.get(event.journalEntryId) : null;
  if (
    !entry || entry.orgId !== orgId || entry.accountingEventId !== event._id ||
    entry.accountingDate !== event.accountingDate ||
    (entry.status !== "POSTED" && entry.status !== "REVERSED")
  ) {
    throw new ConvexError(errorMessage);
  }
  return ctx.db.query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
    .collect();
}

/** Read forfeiture income from posted journals, including dated reversals. */
async function readDepositForfeitureIncome(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  startDate: number,
  endDate: number
) {
  const [forfeitures, reversals] = await Promise.all(
    (["DEPOSIT_FORFEITED", "JOURNAL_REVERSAL"] as const).map((eventType) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org_eventType_date", (q) =>
          q.eq("orgId", orgId).eq("eventType", eventType)
            .gte("accountingDate", startDate).lte("accountingDate", endDate)
        )
        .collect()
    )
  );
  const accountTypes = new Map<Id<"chartOfAccounts">, string>();
  const minorByCurrency = new Map<string, number>();
  for (const event of [...forfeitures, ...reversals]) {
    if (event.status !== "POSTED" && event.status !== "REVERSED") continue;

    // A reversal of a reversal remains part of the same economic lineage.
    // Resolve it through immutable event links, not the account's CURRENT
    // systemKey: chart repair can clear that key on historical account rows.
    let original = event;
    const seen = new Set<Id<"accountingEvents">>();
    for (let depth = 0; depth < 32; depth++) {
      if (original.eventType !== "JOURNAL_REVERSAL") break;
      if (!original.reversalOfEventId || seen.has(original._id)) {
        throw new ConvexError("Financial report is unavailable because reversal history is incomplete.");
      }
      seen.add(original._id);
      const parent = await ctx.db.get(original.reversalOfEventId);
      if (!parent || parent.orgId !== orgId) {
        throw new ConvexError("Financial report is unavailable because reversal history is incomplete.");
      }
      original = parent;
    }
    if (original.eventType === "JOURNAL_REVERSAL") {
      throw new ConvexError("Financial report is unavailable because reversal history is incomplete.");
    }
    if (original.eventType !== "DEPOSIT_FORFEITED") continue;

    const lines = await readForfeitureJournalLines(
      ctx, orgId, event, "Financial report is unavailable because a posted journal is incomplete."
    );
    let incomeLines = 0;
    for (const line of lines) {
      if (line.orgId !== orgId || line.accountingDate !== event.accountingDate || line.currency !== event.currency) {
        throw new ConvexError("Financial report is unavailable because a posted journal is inconsistent.");
      }
      const accountType = await journalAccountType(ctx, orgId, line.accountId, accountTypes);
      if (accountType !== "OTHER_INCOME") continue;
      incomeLines++;
      minorByCurrency.set(
        line.currency,
        (minorByCurrency.get(line.currency) ?? 0) + line.creditMinor - line.debitMinor
      );
    }
    if (incomeLines === 0) {
      throw new ConvexError("Financial report is unavailable because forfeiture income was not posted.");
    }
  }
  const orgCurrency = await getOrgCurrency(ctx, orgId);
  return {
    amount: fromMinorUnits(minorByCurrency.get(orgCurrency) ?? 0, orgCurrency),
    byCurrency: [...minorByCurrency]
      .map(([currency, amountMinor]) => ({ currency, amount: fromMinorUnits(amountMinor, currency) }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

async function verifyLegacyForfeitureJournal(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: string;
    sourceType: "deposits" | "depositVehicleHolds";
    sourceId: string;
    event: Doc<"accountingEvents">;
    accountTypes: Map<Id<"chartOfAccounts">, string>;
  }
): Promise<void> {
  const { orgId, depositId, sourceType, sourceId, event, accountTypes } = args;
  const payload = event.payload as { depositId?: unknown; holdId?: unknown } | null;
  const validSource = payload?.depositId === depositId &&
    (sourceType === "deposits" || payload?.holdId === sourceId);
  if (!validSource) {
    throw new ConvexError("Financial report is unavailable because forfeiture history is incomplete.");
  }
  const lines = await readForfeitureJournalLines(
    ctx, orgId, event, "Financial report is unavailable because forfeiture history is incomplete."
  );
  let hasPostedIncome = false;
  for (const line of lines) {
    if (line.orgId !== orgId || line.accountingDate !== event.accountingDate || line.currency !== event.currency) {
      throw new ConvexError("Financial report is unavailable because forfeiture history is inconsistent.");
    }
    const accountType = await journalAccountType(ctx, orgId, line.accountId, accountTypes);
    if (accountType === "OTHER_INCOME" && line.creditMinor > line.debitMinor) {
      hasPostedIncome = true;
    }
  }
  if (!hasPostedIncome) {
    throw new ConvexError("Financial report is unavailable because forfeiture income was not posted.");
  }
}

/** A posted forfeiture also takes a linked legacy receipt out of turnover. */
async function readLegacyDepositsTakenOverByForfeiture(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  depositIds: Set<string>
): Promise<Set<string>> {
  const takenOver = new Set<string>();
  if (depositIds.size === 0) return takenOver;
  // The source index answers only for linked receipts in this window. A
  // whole-org forfeiture scan would grow on every report, even for one old row.
  // Bounds fail closed before a partial answer. A normal annual report can
  // contain more than 128 historical receipts even when none was forfeited;
  // keep that ordinary case available while bounding source lookups.
  if (depositIds.size > 512) {
    throw new ConvexError("Financial report is unavailable because legacy receipt history is too large.");
  }
  let sourceQueries = 0;
  let verifiedJournals = 0;
  const accountTypes = new Map<Id<"chartOfAccounts">, string>();
  const hasPostedForfeiture = async (
    depositId: string,
    sourceType: "deposits" | "depositVehicleHolds",
    sourceId: string
  ) => {
    if (++sourceQueries > 2048) {
      throw new ConvexError("Financial report is unavailable because legacy receipt history is too large.");
    }
    const events = await ctx.db.query("accountingEvents")
      .withIndex("by_org_event_source_version", (q) =>
        q.eq("orgId", orgId).eq("eventType", "DEPOSIT_FORFEITED")
          .eq("sourceType", sourceType).eq("sourceId", sourceId)
      )
      .take(33);
    if (events.length > 32) {
      throw new ConvexError("Financial report is unavailable because forfeiture history is too large.");
    }
    let posted = false;
    for (const event of events) {
      if (event.status !== "POSTED" && event.status !== "REVERSED") continue;
      if (++verifiedJournals > 256) {
        throw new ConvexError("Financial report is unavailable because forfeiture history is too large.");
      }
      await verifyLegacyForfeitureJournal(ctx, {
        orgId, depositId, sourceType, sourceId, event, accountTypes,
      });
      posted = true;
    }
    return posted;
  };
  for (const rawId of depositIds) {
    const depositId = ctx.db.normalizeId("deposits", rawId);
    if (!depositId) continue;
    if (await hasPostedForfeiture(rawId, "deposits", rawId)) {
      takenOver.add(rawId);
      continue;
    }
    if (++sourceQueries > 2048) {
      throw new ConvexError("Financial report is unavailable because legacy receipt history is too large.");
    }
    const holds = await ctx.db.query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
      .take(65);
    if (holds.length > 64) {
      throw new ConvexError("Financial report is unavailable because deposit hold history is too large.");
    }
    for (const hold of holds) {
      if (hold.orgId !== orgId) {
        throw new ConvexError("Financial report is unavailable because deposit hold history is inconsistent.");
      }
      if (await hasPostedForfeiture(rawId, "depositVehicleHolds", hold._id.toString())) {
        takenOver.add(rawId);
        break;
      }
    }
  }
  return takenOver;
}

export const getProfitAndLoss = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);
    // SCRUM-902: cost of goods sold and gross profit are acquisition-cost figures. Withheld as a whole (null), never
    // zeroed, and never thrown, like the sibling reports above.
    if (!(isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE))) return null;

    const rateStatus = await rateLimiter.check(ctx, "heavyRead");
    if (!rateStatus.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(rateStatus.retryAfter / 1000)}s`);
    }

    // Use index range — avoids collecting ALL org transactions
    const txInDateRange = await ctx.db
      .query("transactions")
      .withIndex("by_org_date", (q) =>
        q.eq("orgId", args.orgId).gte("date", args.startDate)
      )
      .filter((q) => q.lte(q.field("date"), args.endDate))
      .collect();

    let totalRevenue = 0;
    let costOfGoodsSold = 0;
    let operatingExpenses = 0;
    // Reported beside turnover rather than folded into it: the dealership did
    // handle these deals at full ticket, and that is worth knowing — it is just
    // not its revenue.
    let grossTransactionValue = 0;

    // Revenue: only explicit sale and deposit receipts.
    // COLLECTION_PAYMENT is an installment against an existing receivable — the
    // matching VEHICLE_SALE transaction already recognised the full sale price,
    // so counting COLLECTION_PAYMENT as additional revenue would double-count.
    // Generic type="IN" rows (e.g. CLAIM_PAYMENT, REFUND-in) are also excluded.
    const REVENUE_CATEGORIES = new Set(["VEHICLE_SALE", "DEPOSIT"]);

    // Legacy عربون receipts that a completed sale has since taken over.
    //
    // A deposit taken BEFORE recognition was separated from cash movement was
    // booked as revenue on arrival and carries no `excludedFromRevenue` flag.
    // Once its sale completes under the new rule, that sale recognizes the FULL
    // amount it earned — so leaving the old receipt in revenue would count the
    // same money twice, and deducting it from the sale instead would leave BOTH
    // periods wrong (revenue in the deposit's month for a car nobody had sold,
    // and a short month for the sale). It is dropped here, at read time,
    // without rewriting a historical row.
    //
    // The relationship must be AUTHORITATIVE: an application row tying this
    // deposit to a real sale. Never a matching vehicle, customer, amount or
    // nearby date — a receipt that merely looks like it belongs to a sale is
    // exactly what the follow-up correction PR exists to adjudicate.
    //
    // One query for the whole report rather than a lookup per transaction.
    const legacyDepositsTakenOverBySale = new Set<string>();
    {
      // Bounded like every other scan in this file. Past the cap a legacy
      // receipt simply keeps its old treatment, which is the same answer the
      // report gives today — short of the correction, never short of revenue.
      //
      // Held BELOW the platform's per-execution document limit, deliberately.
      // At 50,000 that graceful degradation was unreachable: the function
      // would exceed the limit and throw first, so the report returned nothing
      // at all instead of the slightly-stale answer described above — and this
      // scan runs on top of the transactions read below, not instead of it.
      // A cap that only takes effect after the runtime has already given up is
      // not a cap.
      const REPORT_SCAN_CAP = 8_000;
      const applications = await ctx.db
        .query("depositApplications")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(REPORT_SCAN_CAP);
      for (const app of applications) {
        // EVERY status, reversals included.
        //
        // Skipping REVERSED resurrected the original receipt as revenue when a
        // sale was later cancelled: January booked 300, February recognised the
        // full sale, and cancelling in March put January's 300 back. Cancelling
        // a sale returns the money to the deposit liability — it does not make
        // a receipt from two months earlier into earned revenue, and a
        // cancellation is not a recognition event.
        //
        // Once a legacy receipt has entered an authoritative application
        // lifecycle it stays out of revenue permanently. What happens next is
        // decided by the disposition, on the disposition's own date: still held
        // is a liability, a refund is not revenue, and a re-application means
        // that sale recognises its own full revenue.
        //
        // Forfeiture is dated to its own posted journal below. The deposit
        // receipt remains excluded from turnover even after disposition.
        legacyDepositsTakenOverBySale.add(app.depositId);
      }
    }

    // A direct forfeiture has no depositApplication row. Its posted journal
    // takes over the same linked receipt, even when the two dates fall in
    // different reporting windows. A later reversal restores the liability;
    // it does not make the original cash receipt earned turnover.
    const linkedLegacyReceiptIds = new Set(
      txInDateRange
        .filter((tx) => tx.type === "IN" && !tx.isDeleted && tx.category === "DEPOSIT" &&
          tx.excludedFromRevenue !== true && tx.depositId &&
          !legacyDepositsTakenOverBySale.has(tx.depositId))
        .map((tx) => tx.depositId!.toString())
    );
    const legacyDepositsTakenOverByForfeiture = await readLegacyDepositsTakenOverByForfeiture(
      ctx, args.orgId, linkedLegacyReceiptIds
    );

    for (const tx of txInDateRange) {
      if (tx.isDeleted) continue;
      if (
        tx.category === "DEPOSIT" &&
        tx.excludedFromRevenue !== true &&
        tx.depositId !== undefined &&
        (legacyDepositsTakenOverBySale.has(tx.depositId) ||
          legacyDepositsTakenOverByForfeiture.has(tx.depositId))
      ) {
        continue;
      }
      // Cash received against a liability is not revenue, and a عربون is
      // exactly that. Counting it on arrival, then writing the sale net of it
      // to compensate, only balances when both land in one period: a deposit
      // on 31 January against a sale on 1 February reported revenue in January
      // for a car nobody had sold, and understated February by the same amount.
      // The lifetime total came out right, which is why it survived this long.
      //
      // Scoped to rows that carry the flag, which is only rows written since
      // recognition was separated from cash movement. Excluding every DEPOSIT
      // row would understate the back-book instead, because those sales are
      // still recorded net of what was collected — so history keeps the
      // arithmetic it was written under and reads exactly as it does today.
      // `depositRevenueImpact` measures what correcting it would move.
      if (tx.excludedFromRevenue === true) continue;
      if (tx.type === "IN" && REVENUE_CATEGORIES.has(tx.category ?? "")) {
        // `recognizedRevenueAmount` where the row carries one — a consigned
        // sale, whose gross belongs to the supplier.
        //
        // Where it is absent, `amount` IS the revenue for every owned sale and
        // every deposit, which is the overwhelming majority of rows. It is NOT
        // a safe answer for a consigned sale predating this deploy: those were
        // posted at gross and read as gross here. `migrateConsignedSaleBasis`
        // writes the field onto them, and `sourcedSaleImpactReport` lists the
        // ones it could not — so the remaining overstatement is bounded and
        // enumerable rather than silent. Do not read this fallback as exact.
        totalRevenue += tx.recognizedRevenueAmount ?? tx.amount;
        // Vehicle sales only, at the full ticket. One definition, shared with
        // getSalesAndProfitReport and the dashboard — see
        // utils/grossTransactionValue for why all three have to agree, and for
        // the two ways this used to disagree: DEPOSIT rows were counted as
        // deals, and `amount` is net of anything already collected, so taking a
        // deposit both inflated the figure once and deflated it again.
        if (tx.category === "VEHICLE_SALE") {
          grossTransactionValue += grossTransactionValueForTransaction(tx);
        }
      } else if (tx.type === "IN" && tx.category === "VEHICLE_PURCHASE") {
        // SCRUM-650: a purchase-cost correction that brought cash back. Cash IN, but not revenue:
        // it nets the purchase cost it corrects, so a refund of 2,700 on a 12,500 car reports 9,800.
        if (isShowroomBorne(tx)) costOfGoodsSold -= tx.amount;
      } else if (tx.type === "OUT") {
        // SCRUM-389: a supplier-borne cost is money owed back, never COGS.
        if (!isShowroomBorne(tx)) continue;
        if (tx.category === "VEHICLE_PURCHASE" || (tx.category === "EXPENSE" && tx.vehicleId)) {
          costOfGoodsSold += tx.amount;
        } else if (tx.category === "EXPENSE" && !tx.vehicleId) {
          operatingExpenses += tx.amount;
        }
      }
    }

    // Forfeiture is other income on its POSTED journal date, not turnover on
    // the original deposit receipt date. Include both the original lines and
    // later reversal lines, exactly as the accounting income statement does.
    // The legacy transactions ledger has no row for a forfeiture.
    const forfeitureIncome = await readDepositForfeitureIncome(ctx, args.orgId, args.startDate, args.endDate);

    // Opening schedules have no historical expense/payment transaction. Their
    // operational recognition comes from the same event ledger as the expense
    // report; preserve the legacy transaction treatment for expense-backed rows.
    const prepaidSchedules = await ctx.db.query("prepaidExpenseSchedules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect();
    const prepaidRecognition = await loadOrgPrepaidRecognitionByMonth(ctx, args.orgId, args.startDate, args.endDate);
    let openingPrepaidPendingEntryCount = 0;
    let openingPrepaidFailedEntryCount = 0;
    for (const schedule of prepaidSchedules) {
      const source = await resolvePrepaidScheduleSource(ctx, args.orgId, schedule._id);
      if (source.kind === "UNAVAILABLE") throw new ConvexError(source.reason);
      if (source.kind !== "OPENING") continue;
      operatingExpenses += recognizedAmountInRangeFromEvents(prepaidRecognition, schedule._id,
        args.startDate, args.endDate, schedule.currency);
      const counts = queuedEntryCountsInRange(prepaidRecognition, schedule._id, args.startDate, args.endDate);
      openingPrepaidPendingEntryCount += counts.pending;
      openingPrepaidFailedEntryCount += counts.failed;
    }

    const grossProfit = totalRevenue - costOfGoodsSold;
    const netProfit = grossProfit - operatingExpenses + forfeitureIncome.amount;

    return {
      // Accounting turnover. Excludes the gross of every consigned sale, and so
      // agrees with getSalesAndProfitReport on the same period.
      totalRevenue,
      costOfGoodsSold,
      grossProfit,
      operatingExpenses,
      openingPrepaidPendingEntryCount,
      openingPrepaidFailedEntryCount,
      hasUnpostedOpeningPrepaidEntries: openingPrepaidPendingEntryCount + openingPrepaidFailedEntryCount > 0,
      depositForfeitureIncome: forfeitureIncome.amount,
      depositForfeitureIncomeByCurrency: forfeitureIncome.byCurrency,
      netProfit,
      // Operational KPI, explicitly labelled and deliberately outside turnover.
      grossTransactionValue,
      transactions: txInDateRange.sort((a, b) => b.date - a.date),
    };
  },
});
