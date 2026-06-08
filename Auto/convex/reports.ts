import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

export const getSalesAndProfitReport = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);

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

    const enrichedSales = await Promise.all(
      salesInDateRange.map(async (sale) => {
        const vehicle = await ctx.db.get(sale.vehicleId);

        // Fetch expenses for this vehicle
        const expenses = await ctx.db
          .query("expenses")
          .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", sale.vehicleId))
          .collect();

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
      })
    );

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

    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const activeInventory = vehicles.filter((v) => v.isDeleted !== true && (v.status === "AVAILABLE" || v.status === "RESERVED"));

    let totalValue = 0;

    const enrichedInventory = await Promise.all(
      activeInventory.map(async (vehicle) => {
        // Fetch expenses to get total investment
        const expenses = await ctx.db
          .query("expenses")
          .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", vehicle._id))
          .collect();

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
      })
    );

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

    const allExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const expensesInDateRange = allExpenses.filter(
      (exp) => exp.date >= args.startDate && exp.date <= args.endDate
    );

    let totalExpenses = 0;

    const enrichedExpenses = await Promise.all(
      expensesInDateRange.map(async (exp) => {
        totalExpenses += exp.amount;
        let vehicleDesc = "General";

        if (exp.vehicleId) {
          const vehicle = await ctx.db.get(exp.vehicleId);
          if (vehicle) {
            vehicleDesc = `${vehicle.year} ${vehicle.make} ${vehicle.model} (${vehicle.vin})`;
          }
        }

        return {
          ...exp,
          vehicleDesc,
        };
      })
    );

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

    const result = await Promise.all(
      Object.entries(salesBySalesperson).map(async ([userId, userSales]) => {
        let totalRevenue = 0;
        let totalProfit = 0;

        // Fetch user
        let userName = "Unknown";
        const user = await ctx.db.get(userId as any);
        if (user && "name" in user) {
          userName = user.name || "Unknown";
        }

        // Calculate profit for each sale
        for (const sale of userSales) {
          const vehicle = await ctx.db.get(sale.vehicleId);
          const expenses = await ctx.db
            .query("expenses")
            .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", sale.vehicleId))
            .collect();

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
      })
    );

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

    const salespersonMetrics = await Promise.all(
      Object.entries(leadsBySalesperson).map(async ([userId, stats]) => {
        let userName = "Unknown";
        const user = await ctx.db.get(userId as any);
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
      })
    );

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
