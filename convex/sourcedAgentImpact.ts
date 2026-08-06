import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { QueryCtx } from "./_generated/server";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { toMinorUnits } from "./utils/money";

/**
 * What a completed sale of a SOURCED vehicle actually posted, against what
 * consigned-agent accounting says it should have.
 *
 * Read-only, by design and by requirement: the business rule is that a SOURCED
 * vehicle is legally the supplier's, so the dealership sells as agent and may
 * recognize only its margin. Every such sale already on the books was posted as
 * a principal sale — gross revenue, fabricated COGS, a customer receivable for
 * money the customer never owed the dealership. Before any of that is rewritten
 * there has to be a report somebody can read and disagree with.
 *
 * The finding this report exists to prove or disprove, per deal: the correction
 * is a RECLASSIFICATION, not a restatement of profit. Principal posting books
 * revenue 12,500 / COGS 9,500 for a gross profit of 3,000; agent posting books
 * commission 3,000 and no COGS. Same bottom line, four inflated accounts. If
 * that holds for every row, the migration cannot change reported profit and the
 * risk is confined to classification. Where it does NOT hold, the row is
 * flagged rather than corrected — see `anomalies`.
 */

const REPORTED_KEYS = [
  SYSTEM_KEYS.SALES_REVENUE,
  SYSTEM_KEYS.COST_OF_VEHICLES_SOLD,
  SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS,
  SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS,
  SYSTEM_KEYS.VEHICLE_INVENTORY,
] as const;

type PostedTotals = Record<string, { debitMinor: number; creditMinor: number }>;

async function systemKeyByAccountId(
  ctx: QueryCtx,
  orgId: Id<"organizations">
): Promise<Map<string, string>> {
  const accounts = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const map = new Map<string, string>();
  for (const account of accounts) {
    if (account.systemKey) map.set(account._id, account.systemKey);
  }
  return map;
}

/**
 * The supplier's entitlement on a sourced vehicle.
 *
 * `sourceCost` is what the dealership agreed the supplier gets — the figure the
 * existing posting already credits to AP-Suppliers. Absent, there is no
 * entitlement to net against and no margin can be derived. That is reported as
 * an anomaly rather than defaulted to zero: zero would silently claim the whole
 * transaction as the dealership's margin, which is the same overstatement this
 * report exists to find, just in the opposite direction.
 */
function supplierEntitlementMinor(
  vehicle: Doc<"vehicles">,
  currency: string
): number | null {
  if (vehicle.sourceCost === undefined || vehicle.sourceCost === null) return null;
  if (!Number.isFinite(vehicle.sourceCost) || vehicle.sourceCost < 0) return null;
  return toMinorUnits(vehicle.sourceCost, currency);
}

