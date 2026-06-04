import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";

/**
 * Retrieves aggregate statistics for the dashboard.
 * Requires the user to be a member of the organization.
 */
export const stats = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    // 1. Authenticate and verify membership
    await requireTenantAuth(ctx, args.orgId);

    // 2. Total Vehicles & Available Vehicles
    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    
    const availableVehicles = vehicles.filter(v => v.status === "AVAILABLE").length;
    const totalVehicles = vehicles.length;

    // 3. Active Leads (not WON/LOST)
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
      
    const activeLeads = leads.filter(l => l.stage !== "WON" && l.stage !== "LOST").length;

    // 4. Sales this month
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
      
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentSales = sales.filter(s => s.saleDate >= thirtyDaysAgo && s.status !== "CANCELLED");
    const salesVolume = recentSales.reduce((acc, sale) => acc + sale.salePrice, 0);

    // Group sales by month for the chart
    const monthlySales: Record<string, number> = {};
    const monthlyProfits: Record<string, number> = {};
    
    // Process all COMPLETED sales for the charts
    const completedSales = sales.filter(s => s.status === "COMPLETED");
    for (const sale of completedSales) {
      const date = new Date(sale.saleDate);
      const monthYear = `${date.toLocaleString('default', { month: 'short' })} ${date.getFullYear()}`;
      
      monthlySales[monthYear] = (monthlySales[monthYear] || 0) + sale.salePrice;
      
      // Calculate profit if purchase price is available
      const vehicle = await ctx.db.get(sale.vehicleId);
      if (vehicle && vehicle.purchasePrice) {
        const profit = sale.salePrice - vehicle.purchasePrice;
        monthlyProfits[monthYear] = (monthlyProfits[monthYear] || 0) + profit;
      }
    }

    // Convert to array format for Recharts
    const salesTrend = Object.keys(monthlySales).map(key => ({
      name: key,
      Revenue: monthlySales[key],
      Profit: monthlyProfits[key] || 0,
    })).sort((a, b) => {
      // Very basic sort by trying to parse date. In production, we'd use ISO strings for sorting.
      return new Date(a.name).getTime() - new Date(b.name).getTime();
    });

    // 5. Team Members
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    return {
      totalVehicles,
      availableVehicles,
      activeLeads,
      salesThisMonth: recentSales.length,
      salesVolumeThisMonth: salesVolume,
      teamMembers: members.length,
      salesTrend,
    };
  },
});
