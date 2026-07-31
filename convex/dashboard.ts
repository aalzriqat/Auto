import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, PERMISSIONS, type Permission } from "./utils/permissions";
import { computeVehicleCapitalizedCost } from "./utils/vehicleCost";
import {
  ABSENT,
  customersByOrg,
  leadsByOrg,
  LIVE,
  membershipsByOrg,
  OWN_STOCK,
  PRESENT,
  vehicleQualityByOrg,
  vehiclesByOrg,
  VIN_INVALID,
} from "./aggregates";

function canRoleView(role: Doc<"roles">, permission: Permission): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(permission);
}

/**
 * Passed where an aggregate key element should match every value rather than
 * one — see `stringKeyRange`.
 */
const ANY_STATUS = null;
const ANY_STAGE = null;

/**
 * Bounds for one string element of an aggregate sort key: either a single
 * value, or every value.
 *
 * Every `status` and `stage` in the schema is uppercase ASCII, so `""` sorts
 * below all of them and `"￿"` above. Using those as sentinels keeps both
 * ends of the range a *full-length* key, which is what the aging-bucket reads
 * already do with `Number.MIN/MAX_SAFE_INTEGER`. The alternative — a short key
 * that relies on how the B-tree orders `[a, b]` against `[a, b, c]` — is a
 * subtler contract to depend on for the same result.
 */
function stringKeyRange(value: string | null): { from: string; to: string } {
  return { from: value ?? "", to: value ?? "￿" };
}

/** Live, own-stock vehicles in one status (or every status). */
function ownStockBounds(status: string | null) {
  const { from, to } = stringKeyRange(status);
  return {
    lower: {
      key: [LIVE, OWN_STOCK, from, Number.MIN_SAFE_INTEGER] as [number, number, string, number],
      inclusive: true as const,
    },
    upper: {
      key: [LIVE, OWN_STOCK, to, Number.MAX_SAFE_INTEGER] as [number, number, string, number],
      inclusive: true as const,
    },
  };
}

/** Live leads in one stage (or every stage). */
function liveStageBounds(stage: string | null) {
  const { from, to } = stringKeyRange(stage);
  return {
    lower: { key: [LIVE, from] as [number, string], inclusive: true as const },
    upper: { key: [LIVE, to] as [number, string], inclusive: true as const },
  };
}

