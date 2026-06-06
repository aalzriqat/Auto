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
    timeRange: v.optional(v.union(v.literal("DAY"), v.literal("MONTH"), v.literal("YEAR"), v.literal("ALL_TIME"))),
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

    // 4. Sales this period
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
      
    const now = Date.now();
    let filterStart = 0;
    
    if (args.timeRange === "DAY") {
      filterStart = now - 24 * 60 * 60 * 1000;
    } else if (args.timeRange === "MONTH") {
      filterStart = now - 30 * 24 * 60 * 60 * 1000;
    } else if (args.timeRange === "YEAR") {
      filterStart = now - 365 * 24 * 60 * 60 * 1000;
    }

    const periodSales = sales.filter(s => s.saleDate >= filterStart && s.status !== "CANCELLED");
    const salesVolume = periodSales.reduce((acc, sale) => acc + sale.salePrice, 0);

    const getChartKey = (dateTs: number) => {
      const d = new Date(dateTs);
      if (args.timeRange === "DAY") {
        return d.toLocaleTimeString('default', { hour: 'numeric' }); // Group by hour
      } else if (args.timeRange === "MONTH") {
        return d.toLocaleDateString('default', { month: 'short', day: 'numeric' }); // Group by day
      } else {
        return `${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()}`; // Group by month
      }
    };

    // Group sales by month for the chart
    const monthlySales: Record<string, number> = {};
    const monthlyProfits: Record<string, number> = {};
    
    // Fetch all expenses to deduct from profit
    const allExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const vehicleExpenses: Record<string, number> = {};
    const generalExpensesByMonth: Record<string, number> = {};
    const totalExpensesByMonth: Record<string, number> = {};

    for (const exp of allExpenses) {
      // Only include expenses within the selected time range
      if (exp.date < filterStart) continue;

      const key = getChartKey(exp.date);
      
      totalExpensesByMonth[key] = (totalExpensesByMonth[key] || 0) + exp.amount;

      if (exp.vehicleId) {
        vehicleExpenses[exp.vehicleId] = (vehicleExpenses[exp.vehicleId] || 0) + exp.amount;
      } else {
        generalExpensesByMonth[key] = (generalExpensesByMonth[key] || 0) + exp.amount;
      }
    }

    // Process all COMPLETED sales within the time range for the charts
    const completedSales = periodSales.filter(s => s.status === "COMPLETED");
    for (const sale of completedSales) {
      const key = getChartKey(sale.saleDate);
      
      monthlySales[key] = (monthlySales[key] || 0) + sale.salePrice;
      
      // Calculate profit if purchase price is available
      const vehicle = await ctx.db.get(sale.vehicleId);
      if (vehicle && vehicle.purchasePrice !== undefined) {
        const vehicleCost = vehicle.purchasePrice + (vehicleExpenses[sale.vehicleId] || 0);
        const profit = sale.salePrice - vehicleCost;
        monthlyProfits[key] = (monthlyProfits[key] || 0) + profit;
      }
    }

    // Subtract general operating expenses from the monthly profit
    for (const [monthYear, amount] of Object.entries(generalExpensesByMonth)) {
      monthlyProfits[monthYear] = (monthlyProfits[monthYear] || 0) - amount;
      if (monthlySales[monthYear] === undefined) {
        monthlySales[monthYear] = 0; // Ensure month exists in chart even if no sales occurred
      }
    }

    // Convert to array format for Recharts
    const allMonths = Array.from(new Set([
      ...Object.keys(monthlySales), 
      ...Object.keys(monthlyProfits),
      ...Object.keys(totalExpensesByMonth)
    ]));

    const salesTrend = allMonths.map(key => ({
      name: key,
      Revenue: monthlySales[key] || 0,
      Profit: monthlyProfits[key] || 0,
      Expenses: totalExpensesByMonth[key] || 0,
    })).sort((a, b) => {
      // Very basic sort by trying to parse date. In production, we'd use ISO strings for sorting.
      return new Date(a.name).getTime() - new Date(b.name).getTime();
    });

    // 5. Team Members
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    // 6. Tasks and Team Activity
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const todayStart = new Date().setHours(0,0,0,0);
    
    let totalTasks = 0;
    let pendingTasks = 0;
    let completedTasks = 0;
    let overdueTasks = 0;

    const memberTaskStats: Record<string, { pending: number, overdue: number, completed: number, name: string }> = {};

    for (const task of tasks) {
      totalTasks++;
      const isOverdue = task.status !== "COMPLETED" && task.dueDate < todayStart;
      
      if (task.status === "COMPLETED") completedTasks++;
      else if (isOverdue) overdueTasks++;
      else pendingTasks++;

      // Track by assignee
      const assigneeId = task.assignedTo;
      if (!memberTaskStats[assigneeId]) {
        const assigneeUser = await ctx.db.get(assigneeId);
        const name = assigneeUser ? (assigneeUser.name || assigneeUser.email) : "Unknown";
        memberTaskStats[assigneeId] = { pending: 0, overdue: 0, completed: 0, name };
      }
      if (task.status === "COMPLETED") memberTaskStats[assigneeId].completed++;
      else if (isOverdue) memberTaskStats[assigneeId].overdue++;
      else memberTaskStats[assigneeId].pending++;
    }

    const teamTasks = Object.values(memberTaskStats).sort((a, b) => (b.pending + b.overdue) - (a.pending + a.overdue));

    return {
      totalVehicles,
      availableVehicles,
      activeLeads,
      salesThisMonth: periodSales.length,
      salesVolumeThisMonth: salesVolume,
      teamMembers: members.length,
      salesTrend,
      taskStats: {
        total: totalTasks,
        pending: pendingTasks,
        completed: completedTasks,
        overdue: overdueTasks,
      },
      teamTasks,
    };
  },
});
