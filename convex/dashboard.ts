import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, PERMISSIONS, type Permission } from "./utils/permissions";
import { computeVehicleCapitalizedCost } from "./utils/vehicleCost";
import {
  grossTransactionValueForSale,
  grossTransactionValueForTransaction,
} from "./utils/grossTransactionValue";
import {
  ABSENT,
  customersByOrg,
  DIRECT,
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

/**
 * One exact key for a live, dealership-entered customer with a specific
 * phone/email presence combination.
 *
 * Pinned to `DIRECT`: social-ingested contacts are deliberately outside every
 * count this card reports — see `customersByOrg`.
 */
function exactCustomerKey(hasPhone: number, hasEmail: number) {
  const key = [LIVE, DIRECT, hasPhone, hasEmail] as [number, number, number, number];
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
    let periodLength = 0;

    if (args.timeRange === "DAY") {
      periodLength = 24 * 60 * 60 * 1000;
    } else if (args.timeRange === "MONTH") {
      periodLength = 30 * 24 * 60 * 60 * 1000;
    } else if (args.timeRange === "YEAR") {
      periodLength = 365 * 24 * 60 * 60 * 1000;
    }

    const filterStart = periodLength > 0 ? now - periodLength : 0;

    // The window immediately before the current one, the same length: a MONTH
    // view compares the last 30 days against the 30 before them.
    //
    // DAY and MONTH only. ALL_TIME has no period before it at all, and YEAR is
    // excluded on cost: its previous window is a second full year of sales and
    // expenses, on a subscription query that re-runs on every write to either
    // table. That is the read amplification PR #166 spent its entire budget
    // removing, and re-spending it to render one percentage is not the trade.
    // A YEAR view shows its figures without deltas, which the client already
    // handles — an absent previous total collapses the delta and leaves the
    // layout alone.
    const comparesPeriods = args.timeRange === "DAY" || args.timeRange === "MONTH";
    const previousStart = filterStart - periodLength;

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
    // `totalVehicles` spans every status, which includes SOLD and ARCHIVED —
    // it is a lifetime count, not stock on hand. The dashboard card presented
    // it as "Active Inventory", so a dealership that had sold half its cars
    // still saw them counted as inventory. `activeVehicles` is the real
    // on-the-lot figure: available + reserved + in inspection/repair.
    const [totalVehicles, availableVehicles, reservedVehicles, inInspectionVehicles, inRepairVehicles] =
      canViewVehicles
        ? await vehiclesByOrg.countBatch(ctx, [
          { namespace: args.orgId, bounds: ownStockBounds(ANY_STATUS) },
          { namespace: args.orgId, bounds: ownStockBounds("AVAILABLE") },
          { namespace: args.orgId, bounds: ownStockBounds("RESERVED") },
          { namespace: args.orgId, bounds: ownStockBounds("IN_INSPECTION") },
          { namespace: args.orgId, bounds: ownStockBounds("IN_REPAIR") },
        ])
        : [0, 0, 0, 0, 0];
    const activeVehicles =
      availableVehicles + reservedVehicles + inInspectionVehicles + inRepairVehicles;

    // 3. Active Leads (not WON/LOST)
    //
    // The tree stores the raw stage, so "active" stays a subtraction here
    // rather than a flag baked into the key — see `leadsByOrg`. Three counts
    // in one batched round-trip, replacing a scan of up to 1,000 leads.
    // The per-stage breakdown is counted here rather than derived on the client
    // from `leads.list`: that is a paginated query and the dashboard only holds
    // its first 100 rows, so above 100 leads the donut silently disagreed with
    // the headline number beside it. Every non-terminal stage is counted — the
    // client-side version omitted INTERESTED and RESERVED entirely, so leads
    // parked in those stages vanished from the chart while still being counted
    // in the tiles next to it.
    const activeStages = [
      "NEW",
      "CONTACTED",
      "INTERESTED",
      "TEST_DRIVE",
      "NEGOTIATION",
      "RESERVED",
    ] as const;

    const leadCounts = canViewLeads
      ? await leadsByOrg.countBatch(ctx, [
        { namespace: args.orgId, bounds: liveStageBounds(ANY_STAGE) },
        { namespace: args.orgId, bounds: liveStageBounds("WON") },
        { namespace: args.orgId, bounds: liveStageBounds("LOST") },
        ...activeStages.map((stage) => ({
          namespace: args.orgId,
          bounds: liveStageBounds(stage),
        })),
      ])
      : [0, 0, 0, ...activeStages.map(() => 0)];

    const [liveLeads, wonLeads, lostLeads] = leadCounts;
    const activeLeads = liveLeads - wonLeads - lostLeads;
    const leadsByStage = Object.fromEntries(
      activeStages.map((stage, index) => [stage, leadCounts[3 + index]])
    ) as Record<(typeof activeStages)[number], number>;

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
    // Gross transaction value: what the dealership handled, agent deals at full
    // ticket. Turnover is computed further down, once the consigned vehicles are
    // known — the two are different numbers and both are reported.
    // Same definition as the P&L and the sales report — see
    // utils/grossTransactionValue. The fallback path reads the cashflow row's
    // gross rather than its `amount`, which is net of deposits.
    const grossTransactionValue = activeSales.length > 0
      ? activeSales.reduce((acc, sale) => acc + grossTransactionValueForSale(sale), 0)
      : saleTransactions.reduce(
          (acc, transaction) => acc + grossTransactionValueForTransaction(transaction),
          0
        );
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
    const consignedVehicleIds = new Set<string>();
    const costedVehicleIdSet = new Set<string>(costedVehicleIds);
    /**
     * Gated on profit permission, and the gate has to be here rather than at
     * the point of use.
     *
     * Two things depend on it. The obvious one is cost: `computeVehicleCapitalizedCost`
     * reads every expense logged against a car, so running it for a viewer who
     * may not see costs was up to ~1,000 extra document reads on every
     * subscription tick, for figures that would then be withheld.
     *
     * The less obvious one is that a consigned sale's TURNOVER is its margin —
     * the same number. Computing turnover on the agent basis for someone
     * without cost permission would hand them the margin under a different
     * label: 12,500 on the car and 3,000 of turnover discloses the supplier's
     * entitlement exactly. So they get the gross, and `salesVolumeBasis` says
     * so rather than letting a gross figure pass as accounting turnover.
     */
    if (canViewProfitMetrics) {
      await Promise.all(
        costedVehicleIds.map(async (vehicleId) => {
          const vehicle = await ctx.db.get(vehicleId);
          if (!vehicle || vehicle.orgId !== args.orgId) return;
          const cost = await computeVehicleCapitalizedCost(ctx, vehicle);
          capitalizedCostByVehicle.set(vehicleId, cost);
          if (vehicle.sourceType === "SOURCED") consignedVehicleIds.add(vehicleId);
        })
      );
    }

    /**
     * Turnover for the sales the costing cap skipped, from the vehicle row
     * alone.
     *
     * Excluding every uncosted sale discarded figures that were never in
     * doubt: an org past the cap read a headline revenue, a monthly chart and
     * a salesperson ranking silently short by the whole tail.
     *
     * Both bases are answerable from the row this loop already reads, and
     * neither needs the expense walk the cap exists for. Owned stock: turnover
     * IS the sale price. Consigned: turnover is the margin, and
     * `computeVehicleCapitalizedCost` returns `sourceCost` for a SOURCED
     * vehicle BEFORE it touches expenses (see utils/vehicleCost.ts) — so the
     * margin costs one field access, not a scan. An earlier version of this
     * excluded the consigned tail on the grounds that "the margin needs the
     * cost", which was simply wrong about that function, and threw away the
     * larger half of the tail on a consigned-heavy lot.
     *
     * A SOURCED row with no usable `sourceCost` is still excluded: zero is
     * treated as missing here exactly as `hasVehicleCostBasis` treats it,
     * because a 0 basis would book the whole ticket as margin — the supplier's
     * entire share reported as the dealership's turnover.
     */
    const TURNOVER_BASIS_CAP = 2_000;
    type UncostedBasis = { consigned: false } | { consigned: true; supplierCost: number };
    const uncostedBasisByVehicle = new Map<string, UncostedBasis>();
    // Explicitly bounded. `periodSales` uses `.collect()` on every dated
    // window, so `soldVehicleIds` has no ceiling of its own, and an unbounded
    // fan-out of whole vehicle documents on a live subscription does not
    // shorten a number — it exceeds the read limit and the dashboard goes
    // blank. Past this cap the sales stay excluded and `turnoverTruncated`
    // says so.
    if (canViewProfitMetrics && profitTruncated) {
      await Promise.all(
        soldVehicleIds
          .slice(PROFIT_VEHICLE_CAP, PROFIT_VEHICLE_CAP + TURNOVER_BASIS_CAP)
          .map(async (vehicleId) => {
            const vehicle = await ctx.db.get(vehicleId);
            if (!vehicle || vehicle.orgId !== args.orgId) return;
            if (vehicle.sourceType !== "SOURCED") {
              uncostedBasisByVehicle.set(vehicleId, { consigned: false });
              return;
            }
            const supplierCost = vehicle.sourceCost;
            if (supplierCost == null || supplierCost <= 0) return;
            uncostedBasisByVehicle.set(vehicleId, { consigned: true, supplierCost });
          })
      );
    }

    /**
     * Accounting turnover for one sale: the margin on a consigned car, the
     * price on the dealership's own stock.
     */
    let turnoverTruncated = false;
    const turnoverFromBasis = (
      basis: UncostedBasis | undefined,
      salePrice: number
    ): number | null => {
      if (!basis) return null;
      if (!basis.consigned) return salePrice;
      return Math.max(0, salePrice - basis.supplierCost);
    };
    const recognizedRevenueOfSale = (sale: { vehicleId: Id<"vehicles">; salePrice: number }): number => {
      if (!canViewProfitMetrics) return sale.salePrice;
      const cost = capitalizedCostByVehicle.get(sale.vehicleId);
      if (!costedVehicleIdSet.has(sale.vehicleId) || cost === undefined) {
        // Answered from the vehicle row where it could be. What remains is a
        // row that is gone, belongs to another org, sits past the basis cap,
        // or is consigned with no recorded supplier cost — none of which is
        // "the dealership owned it", so none may be booked at gross.
        const fromBasis = turnoverFromBasis(
          uncostedBasisByVehicle.get(sale.vehicleId),
          sale.salePrice
        );
        if (fromBasis !== null) return fromBasis;
        turnoverTruncated = true;
        return 0;
      }
      if (!consignedVehicleIds.has(sale.vehicleId)) return sale.salePrice;
      return Math.max(0, sale.salePrice - cost);
    };

    /**
     * Which basis `salesVolume` and `monthlySales` are on, stated rather than
     * assumed. ACCOUNTING_TURNOVER agrees with the sales reports and the P&L;
     * GROSS_TRANSACTION_VALUE is what the dealership handled, consigned deals
     * at full ticket, and is not turnover.
     */
    const salesVolumeBasis: "ACCOUNTING_TURNOVER" | "GROSS_TRANSACTION_VALUE" = canViewProfitMetrics
      ? "ACCOUNTING_TURNOVER"
      : "GROSS_TRANSACTION_VALUE";

    // Accounting turnover. Falls back to the transaction ledger when there are
    // no sale rows, reading each row's recognized amount where it carries one.
    const salesVolume = activeSales.length > 0
      ? activeSales.reduce((acc, sale) => acc + recognizedRevenueOfSale(sale), 0)
      : saleTransactions.reduce(
          (acc, transaction) =>
            acc +
            (canViewProfitMetrics
              ? (transaction.recognizedRevenueAmount ?? transaction.amount)
              : transaction.amount),
          0
        );

    if (activeSales.length > 0) {
      for (const sale of activeSales) {
        const key = getChartKey(sale.saleDate);

        monthlySales[key] = (monthlySales[key] || 0) + recognizedRevenueOfSale(sale);

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
        // Same basis as `salesVolume` above — the chart and the headline figure
        // it summarizes cannot be on different bases.
        monthlySales[key] =
          (monthlySales[key] || 0) +
          (canViewProfitMetrics
            ? (transaction.recognizedRevenueAmount ?? transaction.amount)
            : transaction.amount);
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
        // Ranking on gross would put whoever moved a consigned car above a
        // colleague who earned twice the margin on stock the dealership owned.
        entry.revenue += recognizedRevenueOfSale(sale);
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

    // 8. Previous-period totals, for the KPI deltas the mobile home renders as
    // "+12% ↑" under each headline figure.
    //
    // Exactly the three figures that row compares, and nothing else: `sales`
    // mirrors `salesVolumeThisMonth`, `expenses` and `netProfit` mirror the
    // sums the client already takes over `salesTrend`. Each is computed from
    // the same source and with the same rules as its current-period twin, so a
    // delta is never a comparison between two differently-derived numbers.
    //
    // These are separate index range reads rather than one widened scan
    // partitioned in memory. The rows touched are identical either way — the
    // union of the two ranges IS the widened range — but a widened read would
    // have to share the current period's `.take()` cap, and an index range
    // returns its OLDEST rows first. On an org with more rows than the cap the
    // previous window would consume the whole budget and starve the figures
    // the dashboard already ships. Splitting the reads leaves every
    // current-period number above byte-for-byte unchanged.
    const PREVIOUS_PERIOD_CAP = 5000;

    // Each window settles on its own source, by the same rule the current one
    // uses: sale rows when that window has any, the VEHICLE_SALE transaction
    // fallback otherwise.
    //
    // Deriving the previous window's source from the CURRENT window's row
    // count looks like it keeps the two totals comparable, but it skips the
    // previous window's sale rows entirely whenever this period had none —
    // reporting no sales, and a profit of just the negated period expenses,
    // for a window that was profitable. Nothing is truncated and every
    // permission passes in that state, so the client renders the delta as
    // confidently as a correct one. A dealer coming off a quiet month is the
    // case this comparison exists for.
    const previousSales = comparesPeriods && canViewSalesMetrics
      ? await ctx.db
        .query("sales")
        .withIndex("by_org_saleDate", (q) =>
          q.eq("orgId", args.orgId).gte("saleDate", previousStart).lt("saleDate", filterStart))
        .filter(q => q.and(
          q.eq(q.field("status"), "COMPLETED"),
          q.neq(q.field("isDeleted"), true)
        ))
        .take(PREVIOUS_PERIOD_CAP)
      : [];

    const previousUsesSaleRows = previousSales.length > 0;

    const previousSaleTransactions = comparesPeriods && canViewSalesMetrics && !previousUsesSaleRows
      ? await ctx.db
        .query("transactions")
        .withIndex("by_org_date", (q) =>
          q.eq("orgId", args.orgId).gte("date", previousStart).lt("date", filterStart))
        .filter(q => q.and(
          q.eq(q.field("category"), "VEHICLE_SALE"),
          q.eq(q.field("type"), "IN"),
          q.neq(q.field("isDeleted"), true)
        ))
        .take(PREVIOUS_PERIOD_CAP)
      : [];

    const previousExpenses = comparesPeriods && canViewCostMetrics
      ? await ctx.db
        .query("expenses")
        .withIndex("by_org_date", (q) =>
          q.eq("orgId", args.orgId).gte("date", previousStart).lt("date", filterStart))
        .filter((q) => q.and(q.neq(q.field("isDeleted"), true), q.eq(q.field("reversedAt"), undefined)))
        .take(PREVIOUS_PERIOD_CAP)
      : [];

    // Turnover for the comparison window needs the same consigned split, so the
    // previous window's vehicles are costed here rather than inside the
    // profit-only block below. Reuses anything the current window already read.
    const previousSoldVehicleIdsForRevenue = Array.from(
      new Set(previousSales.map((sale) => sale.vehicleId))
    );
    // Gated exactly as the current window is, and for both of the same reasons:
    // the cost reads are the expensive ones, and a consigned sale's turnover is
    // its margin. A viewer without profit permission compares gross to gross.
    let previousTurnoverTruncated = false;
    const previousRevenueBasisByVehicle = new Map(
      canViewProfitMetrics
        ? await Promise.all(
            previousSoldVehicleIdsForRevenue.slice(0, PROFIT_VEHICLE_CAP).map(async (vehicleId) => {
              const vehicle = await ctx.db.get(vehicleId);
              if (!vehicle || vehicle.orgId !== args.orgId) {
                return [vehicleId, undefined] as const;
              }
              const cached = capitalizedCostByVehicle.get(vehicleId);
              const cost = cached ?? (await computeVehicleCapitalizedCost(ctx, vehicle));
              return [
                vehicleId,
                { consigned: vehicle.sourceType === "SOURCED", cost },
              ] as const;
            })
          )
        : []
    );
    // The comparison window's tail, on exactly the current window's terms —
    // same cap, same bases, same exclusions. Anything else compares a complete
    // period against a shortened one and reports the difference as growth.
    const previousUncostedBasisByVehicle = new Map<string, UncostedBasis>();
    if (canViewProfitMetrics && previousSoldVehicleIdsForRevenue.length > PROFIT_VEHICLE_CAP) {
      await Promise.all(
        previousSoldVehicleIdsForRevenue
          .slice(PROFIT_VEHICLE_CAP, PROFIT_VEHICLE_CAP + TURNOVER_BASIS_CAP)
          .map(async (vehicleId) => {
            const vehicle = await ctx.db.get(vehicleId);
            if (!vehicle || vehicle.orgId !== args.orgId) return;
            if (vehicle.sourceType !== "SOURCED") {
              previousUncostedBasisByVehicle.set(vehicleId, { consigned: false });
              return;
            }
            const supplierCost = vehicle.sourceCost;
            if (supplierCost == null || supplierCost <= 0) return;
            previousUncostedBasisByVehicle.set(vehicleId, { consigned: true, supplierCost });
          })
      );
    }

    const previousRecognizedRevenueOfSale = (sale: {
      vehicleId: Id<"vehicles">;
      salePrice: number;
    }): number => {
      if (!canViewProfitMetrics) return sale.salePrice;
      // Excluded rather than booked at gross, exactly as the current window
      // treats the same absence. Booking it at gross here put the two windows
      // on different bases, so a period-over-period change reported the
      // difference between an agent-basis turnover and a principal-basis one as
      // if it were growth.
      const basis = previousRevenueBasisByVehicle.get(sale.vehicleId);
      if (!basis) {
        const fromBasis = turnoverFromBasis(
          previousUncostedBasisByVehicle.get(sale.vehicleId),
          sale.salePrice
        );
        if (fromBasis !== null) return fromBasis;
        previousTurnoverTruncated = true;
        return 0;
      }
      if (!basis.consigned) return sale.salePrice;
      return Math.max(0, sale.salePrice - basis.cost);
    };

    // Compared against the current period's turnover, so it has to be turnover
    // too — mixing the two bases would show a swing that never happened.
    const previousSalesVolume = previousUsesSaleRows
      ? previousSales.reduce((acc, sale) => acc + previousRecognizedRevenueOfSale(sale), 0)
      : previousSaleTransactions.reduce(
          (acc, transaction) =>
            acc +
            (canViewProfitMetrics
              ? (transaction.recognizedRevenueAmount ?? transaction.amount)
              : transaction.amount),
          0
        );

    const previousTotalExpenses = previousExpenses.reduce((acc, exp) => acc + exp.amount, 0);

    // Same split the current period makes: a reconditioning expense already
    // capitalized into a vehicle's cost basis is not a period expense, and
    // deducting it here too would charge it to profit twice.
    const previousGeneralExpenses = previousExpenses.reduce(
      (acc, exp) =>
        exp.vehicleId && exp.accountingTreatment === "CAPITALIZED_INVENTORY" ? acc : acc + exp.amount,
      0,
    );

    // Cost basis for the previous window's profit, from the same authority the
    // current window uses. Vehicles already costed above are reused rather than
    // re-read — a car that sold in both windows is a returned unit, not a
    // reason to run `computeVehicleCapitalizedCost` twice.
    const previousSoldVehicleIds = Array.from(new Set(previousSales.map((s) => s.vehicleId)));
    const previousProfitTruncated = previousSoldVehicleIds.length > PROFIT_VEHICLE_CAP;
    let previousProfit = -previousGeneralExpenses;
    if (canViewProfitMetrics && !previousProfitTruncated) {
      const previousCostByVehicle = new Map(
        await Promise.all(
          previousSoldVehicleIds.map(async (vehicleId) => {
            const cached = capitalizedCostByVehicle.get(vehicleId);
            if (cached !== undefined) return [vehicleId, cached] as const;
            const vehicle = await ctx.db.get(vehicleId);
            if (!vehicle || vehicle.orgId !== args.orgId) return [vehicleId, undefined] as const;
            return [vehicleId, await computeVehicleCapitalizedCost(ctx, vehicle)] as const;
          })
        )
      );
      for (const sale of previousSales) {
        const cost = previousCostByVehicle.get(sale.vehicleId);
        if (cost !== undefined) previousProfit += sale.salePrice - cost;
      }
    }

    const previousSalesTruncated =
      previousSales.length === PREVIOUS_PERIOD_CAP ||
      previousSaleTransactions.length === PREVIOUS_PERIOD_CAP;
    const previousExpensesTruncated = previousExpenses.length === PREVIOUS_PERIOD_CAP;

    // A truncated total on EITHER side of the division yields a confidently
    // wrong percentage, and a dealer has no way to tell that from a real one.
    // So each field is omitted rather than approximated: the client renders no
    // delta at all when one is absent, which is the honest outcome. Permission
    // gating is the same as the current-period figure each one is compared
    // against — a caller who cannot see the number cannot see its history.
    const previousPeriod = comparesPeriods
      ? {
        sales:
          canViewSalesMetrics && !salesTruncated && !previousSalesTruncated
            ? previousSalesVolume
            : undefined,
        expenses:
          canViewCostMetrics && !previousExpensesTruncated ? previousTotalExpenses : undefined,
        netProfit:
          canViewProfitMetrics &&
            !profitTruncated &&
            !previousProfitTruncated &&
            !previousSalesTruncated &&
            !previousExpensesTruncated
            ? previousProfit
            : undefined,
      }
      : undefined;

    return {
      totalVehicles,
      availableVehicles,
      activeVehicles,
      reservedVehicles,
      activeLeads,
      totalLeads: liveLeads,
      leadsByStage,
      salesThisMonth: salesCount,
      // Accounting turnover: agent-sale gross is excluded, so this agrees with
      // getSalesAndProfitReport and getProfitAndLoss on the same period —
      // unless `salesVolumeBasis` says GROSS_TRANSACTION_VALUE, which is what a
      // viewer without profit permission gets, because the agent basis would
      // disclose the margin they are not permitted to see.
      salesVolumeThisMonth: salesVolume,
      salesVolumeBasis,
      // The deal volume actually handled, agent sales at full ticket. An
      // operational KPI, explicitly separate from turnover.
      grossTransactionValueThisMonth: grossTransactionValue,
      teamMembers,
      salesTrend,
      previousPeriod,
      truncated: {
        // Vehicles and members are exact counts off the B-tree now, so neither
        // can be truncated. The flags stay in the response rather than being
        // dropped: they are part of this query's shape, and a consumer reading
        // `truncated.vehicles` should see "not truncated", not `undefined`.
        vehicles: false,
        sales: salesTruncated,
        members: false,
        profit: profitTruncated,
        // Sales whose vehicle fell past the costing cap are left OUT of
        // turnover rather than folded in at gross, so the figure is short
        // rather than on two bases at once.
        turnover: turnoverTruncated || previousTurnoverTruncated,
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

    // `customersByOrg`'s key is [deletedFlag, socialFlag, hasPhone, hasEmail].
    // With the presence flags binary, the live dealership-entered combinations
    // are four exact keys, so each count is a point lookup and the two answers
    // are sums of two of them — no range reasoning, and no scan of up to 2,000
    // customer rows.
    //
    // Instagram/Facebook contacts are excluded: ingestion creates one per
    // inbound message with no phone and no email, which drowned the real
    // signal. See `customersByOrg`.
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
