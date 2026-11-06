import { v, type Infer } from "convex/values";
import { query } from "./_generated/server";
import { api } from "./_generated/api";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { canReadVehicleCost } from "./utils/vehicleCostVisibility";
import type { DealProfit } from "./utils/financingEconomics";

/**
 * One Deals-list row's cockpit facts: the car's photo, whether it is consigned,
 * the step rail, the selling price and the net profit.
 *
 * NOT a second derivation. Every figure here is read THROUGH the queries the
 * deal screen itself renders — `sales.dealCockpit` for a cash deal,
 * `applications.dealCockpit` plus `dealOverview.financedDealOverview` for a
 * financed one — in this query's snapshot (`ctx.runQuery`, the way
 * `dealOverview.financedDealOverview` already composes the cockpit). So the list
 * cannot show a profit, a step or a price the deal screen would not, and a
 * SOURCED car is never `salePrice - cost` here because nothing is computed here.
 *
 * One row per call, on purpose: the client subscribes per RENDERED row, so a
 * change to one deal re-runs that row's read and no other, where a batched read
 * re-runs every deal in the batch whenever any one of them changes.
 *
 * Authority: `view:sales` to read the row at all (the cockpits' own floor); the
 * money is whatever the cockpit serves this caller (`view:finance`); the net
 * profit also needs `view:cost_price` (SCRUM-902 c24475). Without it the
 * profit is `null` with a reason — never 0. The financed overview is still read
 * for the selling price when the cockpit serves money; its profit is withheld.
 */

const stageState = v.union(
  v.literal("COMPLETE"),
  v.literal("CURRENT"),
  v.literal("BLOCKED"),
  v.literal("PENDING"),
  v.literal("STOPPED"),
  v.literal("NOT_APPLICABLE")
);

/**
 * Declared, so the wire carries exactly these fields: a cockpit field added
 * later cannot reach the list by accident.
 */
const dealListRowFigures = v.object({
  /** The vehicle's first photo, only for a caller who may view vehicles. */
  photoUrl: v.union(v.string(), v.null()),
  /** SOURCED (consignment) by the cockpit's own classifier; null when the car is unreadable. */
  consigned: v.union(v.boolean(), v.null()),
  /** The cockpit's step rail in the server's order: keys and states only, no amounts. */
  stages: v.array(v.object({ key: v.string(), state: stageState })),
  /** Minor units of `currency`; null when the cockpit does not serve it to this caller. */
  sellingPriceMinor: v.union(v.number(), v.null()),
  /** Why `sellingPriceMinor` is null on a financed row; null when served, or on a sale (its price is on the list row). */
  sellingPriceReason: v.union(v.string(), v.null()),
  /** Minor units of `currency`; null unless the caller may read cost AND the cockpit publishes a figure. */
  netProfitMinor: v.union(v.number(), v.null()),
  /** Why `netProfitMinor` is null — the cockpit's own reason key — or null when it is served. */
  netProfitReason: v.union(v.string(), v.null()),
  /** The denomination of both amounts; null when neither is served. */
  currency: v.union(v.string(), v.null()),
});

export type DealListRowFigures = Infer<typeof dealListRowFigures>;

type NetProfit = Pick<DealListRowFigures, "netProfitMinor" | "netProfitReason">;

/** The cockpit's headline as the list carries it: its amount, or its reason for having none. */
function netProfitOf(profit: DealProfit | null | undefined): NetProfit {
  if (!profit) return { netProfitMinor: null, netProfitReason: "ProfitNotCalculable" };
  if (profit.available) return { netProfitMinor: profit.amountMinor, netProfitReason: null };
  return { netProfitMinor: null, netProfitReason: profit.reason };
}

/**
 * The permission gates, before the figure: cost first (SCRUM-902), then whether
 * the cockpit served this caller money at all. `money === null` for a caller
 * WITH finance access is the cockpit saying this screen has no figure (a sale
 * whose deal screen is its application), not a permission refusal.
 */
