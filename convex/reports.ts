import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { Id, Doc } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { rateLimiter } from "./rateLimit";
import {
  computeAmortizationInfo,
  amortizationInfoFromScheduleProgress,
  recognizedAmountInRange,
  PREPAID_LOOKBACK_MS,
} from "./utils/expenseAmortization";
import { loadOrgPrepaidRecognitionByMonth, recognizedAmountInRangeFromEvents } from "./utils/prepaidRecognitionEvents";
import { computeVehicleCapitalizedCost } from "./utils/vehicleCost";
import { getOrgCurrency } from "./accounting/workflowHooks";

export const getSalesAndProfitReport = query({
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

    // Use index range — avoids collecting ALL org sales.
    // Only COMPLETED non-deleted sales are counted.
    const salesInDateRange = await ctx.db
      .query("sales")
      .withIndex("by_org_saleDate", (q) =>
        q.eq("orgId", args.orgId).gte("saleDate", args.startDate)
      )
      .filter((q) =>
        q.and(
          q.lte(q.field("saleDate"), args.endDate),
          q.eq(q.field("status"), "COMPLETED"),
          q.neq(q.field("isDeleted"), true)
        )
      )
      .collect();

    let totalRevenue = 0;
    let totalCost = 0;
    let totalProfit = 0;

    const vehicleIds = Array.from(new Set(salesInDateRange.map(s => s.vehicleId)));
    const vehicles = await Promise.all(vehicleIds.map(id => ctx.db.get(id)));
    const vehicleMap = new Map(
      vehicles.filter((v): v is NonNullable<typeof v> => v !== null).map(v => [v._id, v])
    );

    // Fetch expenses only for vehicles that appear in this date range
    const expensesByVehicle = new Map<string, any[]>();
    await Promise.all(
      vehicleIds.map(async (vehicleId) => {
        const exps = await ctx.db
          .query("expenses")
          .withIndex("by_org_vehicle", (q) =>
            q.eq("orgId", args.orgId).eq("vehicleId", vehicleId)
          )
          .collect();
        expensesByVehicle.set(vehicleId, exps);
      })
    );

    // Single authoritative cost basis — same function the GL (SALE_COMPLETED
    // costMinor) and commission calculation use, so this report can no longer
    // disagree with them about a vehicle's margin. vehicleExpenses stays a
    // broader "all expenses logged against this vehicle" figure for display
    // (it can include non-capitalizable categories like marketing), separate
    // from the authoritative cost/profit below.
    const capitalizedCostByVehicle = new Map<string, number>();
    await Promise.all(
      Array.from(vehicleMap.values()).map(async (vehicle) => {
        capitalizedCostByVehicle.set(vehicle._id, await computeVehicleCapitalizedCost(ctx, vehicle));
      })
    );

    const enrichedSales = salesInDateRange.map((sale) => {
      const vehicle = vehicleMap.get(sale.vehicleId);
      const expenses = expensesByVehicle.get(sale.vehicleId) ?? [];

      const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
      const cost = capitalizedCostByVehicle.get(sale.vehicleId) ?? 0;
      const profit = sale.salePrice - cost;

      totalRevenue += sale.salePrice;
      totalCost += cost;
      totalProfit += profit;

      return {
        ...sale,
        vehicleMake: vehicle?.make,
        vehicleModel: vehicle?.model,
        vehicleYear: vehicle?.year,
        vehicleVin: vehicle?.vin,
        vehicleCost: cost,
        vehicleExpenses: totalExpenses,
        totalCost: cost,
        netProfit: profit,
      };
    });

    enrichedSales.sort((a, b) => b.saleDate - a.saleDate);

    return {
      totalRevenue,
      totalCost,
      totalProfit,
      sales: enrichedSales,
    };
  },
});