export const sourcedSaleImpactReport = internalQuery({
  args: {
    /** Omit to sweep every organization. */
    orgId: v.optional(v.id("organizations")),
    /** Cap on sales examined per org, newest first. */
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const orgs = args.orgId
      ? [await ctx.db.get(args.orgId)].filter((o): o is Doc<"organizations"> => o !== null)
      : await ctx.db.query("organizations").collect();

    const perOrg = [];
    for (const org of orgs) {
      const keyByAccount = await systemKeyByAccountId(ctx, org._id);

      const sales = await ctx.db
        .query("sales")
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .order("desc")
        .take(args.limit ?? 500);

      const rows = [];
      const anomalies = [];
      let grossPostedRevenueMinor = 0;
      let correctRevenueMinor = 0;
      let postedCogsMinor = 0;
      let postedCustomerArMinor = 0;
      let postedSupplierApMinor = 0;

      for (const sale of sales) {
        if (sale.status !== "COMPLETED") continue;
        const vehicle = await ctx.db.get(sale.vehicleId);
        if (!vehicle || vehicle.sourceType !== "SOURCED") continue;

        const entries = await ctx.db
          .query("journalEntries")
          .withIndex("by_org_source", (q) =>
            q.eq("orgId", org._id).eq("sourceType", "sales").eq("sourceId", sale._id)
          )
          .collect();
        const live = entries.filter((e) => e.status === "POSTED");

        const totals: PostedTotals = {};
        for (const entry of live) {
          const lines = await ctx.db
            .query("journalLines")
            .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
            .collect();
          for (const l of lines) {
            const key = keyByAccount.get(l.accountId);
            if (!key || !REPORTED_KEYS.includes(key as (typeof REPORTED_KEYS)[number])) continue;
            const bucket = (totals[key] ??= { debitMinor: 0, creditMinor: 0 });
            bucket.debitMinor += l.debitMinor;
            bucket.creditMinor += l.creditMinor;
          }
        }

        const currency = live[0]?.currency ?? "JOD";
        const grossMinor = toMinorUnits(sale.salePrice, currency);
        const entitlementMinor = supplierEntitlementMinor(vehicle, currency);

        const postedRevenue = totals[SYSTEM_KEYS.SALES_REVENUE]?.creditMinor ?? 0;
        const postedCogs = totals[SYSTEM_KEYS.COST_OF_VEHICLES_SOLD]?.debitMinor ?? 0;
        const postedCustomerAr = totals[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]?.debitMinor ?? 0;
        const postedSupplierAp = totals[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]?.creditMinor ?? 0;
        const postedInventoryRelief = totals[SYSTEM_KEYS.VEHICLE_INVENTORY]?.creditMinor ?? 0;

        const marginMinor = entitlementMinor === null ? null : grossMinor - entitlementMinor;
        const postedGrossProfit = postedRevenue - postedCogs;

        const flags: string[] = [];
        if (live.length === 0) flags.push("NO_POSTED_JOURNAL");
        if (live.length > 1) flags.push("MULTIPLE_POSTED_JOURNALS");
        if (entitlementMinor === null) flags.push("NO_SOURCE_COST");
        if (marginMinor !== null && marginMinor < 0) flags.push("NEGATIVE_MARGIN");
        if (postedInventoryRelief > 0) flags.push("INVENTORY_RELIEVED_ON_CONSIGNED_CAR");
        if (vehicle.purchasePrice && vehicle.purchasePrice > 0) {
          // Marked SOURCED but carries an own-purchase price: either it was
          // bought in and never reclassified, or the price is stale. Requirement
          // 8 calls these out for manual reconciliation instead of migrating.
          flags.push("SOURCED_BUT_HAS_PURCHASE_PRICE");
        }
        if (marginMinor !== null && postedGrossProfit !== marginMinor) {
          // The reclassification-not-restatement claim fails here. Correcting
          // this row WOULD move reported profit, so it must not be migrated
          // silently.
          flags.push("PROFIT_WOULD_CHANGE");
        }

        const row = {
          saleId: sale._id,
          saleDate: sale.saleDate,
          vehicleId: vehicle._id,
          vehicle: `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim(),
          vin: vehicle.vin,
          supplierName: vehicle.sourcedFromName ?? null,
          currency,
          financingType: sale.financingType ?? null,
          grossTransactionMinor: grossMinor,
          supplierEntitlementMinor: entitlementMinor,
          dealershipMarginMinor: marginMinor,
          posted: {
            revenueMinor: postedRevenue,
            cogsMinor: postedCogs,
            customerArMinor: postedCustomerAr,
            supplierApMinor: postedSupplierAp,
            inventoryReliefMinor: postedInventoryRelief,
            grossProfitMinor: postedGrossProfit,
          },
          shouldBe: {
            commissionRevenueMinor: marginMinor,
            cogsMinor: 0,
            inventoryReliefMinor: 0,
          },
          overstatement: {
            revenueMinor: marginMinor === null ? null : postedRevenue - marginMinor,
            cogsMinor: postedCogs,
            customerArMinor: entitlementMinor === null ? null : postedCustomerAr - (marginMinor ?? 0),
          },
          journalEntryIds: live.map((e) => e._id),
          flags,
        };

        if (flags.length > 0) anomalies.push(row);
        rows.push(row);

        grossPostedRevenueMinor += postedRevenue;
        correctRevenueMinor += marginMinor ?? 0;
        postedCogsMinor += postedCogs;
        postedCustomerArMinor += postedCustomerAr;
        postedSupplierApMinor += postedSupplierAp;
      }

      perOrg.push({
        orgId: org._id,
        orgName: org.name,
        salesExamined: sales.length,
        sourcedSalesFound: rows.length,
        anomalyCount: anomalies.length,
        migratableCount: rows.length - anomalies.length,
        totals: {
          postedRevenueMinor: grossPostedRevenueMinor,
          correctCommissionRevenueMinor: correctRevenueMinor,
          revenueOverstatementMinor: grossPostedRevenueMinor - correctRevenueMinor,
          postedCogsMinor,
          postedCustomerArMinor,
          postedSupplierApMinor,
        },
        anomalies,
        rows,
      });
    }

    return {
      generatedAt: Date.now(),
      // Stated so a reader knows what the numbers do and do not authorize.
      basis:
        "SOURCED vehicles are supplier-owned; the dealership sells as agent and may recognize only its margin. Rows carrying any flag are NOT safe to migrate automatically.",
      orgs: perOrg,
    };
  },
});