/** One exact live-customer key: a specific phone/email presence combination. */
function exactCustomerKey(hasPhone: number, hasEmail: number) {
  const key = [LIVE, hasPhone, hasEmail] as [number, number, number];
  return {
    lower: { key, inclusive: true as const },
    upper: { key, inclusive: true as const },
  };
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
    //
    // Two counts off the B-tree instead of reading up to 2,000 vehicle
    // documents — the single largest read in this query, and vehicle rows are
    // among the fattest in the schema (image arrays, spec fields, costing).
    //
    // "Total" is own stock only, matching the old `sourceType !== "SOURCED"`
    // filter: a sourced car is located on demand from another dealer and was
    // never in this dealer's inventory. `sourcedFlag` sits above `status` in
    // the key precisely so this is one contiguous range.
    const [totalVehicles, availableVehicles] = canViewVehicles
      ? await vehiclesByOrg.countBatch(ctx, [
        { namespace: args.orgId, bounds: ownStockBounds(ANY_STATUS) },
        { namespace: args.orgId, bounds: ownStockBounds("AVAILABLE") },
      ])
      : [0, 0];

    // 3. Active Leads (not WON/LOST)
    //
    // The tree stores the raw stage, so "active" stays a subtraction here
    // rather than a flag baked into the key — see `leadsByOrg`. Three counts
    // in one batched round-trip, replacing a scan of up to 1,000 leads.
    const [liveLeads, wonLeads, lostLeads] = canViewLeads
      ? await leadsByOrg.countBatch(ctx, [
        { namespace: args.orgId, bounds: liveStageBounds(ANY_STAGE) },
        { namespace: args.orgId, bounds: liveStageBounds("WON") },
        { namespace: args.orgId, bounds: liveStageBounds("LOST") },
      ])
      : [0, 0, 0];
    const activeLeads = liveLeads - wonLeads - lostLeads;

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

    // Fetch all expenses to deduct from profit.
    //
    // Soft-deleted and reversed rows are excluded here, matching every other
    // reader (getSalesReport, getInventoryReport, computeVehicleCapitalizedCost).
    // Without it, deleting an expense left it inflating this org's costs and
    // deflating its profit on the dashboard forever, while the reports it is
    // meant to summarize showed the corrected figure.
    let allExpenses: Doc<"expenses">[] = [];
    if (canViewCostMetrics) {
      if (filterStart > 0) {
        allExpenses = await ctx.db
          .query("expenses")
          .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId).gte("date", filterStart))
          .filter((q) => q.and(q.neq(q.field("isDeleted"), true), q.eq(q.field("reversedAt"), undefined)))
          .collect();
      } else {
        allExpenses = await ctx.db
          .query("expenses")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .filter((q) => q.and(q.neq(q.field("isDeleted"), true), q.eq(q.field("reversedAt"), undefined)))
          .take(5000);
      }
    }

    const generalExpensesByMonth: Record<string, number> = {};
    const totalExpensesByMonth: Record<string, number> = {};

    for (const exp of allExpenses) {

      const key = getChartKey(exp.date);

      if (canViewCostMetrics) {
        totalExpensesByMonth[key] = (totalExpensesByMonth[key] || 0) + exp.amount;
      }

      if (!canViewProfitMetrics) continue;

      // A reconditioning expense that was capitalized into Vehicle Inventory is
      // already inside the vehicle's cost basis below. Deducting it here as well
      // would charge it to profit twice. Everything else — operating costs, and
      // vehicle-linked costs that were expensed rather than capitalized, such as
      // marketing on a specific car — is a period expense and belongs here.
      if (exp.vehicleId && exp.accountingTreatment === "CAPITALIZED_INVENTORY") continue;

      generalExpensesByMonth[key] = (generalExpensesByMonth[key] || 0) + exp.amount;
    }

    // Cost basis for the profit line. This used to be
    // `vehicle.purchasePrice + <every expense logged against the vehicle>`,
    // computed inline, which disagreed with the GL and the reports in three
    // ways: it skipped the sale entirely when `purchasePrice` was absent (so a
    // SOURCED vehicle costed off `sourceCost` contributed revenue with no cost,
    // reading as pure profit or as nothing at all), it ignored `landedCostTotal`,
    // and it deducted non-capitalizable expenses as if they were inventory cost.
    // computeVehicleCapitalizedCost is the one authority the GL's COGS and the
    // commission basis already use.
    //
    // Computed once per distinct vehicle, not once per sale — which also removes
    // the `ctx.db.get` that ran inside the old per-sale loop.
    const PROFIT_VEHICLE_CAP = 500;
    const soldVehicleIds = Array.from(new Set(activeSales.map((s) => s.vehicleId)));
    const costedVehicleIds = soldVehicleIds.slice(0, PROFIT_VEHICLE_CAP);
    const profitTruncated = soldVehicleIds.length > PROFIT_VEHICLE_CAP;
    const capitalizedCostByVehicle = new Map<string, number>();
    if (canViewProfitMetrics) {
      await Promise.all(
        costedVehicleIds.map(async (vehicleId) => {
          const vehicle = await ctx.db.get(vehicleId);
          if (!vehicle || vehicle.orgId !== args.orgId) return;
          capitalizedCostByVehicle.set(vehicleId, await computeVehicleCapitalizedCost(ctx, vehicle));
        })
      );
    }

    if (activeSales.length > 0) {
      for (const sale of activeSales) {
        const key = getChartKey(sale.saleDate);

        monthlySales[key] = (monthlySales[key] || 0) + sale.salePrice;

        // A vehicle past the cap, or whose row is gone, is absent from the map.
        // Skip it rather than book its full sale price as profit. The omission is
        // reported as `truncated.profit`, alongside the vehicles/sales/members
        // flags this query already returns.
        const cost = capitalizedCostByVehicle.get(sale.vehicleId);
        if (canViewProfitMetrics && cost !== undefined) {
          monthlyProfits[key] = (monthlyProfits[key] || 0) + (sale.salePrice - cost);
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
    //
    // `memberships` has no soft-delete column — removing a member deletes the
    // row — so the org's whole namespace is the count, with no bounds.
    const teamMembers = canViewUsers
      ? await membershipsByOrg.count(ctx, { namespace: args.orgId })
      : 0;

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
      teamMembers,
      salesTrend,
      truncated: {
        // Vehicles and members are exact counts off the B-tree now, so neither
        // can be truncated. The flags stay in the response rather than being
        // dropped: they are part of this query's shape, and a consumer reading
        // `truncated.vehicles` should see "not truncated", not `undefined`.
        vehicles: false,
        sales: salesTruncated,
        members: false,
        profit: profitTruncated,
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

const OPEN_RECEIVABLE_STATUSES = ["OPEN", "PARTIALLY_PAID", "OVERDUE"] as const;
const TODAY_FOR_ROLE_CAP = 2000;

// Asia/Amman — this platform's primary/founding market (see lib/dateInput.ts's
// comments on the same default) — is the fallback business timezone when an
// org hasn't configured `orgSettings.timezone`.
const DEFAULT_ORG_TIMEZONE = "Asia/Amman";

/**
 * The org's configured business timezone and currency, read from the same
 * `orgSettings` row other Convex modules already use for this (see
 * `getOrgCurrency` in `convex/accounting/workflowHooks.ts` and
 * `getOrgCurrencyForReports` in `convex/accountingReports.ts`), so "today"
 * boundary math and amount labeling both reflect the org's actual settings
 * rather than the server process's own timezone or a hardcoded currency.
 */
async function getOrgTimezoneAndCurrency(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
): Promise<{ timezone: string; currency: string }> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  return {
    timezone: settings?.timezone ?? DEFAULT_ORG_TIMEZONE,
    currency: settings?.currency ?? "JOD",
  };
}

/**
 * Reads the wall-clock Y/M/D for `at` in `timeZone` via `Intl.DateTimeFormat`
 * — no date-library dependency needed. Works for any IANA zone, DST or not;
 * Jordan currently has no DST, but nothing here assumes that.
 */
function calendarDatePartsInTimeZone(
  timeZone: string,
  at: number,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") lookup[part.type] = part.value;
  }
  return { year: Number(lookup.year), month: Number(lookup.month), day: Number(lookup.day) };
}

/**
 * Start of "today" as this org's business calendar sees it, expressed as a
 * UTC millisecond timestamp — matching this repo's existing "a calendar date
 * IS its UTC midnight" storage convention (see lib/dateInput.ts's
 * `dateInputToUtcMs`, which every `dueDate`/`chequeDate` on these tables is
 * stored with). Reading the wall-clock date in the ORG's timezone (rather
 * than `new Date().setHours(0,0,0,0)`, which uses the server process's own
 * timezone — almost certainly UTC in production) is what makes "today"
 * actually mean today from the business's perspective, not the server's.
 */
function startOfTodayForOrg(timeZone: string, now: number): number {
  const { year, month, day } = calendarDatePartsInTimeZone(timeZone, now);
  return Date.UTC(year, month - 1, day);
}

/**
 * Role-aware "today" data for accountant-shaped roles: collections due today,
 * post-dated cheques due this week, and overdue receivables. Gated on
 * `view:finance` — the same permission `dashboard.stats` already requires for
 * any of its finance-shaped fields — rather than a new permission string.
 * Bounded scans (`.take(N)`) — this is an aggregate summary, not a list endpoint.
 */
export const todayForRole = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const { timezone, currency } = await getOrgTimezoneAndCurrency(ctx, args.orgId);
    const now = Date.now();
    const todayStart = startOfTodayForOrg(timezone, now);
    const todayEnd = todayStart + 24 * 60 * 60 * 1000 - 1;
    const weekEnd = now + 7 * 24 * 60 * 60 * 1000;

    const receivablesDueToday = await ctx.db
      .query("receivables")
      .withIndex("by_org_dueDate", (q) =>
        q.eq("orgId", args.orgId).gte("dueDate", todayStart).lte("dueDate", todayEnd),
      )
      .filter((q) =>
        q.and(
          q.neq(q.field("isDeleted"), true),
          q.or(...OPEN_RECEIVABLE_STATUSES.map((status) => q.eq(q.field("status"), status))),
        ),
      )
      .take(TODAY_FOR_ROLE_CAP);

    const overdueReceivableRows = await ctx.db
      .query("receivables")
      .withIndex("by_org_dueDate", (q) => q.eq("orgId", args.orgId).lt("dueDate", todayStart))
      .filter((q) =>
        q.and(
          q.neq(q.field("isDeleted"), true),
          q.or(...OPEN_RECEIVABLE_STATUSES.map((status) => q.eq(q.field("status"), status))),
        ),
      )
      .take(TODAY_FOR_ROLE_CAP);

    const chequesDueThisWeekRows = await ctx.db
      .query("postDatedCheques")
      .withIndex("by_org_status_and_chequeDate", (q) =>
        q.eq("orgId", args.orgId).eq("status", "HELD").gte("chequeDate", todayStart).lte("chequeDate", weekEnd),
      )
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .take(TODAY_FOR_ROLE_CAP);

    const sum = (rows: ReadonlyArray<{ amount?: number; outstandingAmount?: number }>, key: "amount" | "outstandingAmount") =>
      rows.reduce((acc, row) => acc + (row[key] ?? 0), 0);

    return {
      collectionsDueToday: {
        count: receivablesDueToday.length,
        amount: sum(receivablesDueToday, "outstandingAmount"),
      },
      chequesDueThisWeek: {
        count: chequesDueThisWeekRows.length,
        amount: sum(chequesDueThisWeekRows, "amount"),
      },
      overdueReceivables: {
        count: overdueReceivableRows.length,
        amount: sum(overdueReceivableRows, "outstandingAmount"),
      },
      truncated:
        receivablesDueToday.length === TODAY_FOR_ROLE_CAP ||
        overdueReceivableRows.length === TODAY_FOR_ROLE_CAP ||
        chequesDueThisWeekRows.length === TODAY_FOR_ROLE_CAP,
      currency,
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

    // `customersByOrg`'s key is [deletedFlag, hasPhone, hasEmail]. With both
    // flags binary, the four live combinations are four exact keys, so each
    // count is a point lookup and the two answers are sums of two of them —
    // no range reasoning, and no scan of up to 2,000 customer rows.
    const [
      noPhoneNoEmail,
      noPhoneHasEmail,
      hasPhoneNoEmail,
    ] = canViewCustomers
      ? await customersByOrg.countBatch(ctx, [
        { namespace: args.orgId, bounds: exactCustomerKey(ABSENT, ABSENT) },
        { namespace: args.orgId, bounds: exactCustomerKey(ABSENT, PRESENT) },
        { namespace: args.orgId, bounds: exactCustomerKey(PRESENT, ABSENT) },
      ])
      : [0, 0, 0];

    const customersMissingPhone = noPhoneNoEmail + noPhoneHasEmail;
    const customersMissingEmail = noPhoneNoEmail + hasPhoneNoEmail;

    // Likewise one point lookup instead of reading every vehicle to re-run a
    // checksum that `vehicleQualityByOrg` already stores the answer to.
    const vehiclesWithVinWarning = canViewVehicles
      ? await vehicleQualityByOrg.count(ctx, {
        namespace: args.orgId,
        bounds: {
          lower: { key: [LIVE, VIN_INVALID] as [number, number], inclusive: true },
          upper: { key: [LIVE, VIN_INVALID] as [number, number], inclusive: true },
        },
      })
      : 0;

    return {
      customersMissingPhone,
      customersMissingEmail,
      vehiclesWithVinWarning,
    };
  },
});