export const getInventoryReport = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);

    const rateStatus = await rateLimiter.check(ctx, "heavyRead");
    if (!rateStatus.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(rateStatus.retryAfter / 1000)}s`);
    }

    // Fetch AVAILABLE and RESERVED vehicles via index — avoids scanning sold/archived
    const [availableVehicles, reservedVehicles] = await Promise.all([
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
    ]);

    const activeInventory = [...availableVehicles, ...reservedVehicles];

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

    let totalValue = 0;

    const enrichedInventory = activeInventory.map((vehicle) => {
      const expenses = expensesByVehicle.get(vehicle._id) ?? [];
      const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
      const basePrice = vehicle.landedCostTotal ?? vehicle.purchasePrice ?? vehicle.sellingPrice ?? 0;
      const totalInvestment = basePrice + totalExpenses;

      totalValue += totalInvestment;

      return {
        ...vehicle,
        purchasePrice: basePrice,
        totalExpenses,
        totalInvestment,
      };
    });

    return {
      availableCount: activeInventory.length,
      totalValue,
      vehicles: enrichedInventory,
    };
  },
});

export const getExpensesReport = query({
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

    // The net-of-VAT fallback (a prepaid expense with no schedule row yet) is
    // computed on the same integer minor-unit basis as the GL (see
    // expenseAmortization.ts), so the org currency is required to convert each
    // expense's amount to minor units identically.
    const currency = await getOrgCurrency(ctx, args.orgId);

    // Use index range — avoids collecting ALL org expenses. Only PAID expenses
    // count: a PENDING expense has no GL impact yet, so including it would make
    // this operational P&L disagree with the ledger.
    const expensesInDateRange = await ctx.db
      .query("expenses")
      .withIndex("by_org_date", (q) =>
        q.eq("orgId", args.orgId).gte("date", args.startDate)
      )
      .filter((q) =>
        q.and(
          q.lte(q.field("date"), args.endDate),
          q.neq(q.field("isDeleted"), true),
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
    const scheduleByExpenseId = new Map(schedules.map((s) => [s.expenseId, s]));
    const recognitionEvents = await loadOrgPrepaidRecognitionByMonth(ctx, args.orgId);

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
      if (inRangeIds.has(schedule.expenseId)) continue;
      if (
        recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency) <= 0
      ) {
        continue;
      }
      const exp = await ctx.db.get(schedule.expenseId);
      if (exp && exp.isDeleted !== true) priorById.set(exp._id, exp);
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
          q.neq(q.field("isDeleted"), true),
          q.neq(q.field("status"), "PENDING")
        )
      )
      .collect();
    for (const exp of priorUnscheduledPrepaid) {
      // A scheduled prepaid (any status) is handled above via its GL events;
      // skip anything with a schedule row so it's never double-counted here.
      if (scheduleByExpenseId.has(exp._id) || inRangeIds.has(exp._id) || priorById.has(exp._id)) continue;
      if (recognizedAmountInRange(exp, args.startDate, args.endDate, currency) <= 0) continue;
      priorById.set(exp._id, exp);
    }

    const allExpenses: Doc<"expenses">[] = [...expensesInDateRange, ...priorById.values()];

    let totalExpenses = 0;

    const vehicleIds = Array.from(
      new Set(allExpenses.map(e => e.vehicleId).filter(Boolean))
    ) as Id<"vehicles">[];
    const vehicles = await Promise.all(vehicleIds.map(id => ctx.db.get(id)));
    const vehicleMap = new Map(
      vehicles.filter((v): v is NonNullable<typeof v> => v !== null).map(v => [v._id, v])
    );

    const enrichedExpenses = allExpenses.map((exp) => {
      // Prefer the authoritative schedule's own GL events; fall back to the
      // net-of-VAT expense doc only for a prepaid expense that has no
      // schedule row yet.
      const schedule = scheduledRecognitionFor(exp);
      const recognizedAmount = schedule
        ? recognizedAmountInRangeFromEvents(recognitionEvents, schedule._id, args.startDate, args.endDate, schedule.currency)
        : recognizedAmountInRange(exp, args.startDate, args.endDate, currency);
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
        vehicleDesc,
        recognizedAmount,
        amortization: schedule
          ? amortizationInfoFromScheduleProgress(schedule)
          : computeAmortizationInfo(exp, args.endDate, currency),
      };
    });

    enrichedExpenses.sort((a, b) => b.date - a.date);

    return {
      totalExpenses,
      expenses: enrichedExpenses,
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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);

    const rateStatus = await rateLimiter.check(ctx, "heavyRead");
    if (!rateStatus.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(rateStatus.retryAfter / 1000)}s`);
    }

    // Use index range — avoids collecting ALL org sales.
    // Only COMPLETED non-deleted sales are counted.
    const salesInDateRange = await ctx.db
      .query("sales")
      .withIndex("by_org_saleDate", (q) =>
        q.eq("orgId", args.orgId).gte("saleDate", args.startDate)
      )
      .filter((q) =>
        q.and(
          q.lte(q.field("saleDate"), args.endDate),
          q.eq(q.field("status"), "COMPLETED"),
          q.neq(q.field("isDeleted"), true)
        )
      )
      .collect();

    const salesBySalesperson: Record<string, any[]> = {};
    for (const sale of salesInDateRange) {
      if (sale.salespersonId) {
        if (!salesBySalesperson[sale.salespersonId]) {
          salesBySalesperson[sale.salespersonId] = [];
        }
        salesBySalesperson[sale.salespersonId].push(sale);
      }
    }

    const vehicleIds = Array.from(new Set(salesInDateRange.map(s => s.vehicleId)));
    const vehicles = await Promise.all(vehicleIds.map(id => ctx.db.get(id)));
    const vehicleMap = new Map(
      vehicles.filter((v): v is NonNullable<typeof v> => v !== null).map(v => [v._id, v])
    );

    // Single authoritative cost basis — same function the GL and commission
    // calculation use (see getSalesAndProfitReport above).
    const capitalizedCostByVehicle = new Map<string, number>();
    await Promise.all(
      Array.from(vehicleMap.values()).map(async (vehicle) => {
        capitalizedCostByVehicle.set(vehicle._id, await computeVehicleCapitalizedCost(ctx, vehicle));
      })
    );

    const userIds = Array.from(new Set(Object.keys(salesBySalesperson))) as Id<"users">[];
    const users = await Promise.all(userIds.map(id => ctx.db.get(id)));
    const userMap = new Map(
      users.filter((u): u is NonNullable<typeof u> => u !== null).map(u => [u._id, u])
    );

    const result = Object.entries(salesBySalesperson).map(([userId, userSales]) => {
      let totalRevenue = 0;
      let totalProfit = 0;

      const user = userMap.get(userId as Id<"users">);
      const userName = (user && "name" in user ? user.name : null) ?? "Unknown";

      for (const sale of userSales) {
        const cost = capitalizedCostByVehicle.get(sale.vehicleId) ?? 0;
        const profit = sale.salePrice - cost;

        totalRevenue += sale.salePrice;
        totalProfit += profit;
      }

      return {
        userId,
        userName,
        vehiclesSold: userSales.length,
        totalRevenue,
        totalProfit,
      };
    });

    return result.sort((a, b) => b.totalProfit - a.totalProfit);
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

