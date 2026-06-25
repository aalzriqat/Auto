import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { rateLimiter } from "./rateLimit";

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

    // Use index range — avoids collecting ALL org sales
    const salesInDateRange = await ctx.db
      .query("sales")
      .withIndex("by_org_saleDate", (q) =>
        q.eq("orgId", args.orgId).gte("saleDate", args.startDate)
      )
      .filter((q) => q.lte(q.field("saleDate"), args.endDate))
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

    const enrichedSales = salesInDateRange.map((sale) => {
      const vehicle = vehicleMap.get(sale.vehicleId);
      const expenses = expensesByVehicle.get(sale.vehicleId) ?? [];

      const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
      const vehicleBaseCost = vehicle?.landedCostTotal ?? vehicle?.purchasePrice ?? vehicle?.sellingPrice ?? 0;
      const cost = vehicleBaseCost + totalExpenses;
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
        vehicleCost: vehicleBaseCost,
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

    // Use index range — avoids collecting ALL org expenses
    const expensesInDateRange = await ctx.db
      .query("expenses")
      .withIndex("by_org_date", (q) =>
        q.eq("orgId", args.orgId).gte("date", args.startDate)
      )
      .filter((q) => q.lte(q.field("date"), args.endDate))
      .collect();

    let totalExpenses = 0;

    const vehicleIds = Array.from(
      new Set(expensesInDateRange.map(e => e.vehicleId).filter(Boolean))
    ) as Id<"vehicles">[];
    const vehicles = await Promise.all(vehicleIds.map(id => ctx.db.get(id)));
    const vehicleMap = new Map(
      vehicles.filter((v): v is NonNullable<typeof v> => v !== null).map(v => [v._id, v])
    );

    const enrichedExpenses = expensesInDateRange.map((exp) => {
      totalExpenses += exp.amount;
      let vehicleDesc = "General";

      if (exp.vehicleId) {
        const vehicle = vehicleMap.get(exp.vehicleId);
        if (vehicle) {
          vehicleDesc = `${vehicle.year} ${vehicle.make} ${vehicle.model} (${vehicle.vin})`;
        }
      }

      return { ...exp, vehicleDesc };
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

    // Use index range — avoids collecting ALL org sales
    const salesInDateRange = await ctx.db
      .query("sales")
      .withIndex("by_org_saleDate", (q) =>
        q.eq("orgId", args.orgId).gte("saleDate", args.startDate)
      )
      .filter((q) => q.lte(q.field("saleDate"), args.endDate))
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

    // Fetch expenses only for vehicles in this date range
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
        const vehicle = vehicleMap.get(sale.vehicleId);
        const expenses = expensesByVehicle.get(sale.vehicleId) ?? [];
        const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
        const cost = (vehicle?.landedCostTotal ?? vehicle?.purchasePrice ?? 0) + totalExpenses;
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

    // No _creationTime index — cap at 10 000 rows and filter in memory
    const allLeads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(10000);

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

    return { totalLeads, wonLeads, overallConversionRate, stageCounts, salespersonMetrics };
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

    for (const tx of txInDateRange) {
      if (tx.category === "VEHICLE_SALE" || tx.category === "DEPOSIT" || tx.type === "IN") {
        if (tx.category !== "CAPITAL_INJECTION" && tx.category !== "PARTNER_DRAW") {
          totalRevenue += tx.amount;
        }
      } else if (tx.category === "VEHICLE_PURCHASE" || (tx.category === "EXPENSE" && tx.vehicleId)) {
        costOfGoodsSold += tx.amount;
      } else if (tx.category === "EXPENSE" && !tx.vehicleId) {
        operatingExpenses += tx.amount;
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