function gatedNetProfit(
  mayReadCost: boolean,
  maySeeMoney: boolean,
  moneyServed: boolean,
  profit: () => DealProfit | null | undefined
): NetProfit {
  if (!mayReadCost) return { netProfitMinor: null, netProfitReason: "CostAccessRequired" };
  if (!maySeeMoney) return { netProfitMinor: null, netProfitReason: "FinanceAccessRequired" };
  if (!moneyServed) return { netProfitMinor: null, netProfitReason: "ProfitNotCalculable" };
  return netProfitOf(profit());
}

export const figures = query({
  args: {
    orgId: v.id("organizations"),
    deal: v.union(
      v.object({ kind: v.literal("APPLICATION"), applicationId: v.id("financeApplications") }),
      v.object({ kind: v.literal("SALE"), saleId: v.id("sales") })
    ),
  },
  returns: v.union(dealListRowFigures, v.null()),
  handler: async (ctx, args): Promise<DealListRowFigures | null> => {
    // The org must be the authenticated caller's own membership: a foreign org
    // id is refused here, before anything is read.
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const mayReadCost = canReadVehicleCost(role);
    const maySeeMoney = isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_FINANCE);

    try {
      if (args.deal.kind === "SALE") {
        // TEN-1: this public reader owns its guard, before any delegation.
        const sale = await requireOwnedRow(ctx, args.orgId, "sales", args.deal.saleId);
        if (sale.isDeleted) return null;
        // Null for a missing, deleted or foreign sale.
        const cockpit = await ctx.runQuery(api.sales.dealCockpit, { orgId: args.orgId, saleId: args.deal.saleId });
        if (cockpit === null) return null;
        const money = cockpit.money;
        return {
          photoUrl: cockpit.vehicle?.profile?.photoUrl ?? null,
          consigned: cockpit.vehicle?.consigned ?? null,
          stages: cockpit.stages.map((stage) => ({ key: stage.key, state: stage.state })),
          // A sale's price is already on its list row (`sales.list`), served at `view:sales`.
          sellingPriceMinor: null,
          sellingPriceReason: null,
          ...gatedNetProfit(mayReadCost, maySeeMoney, money !== null, () => money?.managementNetProfit),
          currency: money?.currency ?? null,
        };
      }

      // Applications have no soft-delete field; missing and foreign rows use
      // the same generic null response via the catch below.
      await requireOwnedRow(ctx, args.orgId, "financeApplications", args.deal.applicationId);
      const cockpit = await ctx.runQuery(api.applications.dealCockpit, {
        orgId: args.orgId,
        applicationId: args.deal.applicationId,
      });
      if (cockpit === null) return null;
      // The overview is the financed cockpit's ONE profit and price authority
      // (`DealCockpit`'s `canonicalProfit`). Read only when the cockpit serves
      // this caller money; it withholds the profit itself without cost access.
      const summary =
        cockpit.money === null
          ? null
          : ((
              await ctx.runQuery(api.dealOverview.financedDealOverview, {
                orgId: args.orgId,
                applicationId: args.deal.applicationId,
              })
            )?.financialSummary ?? null);
      const sellingPriceMinor = summary?.customerSalePrice?.amountMinor ?? null;
      let sellingPriceReason: string | null = null;
      if (!maySeeMoney) sellingPriceReason = "FinanceAccessRequired";
      else if (sellingPriceMinor === null) sellingPriceReason = "PriceNotRecorded";
      return {
        photoUrl: cockpit.vehicle?.profile?.photoUrl ?? null,
        consigned: cockpit.vehicle?.consigned ?? null,
        stages: cockpit.stages.map((stage) => ({ key: stage.key, state: stage.state })),
        sellingPriceMinor,
        sellingPriceReason,
        ...gatedNetProfit(mayReadCost, maySeeMoney, summary !== null, () => summary?.profit),
        currency: summary?.currency ?? null,
      };
    } catch (error) {
      // One unreadable deal must not blank the whole list: the cause is logged
      // on the server and the row renders without its cockpit facts.
      console.error(error);
      return null;
    }
  },
});