export const getProfitAndLoss = query({
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

    // Revenue: only explicit sale and deposit receipts.
    // COLLECTION_PAYMENT is an installment against an existing receivable — the
    // matching VEHICLE_SALE transaction already recognised the full sale price,
    // so counting COLLECTION_PAYMENT as additional revenue would double-count.
    // Generic type="IN" rows (e.g. CLAIM_PAYMENT, REFUND-in) are also excluded.
    const REVENUE_CATEGORIES = new Set(["VEHICLE_SALE", "DEPOSIT"]);

    for (const tx of txInDateRange) {
      if (tx.isDeleted) continue;
      if (tx.type === "IN" && REVENUE_CATEGORIES.has(tx.category ?? "")) {
        totalRevenue += tx.amount;
      } else if (tx.type === "OUT") {
        if (tx.category === "VEHICLE_PURCHASE" || (tx.category === "EXPENSE" && tx.vehicleId)) {
          costOfGoodsSold += tx.amount;
        } else if (tx.category === "EXPENSE" && !tx.vehicleId) {
          operatingExpenses += tx.amount;
        }
      }
    }

    const grossProfit = totalRevenue - costOfGoodsSold;
    const netProfit = grossProfit - operatingExpenses;

    return {
      totalRevenue,
      costOfGoodsSold,
      grossProfit,
      operatingExpenses,
      netProfit,
      transactions: txInDateRange.sort((a, b) => b.date - a.date),
    };
  },
});
