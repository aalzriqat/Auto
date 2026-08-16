import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, PERMISSIONS, type Permission } from "./utils/permissions";
import { computeVehicleCapitalizedCost } from "./utils/vehicleCost";
import { fromMinorUnits } from "./utils/money";
import { verifiedFinancingApplicationSaleIds } from "./utils/financingProvenance";
import {
  recordedConsignedMargin,
  recordedSupplierEntitlement,
  recordedSupplierGrossReceipt,
  saleEconomics,
} from "./utils/vehicleOwnership";
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
     * ⚠️ REDESIGNED for SCRUM-49 Lane 4, after a convergence circuit breaker.
     *
     * This file used to carry its OWN implementation of the rules that decide
     * whether a sale's earning may be published: which frozen margin to believe,
     * when the evidence is missing, when the live cost is not a basis. It was
     * kept "in step" with `saleEconomics` by hand, and it drifted every time that
     * authority moved — three times during this one change, each found by an
     * adversarial reviewer, each a case where an owner's home screen and their
     * own sales report stated different profits for one deal:
     *
     *   1. a financed-DIRECT frozen margin with no supplier receipt;
     *   2. an agent sale whose vehicle is present but has no cost basis;
     *   3. a receipt with no finance application behind it.
     *
     * Two consecutive rounds of fix-induced defects in one subsystem is a design
     * fault, not a bad patch. So the copy is gone: this screen now ASKS
     * `saleEconomics` — the same function `reports.salesReport`, both deal
     * cockpits and the P&L already read — and publishes its answer. There is
     * nothing left here to drift.
     *
     * What stays local is the INPUT, never the decision: which vehicles this
     * window managed to read and at what basis. That genuinely differs per
     * window, and it is bounded by the read caps above.
     */
    let turnoverTruncated = false;
    /**
     * Sales left out because what they earned cannot be established. Separate
     * from `profitTruncated`, which means "past the costing cap" — a different
     * reason for a short figure, and one an operator can act on differently.
     */
    let unknownMarginExcluded = false;

    /**
     * What this window learned about a sale's vehicle, and at what basis.
     *
     * `known: false` means the row was not read at all — gone, another org's, or
     * past both caps. It is NOT "cost zero": `saleEconomics` treats an unreadable
     * vehicle and a zero-cost one differently, and collapsing them here would
     * reintroduce the divergence this redesign exists to remove.
     */
    type WindowVehicleBasis =
      | { known: true; consigned: boolean; cost: number }
      /**
       * Classification known, cost NOT — a dealer-owned row past the costing cap.
       *
       * ⚠️ Found by the Codex reviewer. Collapsing this into `known: false`
       * handed `saleEconomics` a `vehicle: null`, which invites it to classify
       * from the SALE's frozen evidence — and a dealer-owned row carrying a
       * stale `consignedMarginMinor` (raw-editor reachable; the writer only ever
       * sets it on a sourced sale) would then be read as an agent sale, its
       * stale margin published as turnover INSTEAD of the sale price and
       * credited as profit for a car the vehicle row says the dealership owned.
       *
       * The vehicle stays authoritative wherever it was actually read. Only a
       * genuinely unreadable row falls back to the sale's own evidence.
       */
      | { known: true; consigned: false; cost: null }
      | { known: false };

    /**
     * Whether this window can state a PROFIT for the row at all.
     *
     * A known dealer-owned row with no cost is a real turnover (its price) and
     * an unknowable profit. `saleEconomics` is handed `capitalizedCost: 0` for
     * it, which makes its margin the whole sale price — correct arithmetic on a
     * basis that is not real — so the margin is not published. `profitTruncated`
     * already reports the shortfall, set from the cap itself.
     */
    const profitIsPublishable = (basis: WindowVehicleBasis): boolean =>
      !(basis.known && basis.cost === null);

    /**
     * One sale's economics on this window's basis, from the shared authority.
     *
     * The vehicle is reconstructed as `OwnershipFacts` rather than re-fetched:
     * `sourceType` is the only field `saleEconomics` reads from it, and this
     * query already knows whether the row was consigned. Re-reading the document
     * would double the query's cost for a value it is already holding.
     */
    const economicsGiven =
      (
        basisOf: (sale: Doc<"sales">) => WindowVehicleBasis,
        // Resolved once per window rather than per sale: this closure runs
        // inside the window loops, and a `ctx.db.get` there would be an N+1
        // read on a live-subscribed dashboard query.
        verifiedFinancing: Set<Id<"sales">>
      ) =>
      (sale: Doc<"sales">) => {
        const basis = basisOf(sale);
        return saleEconomics({
          salePrice: sale.salePrice,
          vehicle: basis.known
            ? { sourceType: basis.consigned ? "SOURCED" : "STOCK" }
            : null,
          // `0` only ever stands in for a basis that does not exist; where the
          // classification is known but the cost is not, `profitIsPublishable`
          // keeps the resulting margin off the trend.
          capitalizedCost: basis.known && basis.cost !== null ? basis.cost : 0,
          supplierSettlementRoute: sale.supplierSettlementRoute,
          recordedMargin: recordedConsignedMargin(sale),
          recordedSupplierEntitlement: recordedSupplierEntitlement(sale),
          recordedSupplierGrossReceipt: recordedSupplierGrossReceipt(sale),
          hasFinancingApplication: verifiedFinancing.has(sale._id),
          externallyFinanced:
            sale.financingType === "FINANCED" || sale.financingType === "LEASE",
        });
      };

    /**
     * The current window's basis: the fully costed map first, then the cheaper
     * supplier-cost tail read past the costing cap.
     *
     * A DEALER-OWNED row in that tail has a known classification and an unknown
     * cost, which this type deliberately cannot express — so it reports as
     * unknown here and is handled where turnover is decided, because for owned
     * stock the price is the turnover and that never depended on the cost.
     */
    const currentBasis = (sale: Doc<"sales">): WindowVehicleBasis => {
      const cost = capitalizedCostByVehicle.get(sale.vehicleId);
      if (cost !== undefined) {
        return { known: true, consigned: consignedVehicleIds.has(sale.vehicleId), cost };
      }
      const tail = uncostedBasisByVehicle.get(sale.vehicleId);
      if (tail?.consigned) return { known: true, consigned: true, cost: tail.supplierCost };
      // Dealer-owned past the cap: the row WAS read, so its classification is a
      // fact and must not be re-decided from the sale's frozen fields.
      if (tail) return { known: true, consigned: false, cost: null };
      return { known: false };
    };

    const currentVerifiedFinancing = await verifiedFinancingApplicationSaleIds(ctx, activeSales);
    const currentEconomics = economicsGiven(currentBasis, currentVerifiedFinancing);

    /**
     * Turnover for one sale, and the ONE place this window excludes.
     *
     * `recognizedRevenue` is `null` exactly when the margin is — the documented
     * contract of `SaleEconomics` — so an earning that was withheld cannot slip
     * back in as revenue, which is precisely how this screen came to contradict
     * the sales report.
     */
    const revenueOrNull = (sale: Doc<"sales">): number | null => {
      /**
       * No fallback, deliberately — and this needs saying, because there WAS
       * one and removing it is not an oversight.
       *
       * A dealer-owned row past both caps still has a known turnover: its
       * classification is a fact and only its cost is missing. That case is now
       * answered by `saleEconomics` itself — `currentBasis` reports it as
       * `{known: true, consigned: false, cost: null}`, so the non-agent branch
       * returns `recognizedRevenue: salePrice` — rather than by a special case
       * here.
       *
       * ⚠️ The special case survived that change as DEAD code and was found by
       * the adversarial reviewer. `tail` being truthy now always implies
       * `known: true`, so `!known && tail` cannot hold. Left in place it was a
       * trap rather than mere clutter: if a future edit again collapsed a
       * window's third state to `known: false` — the exact mistake this file has
       * already made — it would spring back to life and silently repair the
       * TURNOVER symptom alone, while the profit side, which has no equivalent
       * fallback, stayed broken. A turnover-only assertion would then pass over
       * a real defect.
       */
      const economics = currentEconomics(sale);
      return economics.recognizedRevenue;
    };

    const recognizedRevenueOfSale = (sale: Doc<"sales">): number => {
      if (!canViewProfitMetrics) return sale.salePrice;
      const revenue = revenueOrNull(sale);
      if (revenue !== null) return revenue;
      if (currentBasis(sale).known) unknownMarginExcluded = true;
      else turnoverTruncated = true;
      return 0;
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
        if (canViewProfitMetrics) {
          // Same authority as the turnover line above. Before this, the chart
          // recomputed `salePrice − cost` for a consigned car while the sales
          // report, the supplier claim, the journal and the cockpit all read
          // the margin the sale froze — so the home screen and the P&L stated
          // two different profits for one deal, which is the exact condition
          // this whole change exists to remove.
          /**
           * Credited whenever the authority ESTABLISHED it — never gated on
           * this window's live cost map.
           *
           * ⚠️ Found by the Codex reviewer against the first cut of this
           * redesign, and reproduced: gating on `capitalizedCostByVehicle`
           * silently dropped a margin `saleEconomics` had established from the
           * sale's own FROZEN evidence. A consigned sale whose vehicle row was
           * deleted reported turnover 3,000 and profit 0 in the same response,
           * with every truncation flag false — the chart contradicting the
           * headline directly above it, and saying nothing was missing.
           *
           * The branch existed in the implementation this replaced (a frozen
           * margin was added without consulting the cost map; only the
           * live-cost FALLBACK required it) and was lost in the port. It is the
           * cost map's job to supply a BASIS, not to decide whether an answer
           * that needed no basis may be published.
           *
           * `null` is the only exclusion, and it means the basis could not be
           * established at all. Where that leaves the trend genuinely short —
           * a dealer-owned row past the costing cap — `profitTruncated` already
           * says so, set from the cap itself rather than from here.
           *
           * NOT flagged as `unknownMarginExcluded`: that flag feeds
           * `truncated.turnover`, and a null margin does not imply a short
           * TURNOVER. Where the turnover really is withheld,
           * `recognizedRevenueOfSale` above sets it.
           */
          const margin = currentEconomics(sale).dealershipMargin;
          if (margin !== null && profitIsPublishable(currentBasis(sale))) {
            monthlyProfits[key] = (monthlyProfits[key] || 0) + margin;
          }
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
    const revenueBySalesperson: Record<string, { revenue: number; deals: number; complete: boolean }> = {};
    let topPerformerIncomplete = false;
    let topPerformer: { name: string; revenue: number; deals: number; userId: Id<"users">; imageUrl?: string; lastSeenAt?: number } | null = null;
    if (canViewSalesMetrics && canViewUsers) {
      for (const sale of activeSales) {
        const entry = revenueBySalesperson[sale.salespersonId] ?? { revenue: 0, deals: 0, complete: true };
        // Ranking on gross would put whoever moved a consigned car above a
        // colleague who earned twice the margin on stock the dealership owned.
        entry.revenue += recognizedRevenueOfSale(sale);
        entry.deals += 1;
        // One deal whose earning cannot be established makes this person's
        // total a lower bound, and a lower bound cannot be compared with a
        // total. Their deal COUNT still rose, so the tile read as a complete
        // record of a complete period.
        // Only on the accounting basis. A viewer without profit permission is
        // ranked on GROSS — `recognizedRevenueOfSale` returns the full sale
        // price for them and `salesVolumeBasis` says so — and on that basis
        // nothing is unknown. Excluding a rep there withheld a complete number
        // for a reason that did not apply to it, and put the tile in
        // contradiction with the headline beside it: the shipped SALES template
        // counted a 20,000 deal in full and simultaneously crowned a smaller
        // seller.
        // Keyed to the SAME answer the headline uses, not to the profit. This
        // tile ranks on revenue, so a row whose turnover is known but whose
        // profit is not — a dealer-owned sale past the costing cap — is not a
        // reason to drop a rep from the ranking. Sharing `revenueOrNull` is what
        // stops the tile and the headline beside it contradicting each other.
        if (canViewProfitMetrics && revenueOrNull(sale) === null) entry.complete = false;
        revenueBySalesperson[sale.salespersonId] = entry;
      }

      // Ranked among the people whose earnings are fully known, rather than
      // ranking everyone on whatever could be totalled. The same defect was
      // already closed in the salesperson report; this tile kept sorting on the
      // partial figure and declaring a winner from it.
      const eligible = Object.entries(revenueBySalesperson).filter(([, e]) => e.complete);
      topPerformerIncomplete = eligible.length !== Object.keys(revenueBySalesperson).length;
      const topEntry = eligible.sort((a, b) => b[1].revenue - a[1].revenue)[0];
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

    let previousUnknownMarginExcluded = false;
    /**
     * The comparison window, on the SAME authority and its own basis.
     *
     * One rule, two windows. The window's own maps supply the basis — asking the
     * current window's maps answered "vehicle unknown" for every
     * comparison-window sale, which put the two periods on different bases and
     * reported the difference as growth.
     */
    const previousBasis = (sale: Doc<"sales">): WindowVehicleBasis => {
      const basis = previousRevenueBasisByVehicle.get(sale.vehicleId);
      if (basis) return { known: true, consigned: basis.consigned, cost: basis.cost };
      const tail = previousUncostedBasisByVehicle.get(sale.vehicleId);
      if (tail?.consigned) return { known: true, consigned: true, cost: tail.supplierCost };
      // The SAME third state the current window carries. Missing it here meant
      // the two windows classified one sale differently — the comparison window
      // reading a dealer-owned past-cap row as unknown, and so re-deciding it
      // from stale frozen fields — which is precisely the asymmetry that turns a
      // period-over-period delta into a change the business never had.
      if (tail) return { known: true, consigned: false, cost: null };
      return { known: false };
    };

    const previousVerifiedFinancing = await verifiedFinancingApplicationSaleIds(ctx, previousSales);
    const previousEconomics = economicsGiven(previousBasis, previousVerifiedFinancing);

    const previousRecognizedRevenueOfSale = (sale: Doc<"sales">): number => {
      if (!canViewProfitMetrics) return sale.salePrice;
      // The same dead fallback stood here, and is removed for the same reason —
      // see `revenueOrNull`. Both windows lose it together, because a guard that
      // exists in one and not the other is how this file broke last time.
      const economics = previousEconomics(sale);
      if (economics.recognizedRevenue !== null) return economics.recognizedRevenue;
      if (previousBasis(sale).known) previousUnknownMarginExcluded = true;
      else previousTurnoverTruncated = true;
      return 0;
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

    // Still counted, because `previousProfitTruncated` is a statement about how
    // many DISTINCT vehicles this window sold — not about anything that gets
    // read. The costing itself happens once, in `previousRevenueBasisByVehicle`.
    const previousSoldVehicleIds = Array.from(new Set(previousSales.map((s) => s.vehicleId)));
    const previousProfitTruncated = previousSoldVehicleIds.length > PROFIT_VEHICLE_CAP;
    let previousProfit = -previousGeneralExpenses;
    if (canViewProfitMetrics && !previousProfitTruncated) {
      /**
       * ⚠️ A SECOND costing pass used to run here, and after the consolidation
       * it had no consumer at all — found by the Codex reviewer. It re-fetched
       * up to `PROFIT_VEHICLE_CAP` previous-window vehicles and ran
       * `computeVehicleCapitalizedCost` (itself a read over expense rows) on
       * each, duplicating the costing `previousRevenueBasisByVehicle` performs
       * immediately above, on a live subscription query that re-runs on every
       * write to sales or expenses. That is the read amplification this file
       * has already been through once; past the limit the dashboard does not
       * shorten a number, it goes blank.
       *
       * The previous window's profit now comes from `previousEconomics`, which
       * is the same authority its turnover uses — so the two cannot disagree
       * either.
       */
      for (const sale of previousSales) {
        // The same three-way answer the current window's chart makes, in the
        // same order. This arm read only the live vehicle cost, so a consigned
        // deal contributed `salePrice − cost` here while contributing its
        // frozen margin there — and where the earning could not be established
        // at all, this arm still produced a number, which is the one outcome
        // the current arm exists to refuse.
        /**
         * ONE predicate, both windows — see the current window's note.
         *
         * The `.has()` gate this replaces was worse here than there:
         * `previousCostByVehicle` stores unreadable vehicles as KEYS WITH
         * UNDEFINED VALUES, so `.has()` answered true for exactly the rows the
         * current window's map answered false for. The same sale could regain
         * its profit merely by ageing into the comparison window, and the
         * period-over-period delta would report that as a change in the
         * business. Asking the authority instead removes the asymmetry rather
         * than correcting one side of it.
         */
        const margin = previousEconomics(sale).dealershipMargin;
        if (margin !== null && profitIsPublishable(previousBasis(sale))) previousProfit += margin;
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
    // An unknown earning on EITHER side is the same kind of hole as a cap: the
    // total is short, and a delta taken across it is a confident number derived
    // from an incomplete one. It is withheld on both sides rather than only the
    // one it occurred on, because the client divides them.
    const profitIncomplete = profitTruncated || unknownMarginExcluded;
    const marginUnknownEitherSide = unknownMarginExcluded || previousUnknownMarginExcluded;
    const previousPeriod = comparesPeriods
      ? {
        sales:
          canViewSalesMetrics &&
            !salesTruncated &&
            !previousSalesTruncated &&
            !marginUnknownEitherSide
            ? previousSalesVolume
            : undefined,
        expenses:
          canViewCostMetrics && !previousExpensesTruncated ? previousTotalExpenses : undefined,
        netProfit:
          canViewProfitMetrics &&
            // The value this response actually publishes as `truncated.profit`,
            // not the raw cap flag. Gating on the raw flag divided a numerator
            // that excluded unknown rows by a denominator that did not.
            !profitIncomplete &&
            !previousProfitTruncated &&
            !marginUnknownEitherSide &&
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
        // Either reason a profit figure in this response is short: sales past
        // the costing cap, or consigned sales whose earning could not be
        // established. The comparison window counts — when its earnings cannot
        // be established the delta is withheld, and a consumer shown no delta
        // and no flag has no way to tell that from a period that did not move.
        profit: profitIncomplete || previousUnknownMarginExcluded,
        // Sales whose vehicle fell past the costing cap are left OUT of
        // turnover rather than folded in at gross, so the figure is short
        // rather than on two bases at once.
        //
        // Unknown earnings belong here too, and this is the flag that matters:
        // `truncated.profit` is read by NO consumer anywhere in the product.
        // Every "this total is short" marker — the web dashboard's trailing "+"
        // and its amber note, and the mobile home's equivalent — reads
        // `turnover` (and `sales`). Excluding an unknown-earning row from the
        // headline while leaving this false traded an overstated figure for an
        // understated one presented as exact, which is the same defect wearing
        // the other sign.
        turnover:
          turnoverTruncated ||
          previousTurnoverTruncated ||
          unknownMarginExcluded ||
          previousUnknownMarginExcluded,
        // Salespeople left out of the ranking because their earnings are not
        // fully known. The winner shown is the best COMPLETE record, which is a
        // true statement — but only if the consumer can tell it was drawn from
        // a shortened field.
        topPerformer: topPerformerIncomplete,
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
