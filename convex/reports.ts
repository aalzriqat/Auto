import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
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

    const statusLimit = await rateLimiter.limit(ctx, "heavyRead", { key: args.orgId });
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded for reports. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const allSales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const salesInDateRange = allSales.filter(
      (sale) => sale.saleDate >= args.startDate && sale.saleDate <= args.endDate
    );

    let totalRevenue = 0;
    let totalCost = 0;
    let totalProfit = 0;

    const vehicleIds = Array.from(new Set(salesInDateRange.map(s => s.vehicleId)));
    const vehicles = await Promise.all(vehicleIds.map(id => ctx.db.get(id)));
    const vehicleMap = new Map(vehicles.filter((v): v is NonNullable<typeof v> => v !== null).map(v => [v._id, v]));

    const allOrgExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const expensesByVehicle = new Map<string, typeof allOrgExpenses>();
    for (const exp of allOrgExpenses) {
      if (!exp.vehicleId) continue;
      const existing = expensesByVehicle.get(exp.vehicleId) || [];
      existing.push(exp);
      expensesByVehicle.set(exp.vehicleId, existing);
    }

    const enrichedSales = salesInDateRange.map((sale) => {
      const vehicle = vehicleMap.get(sale.vehicleId);
      const expenses = expensesByVehicle.get(sale.vehicleId) || [];

      const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

      const cost = (vehicle?.purchasePrice ?? vehicle?.sellingPrice ?? 0) + totalExpenses;
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
        vehicleCost: vehicle?.purchasePrice ?? vehicle?.sellingPrice ?? 0,
        vehicleExpenses: totalExpenses,
        totalCost: cost,
        netProfit: profit,
      };
    });

    // Sort descending by date
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

    const statusLimit = await rateLimiter.limit(ctx, "heavyRead", { key: args.orgId });
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded for reports. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const activeInventory = vehicles.filter((v) => v.isDeleted !== true && (v.status === "AVAILABLE" || v.status === "RESERVED"));

    const allOrgExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const expensesByVehicle = new Map<string, typeof allOrgExpenses>();
    for (const exp of allOrgExpenses) {
      if (!exp.vehicleId) continue;
      const existing = expensesByVehicle.get(exp.vehicleId) || [];
      existing.push(exp);
      expensesByVehicle.set(exp.vehicleId, existing);
    }

    let totalValue = 0;

    const enrichedInventory = activeInventory.map((vehicle) => {
      const expenses = expensesByVehicle.get(vehicle._id) || [];

      const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
      const basePrice = vehicle.purchasePrice ?? vehicle.sellingPrice ?? 0;
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

    const statusLimit = await rateLimiter.limit(ctx, "heavyRead", { key: args.orgId });
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded for reports. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const allExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const expensesInDateRange = allExpenses.filter(
      (exp) => exp.date >= args.startDate && exp.date <= args.endDate
    );

    let totalExpenses = 0;

    const vehicleIds = Array.from(new Set(expensesInDateRange.map(e => e.vehicleId).filter(Boolean))) as any[];
    const vehicles = await Promise.all(vehicleIds.map(id => ctx.db.get(id)));
    const vehicleMap = new Map(vehicles.filter((v): v is NonNullable<typeof v> => v !== null).map(v => [v._id, v]));

    const enrichedExpenses = expensesInDateRange.map((exp) => {
      totalExpenses += exp.amount;
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
      };
    });

    // Sort descending by date
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

    const statusLimit = await rateLimiter.limit(ctx, "heavyRead", { key: args.orgId });
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded for reports. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const allSales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const salesInDateRange = allSales.filter(
      (sale) => sale.saleDate >= args.startDate && sale.saleDate <= args.endDate
    );

    // Group sales by salespersonId
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
    const vehicleMap = new Map(vehicles.filter((v): v is NonNullable<typeof v> => v !== null).map(v => [v._id, v]));

    const allOrgExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const expensesByVehicle = new Map<string, typeof allOrgExpenses>();
    for (const exp of allOrgExpenses) {
      if (!exp.vehicleId) continue;
      const existing = expensesByVehicle.get(exp.vehicleId) || [];
      existing.push(exp);
      expensesByVehicle.set(exp.vehicleId, existing);
    }

    const userIds = Array.from(new Set(Object.keys(salesBySalesperson))) as any[];
    const users = await Promise.all(userIds.map(id => ctx.db.get(id)));
    const userMap = new Map(users.filter((u): u is NonNullable<typeof u> => u !== null).map(u => [u._id, u]));

    const result = Object.entries(salesBySalesperson).map(([userId, userSales]) => {
      let totalRevenue = 0;
      let totalProfit = 0;

      let userName = "Unknown";
      const user = userMap.get(userId as any);
      if (user && "name" in user) {
        userName = user.name || "Unknown";
      }

      for (const sale of userSales) {
        const vehicle = vehicleMap.get(sale.vehicleId);
        const expenses = expensesByVehicle.get(sale.vehicleId) || [];

        const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
        const cost = ((vehicle as any)?.purchasePrice || 0) + totalExpenses;
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

    // Sort by profit descending
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

    const statusLimit = await rateLimiter.limit(ctx, "heavyRead", { key: args.orgId });
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded for reports. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const allLeads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    // Filter leads created in date range
    const leadsInDateRange = allLeads.filter(
      (lead) => lead._creationTime >= args.startDate && lead._creationTime <= args.endDate
    );

    // Group by Stage
    const stageCounts: Record<string, number> = {
      NEW: 0,
      CONTACTED: 0,
      INTERESTED: 0,
      TEST_DRIVE: 0,
      NEGOTIATION: 0,
      RESERVED: 0,
      WON: 0,
      LOST: 0,
    };

    let totalLeads = leadsInDateRange.length;
    let wonLeads = 0;

    for (const lead of leadsInDateRange) {
      stageCounts[lead.stage] = (stageCounts[lead.stage] || 0) + 1;
      if (lead.stage === "WON") {
        wonLeads++;
      }
    }

    const overallConversionRate = totalLeads > 0 ? (wonLeads / totalLeads) * 100 : 0;

    // Group by Salesperson
    const leadsBySalesperson: Record<string, { total: number; won: number }> = {};
    for (const lead of leadsInDateRange) {
      if (lead.assignedUserId) {
        if (!leadsBySalesperson[lead.assignedUserId]) {
          leadsBySalesperson[lead.assignedUserId] = { total: 0, won: 0 };
        }
        leadsBySalesperson[lead.assignedUserId].total++;
        if (lead.stage === "WON") {
          leadsBySalesperson[lead.assignedUserId].won++;
        }
      }
    }

    const userIds = Array.from(new Set(Object.keys(leadsBySalesperson))) as any[];
    const users = await Promise.all(userIds.map(id => ctx.db.get(id)));
    const userMap = new Map(users.filter((u): u is NonNullable<typeof u> => u !== null).map(u => [u._id, u]));

    const salespersonMetrics = Object.entries(leadsBySalesperson).map(([userId, stats]) => {
      let userName = "Unknown";
      const user = userMap.get(userId as any);
      if (user && "name" in user) {
        userName = user.name || "Unknown";
      }

      const conversionRate = stats.total > 0 ? (stats.won / stats.total) * 100 : 0;

      return {
        userId,
        userName,
        totalLeads: stats.total,
        wonLeads: stats.won,
        conversionRate,
      };
    });

    // Sort by conversion rate descending
    salespersonMetrics.sort((a, b) => b.conversionRate - a.conversionRate);

    return {
      totalLeads,
      wonLeads,
      overallConversionRate,
      stageCounts,
      salespersonMetrics,
    };
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

    const statusLimit = await rateLimiter.limit(ctx, "heavyRead", { key: args.orgId });
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded for reports. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const txInDateRange = transactions.filter(
      (tx) => tx.date >= args.startDate && tx.date <= args.endDate
    );

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
      transactions: txInDateRange.sort((a, b) => b.date - a.date)
    };
  },
});
