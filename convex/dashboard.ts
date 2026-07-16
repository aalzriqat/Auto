import { v } from "convex/values";
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { validateVinChecksum } from "../lib/vinHelpers";
import { isSystemOwnerRole, PERMISSIONS, type Permission } from "./utils/permissions";

function canRoleView(role: Doc<"roles">, permission: Permission): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(permission);
}

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
    // 1. Authenticate and verify membership, then derive domain visibility.
    const { role } = await requireTenantAuth(ctx, args.orgId);
    const canViewVehicles = canRoleView(role, PERMISSIONS.VIEW_VEHICLES);
    const canViewLeads = canRoleView(role, PERMISSIONS.VIEW_LEADS);
    const canViewUsers = canRoleView(role, PERMISSIONS.VIEW_USERS);
    const canViewTasks = canRoleView(role, PERMISSIONS.VIEW_TASKS);
    const canViewSalesMetrics =
      canRoleView(role, PERMISSIONS.VIEW_SALES) ||
      canRoleView(role, PERMISSIONS.VIEW_REPORTS) ||
      canRoleView(role, PERMISSIONS.VIEW_FINANCE);
    const canViewCostMetrics =
      canRoleView(role, PERMISSIONS.VIEW_EXPENSES) ||
      canRoleView(role, PERMISSIONS.VIEW_REPORTS) ||
      canRoleView(role, PERMISSIONS.VIEW_FINANCE);
    const canViewProfitMetrics = canViewSalesMetrics && canViewCostMetrics;

    const now = Date.now();
    let filterStart = 0;

    if (args.timeRange === "DAY") {
      filterStart = now - 24 * 60 * 60 * 1000;
    } else if (args.timeRange === "MONTH") {
      filterStart = now - 30 * 24 * 60 * 60 * 1000;
    } else if (args.timeRange === "YEAR") {
      filterStart = now - 365 * 24 * 60 * 60 * 1000;
    }

    // 2. Total Vehicles & Available Vehicles
    const VEHICLE_CAP = 2000;
    const vehicleRows = canViewVehicles
      ? await ctx.db
        .query("vehicles")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter(q => q.and(q.neq(q.field("isDeleted"), true), q.neq(q.field("sourceType"), "SOURCED")))
        .take(VEHICLE_CAP)
      : [];
    const totalVehicles = vehicleRows.length;
    const vehiclesTruncated = vehicleRows.length === VEHICLE_CAP;
    const availableVehicles = canViewVehicles
      ? vehicleRows.filter(v => v.status === "AVAILABLE").length
      : 0;

    // 3. Active Leads (not WON/LOST)
    const activeLeads = canViewLeads
      ? await ctx.db
        .query("leads")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter(q => q.and(
          q.neq(q.field("stage"), "WON"),
          q.neq(q.field("stage"), "LOST"),
          q.neq(q.field("isDeleted"), true)
        ))
        .take(1000)
        .then(res => res.length)
      : 0;

    // 4. Sales this period
    let periodSales: Doc<"sales">[] = [];
    if (canViewSalesMetrics) {
      if (filterStart > 0) {
        periodSales = await ctx.db
          .query("sales")
          .withIndex("by_org_saleDate", (q) => q.eq("orgId", args.orgId).gte("saleDate", filterStart))
          .filter(q => q.and(
            q.eq(q.field("status"), "COMPLETED"),
            q.neq(q.field("isDeleted"), true)
          ))
          .collect();
      } else {
        periodSales = await ctx.db
          .query("sales")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .filter(q => q.and(
            q.eq(q.field("status"), "COMPLETED"),
            q.neq(q.field("isDeleted"), true)
          ))
          .take(5000);
      }
    }

    const activeSales = periodSales;

    const transactionCandidates: Doc<"transactions">[] = canViewSalesMetrics
      ? filterStart > 0
          ? await ctx.db
            .query("transactions")
            .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId).gte("date", filterStart))
            .filter(q => q.and(
              q.eq(q.field("category"), "VEHICLE_SALE"),
              q.eq(q.field("type"), "IN"),
              q.neq(q.field("isDeleted"), true)
            ))
            .take(5000)
          : await ctx.db
            .query("transactions")
            .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId))
            .filter(q => q.and(
              q.eq(q.field("category"), "VEHICLE_SALE"),
              q.eq(q.field("type"), "IN"),
              q.neq(q.field("isDeleted"), true)
            ))
            .take(5000)
      : [];
    const saleTransactions = transactionCandidates;

    const SALES_CAP = 5000;
    const salesVolume = activeSales.length > 0
      ? activeSales.reduce((acc, sale) => acc + sale.salePrice, 0)
      : saleTransactions.reduce((acc, transaction) => acc + transaction.amount, 0);
    const salesCount = activeSales.length > 0 ? activeSales.length : saleTransactions.length;
    const salesTruncated = activeSales.length === SALES_CAP || saleTransactions.length === SALES_CAP;

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
    let allExpenses: Doc<"expenses">[] = [];
    if (canViewCostMetrics) {
      if (filterStart > 0) {
        allExpenses = await ctx.db
          .query("expenses")
          .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId).gte("date", filterStart))
          .collect();
      } else {
        allExpenses = await ctx.db
          .query("expenses")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(5000);
      }
    }

    const vehicleExpenses: Record<string, number> = {};
    const generalExpensesByMonth: Record<string, number> = {};
    const totalExpensesByMonth: Record<string, number> = {};

    for (const exp of allExpenses) {

      const key = getChartKey(exp.date);

      if (canViewCostMetrics) {
        totalExpensesByMonth[key] = (totalExpensesByMonth[key] || 0) + exp.amount;
      }

      if (canViewProfitMetrics && exp.vehicleId) {
        vehicleExpenses[exp.vehicleId] = (vehicleExpenses[exp.vehicleId] || 0) + exp.amount;
      } else if (canViewProfitMetrics) {
        generalExpensesByMonth[key] = (generalExpensesByMonth[key] || 0) + exp.amount;
      }
    }

    if (activeSales.length > 0) {
      for (const sale of activeSales) {
        const key = getChartKey(sale.saleDate);

        monthlySales[key] = (monthlySales[key] || 0) + sale.salePrice;

        // Calculate profit if purchase price is available
        const vehicle = await ctx.db.get(sale.vehicleId);
        if (canViewProfitMetrics && vehicle && vehicle.purchasePrice !== undefined) {
          const vehicleCost = vehicle.purchasePrice + (vehicleExpenses[sale.vehicleId] || 0);
          const profit = sale.salePrice - vehicleCost;
          monthlyProfits[key] = (monthlyProfits[key] || 0) + profit;
        }
      }
    } else {
      for (const transaction of saleTransactions) {
        const key = getChartKey(transaction.date);
        monthlySales[key] = (monthlySales[key] || 0) + transaction.amount;
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
    const MEMBERS_CAP = 500;
    const members = canViewUsers
      ? await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(MEMBERS_CAP)
      : [];
    const membersTruncated = members.length === MEMBERS_CAP;

    // 6. Tasks and Team Activity
    // Limit to 1000 most recent to prevent dashboard timeouts on massive orgs
    const tasks = canViewTasks
      ? await ctx.db
        .query("tasks")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .order("desc")
        .take(1000)
      : [];

    const todayStart = new Date().setHours(0, 0, 0, 0);

    let totalTasks = 0;
    let pendingTasks = 0;
    let completedTasks = 0;
    let overdueTasks = 0;

    const memberTaskStats: Record<string, { pending: number, overdue: number, completed: number, name: string, userId: Id<"users">, imageUrl?: string, lastSeenAt?: number }> = {};

    // Batch fetch assignees to prevent N+1 queries
    const assigneeIds = canViewUsers ? Array.from(new Set(tasks.map(t => t.assignedTo))) : [];
    const assignees = await Promise.all(assigneeIds.map(id => ctx.db.get(id)));
    const assigneeMap = Object.fromEntries(
      assignees.filter(Boolean).map(user => [user!._id, { name: user!.name || user!.email || "Unknown", imageUrl: user!.imageUrl }])
    );
    // "Last seen" lives on the per-org membership row, not the user doc.
    const assigneeMemberships = await Promise.all(
      assigneeIds.map((id) =>
        ctx.db
          .query("memberships")
          .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", id))
          .unique()
      )
    );
    const lastSeenMap = Object.fromEntries(
      assigneeIds.map((id, index) => [id, assigneeMemberships[index]?.lastSeenAt])
    );

    for (const task of tasks) {
      totalTasks++;
      const isOverdue = task.status !== "COMPLETED" && task.dueDate < todayStart;

      if (task.status === "COMPLETED") completedTasks++;
      else if (isOverdue) overdueTasks++;
      else pendingTasks++;

      // Track by assignee
      if (canViewUsers) {
        const assigneeId = task.assignedTo;
        if (!memberTaskStats[assigneeId]) {
          const assignee = assigneeMap[assigneeId];
          memberTaskStats[assigneeId] = {
            pending: 0,
            overdue: 0,
            completed: 0,
            name: assignee?.name || "Unknown",
            userId: assigneeId,
            imageUrl: assignee?.imageUrl,
            lastSeenAt: lastSeenMap[assigneeId],
          };
        }
        if (task.status === "COMPLETED") memberTaskStats[assigneeId].completed++;
        else if (isOverdue) memberTaskStats[assigneeId].overdue++;
        else memberTaskStats[assigneeId].pending++;
      }
    }

    const teamTasks = Object.values(memberTaskStats).sort((a, b) => (b.pending + b.overdue) - (a.pending + a.overdue));

    // 7. Top performer — ranked by visible sale revenue in this period
    // (not the task backlog leaderboard above, which tracks a different thing).
    const revenueBySalesperson: Record<string, { revenue: number; deals: number }> = {};
    let topPerformer: { name: string; revenue: number; deals: number; userId: Id<"users">; imageUrl?: string; lastSeenAt?: number } | null = null;
    if (canViewSalesMetrics && canViewUsers) {
      for (const sale of activeSales) {
        const entry = revenueBySalesperson[sale.salespersonId] ?? { revenue: 0, deals: 0 };
        entry.revenue += sale.salePrice;
        entry.deals += 1;
        revenueBySalesperson[sale.salespersonId] = entry;
      }

      const topEntry = Object.entries(revenueBySalesperson).sort((a, b) => b[1].revenue - a[1].revenue)[0];
      if (topEntry) {
        const [salespersonId, { revenue, deals }] = topEntry;
        const salesperson = await ctx.db.get(salespersonId as Id<"users">);
        const salespersonMembership = await ctx.db
          .query("memberships")
          .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", salespersonId as Id<"users">))
          .unique();
        topPerformer = {
          name: salesperson?.name || salesperson?.email || "Unknown",
          revenue,
          deals,
          userId: salespersonId as Id<"users">,
          imageUrl: salesperson?.imageUrl,
          lastSeenAt: salespersonMembership?.lastSeenAt,
        };
      }
    }

    return {
      totalVehicles,
      availableVehicles,
      activeLeads,
      salesThisMonth: salesCount,
      salesVolumeThisMonth: salesVolume,
      teamMembers: members.length,
      salesTrend,
      truncated: {
        vehicles: vehiclesTruncated,
        sales: salesTruncated,
        members: membersTruncated,
      },
      taskStats: {
        total: totalTasks,
        pending: pendingTasks,
        completed: completedTasks,
        overdue: overdueTasks,
      },
      teamTasks,
      topPerformer,
    };
  },
});

/**
 * Surfaces cheap, actionable data-quality gaps for the dashboard nudge card.
 * Bounded scans (`.take(N)`) — this is a count/sample, not a list endpoint.
 */
export const dataQualityStats = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId);
    const canViewCustomers = canRoleView(role, PERMISSIONS.VIEW_CUSTOMERS);
    const canViewVehicles = canRoleView(role, PERMISSIONS.VIEW_VEHICLES);

    const customers = canViewCustomers
      ? await ctx.db
        .query("customers")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .take(2000)
      : [];

    let customersMissingPhone = 0;
    let customersMissingEmail = 0;
    for (const c of customers) {
      if (!c.phone) customersMissingPhone++;
      if (!c.email) customersMissingEmail++;
    }

    const vehicles = canViewVehicles
      ? await ctx.db
        .query("vehicles")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .take(2000)
      : [];

    const vehiclesWithVinWarning = vehicles.filter((v) => v.vin && !validateVinChecksum(v.vin)).length;

    return {
      customersMissingPhone,
      customersMissingEmail,
      vehiclesWithVinWarning,
    };
  },
});
