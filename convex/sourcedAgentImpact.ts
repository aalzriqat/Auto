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
 *
 * `assessConsignedSale` below is shared with the migration deliberately. The
 * migration's contract is "correct only what this report says is safe", and two
 * copies of that judgement would eventually disagree — at which point the
 * report would be approving one set of rows and the migration rewriting
 * another.
 */

const REPORTED_KEYS = [
  SYSTEM_KEYS.SALES_REVENUE,
  SYSTEM_KEYS.COST_OF_VEHICLES_SOLD,
  SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS,
  SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS,
  SYSTEM_KEYS.VEHICLE_INVENTORY,
] as const;

type PostedTotals = Record<string, { debitMinor: number; creditMinor: number }>;

export async function systemKeyByAccountId(
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

export type ConsignedSaleAssessment = {
  saleId: Id<"sales">;
  saleDate: number;
  vehicleId: Id<"vehicles">;
  vehicle: string;
  vin: string | undefined;
  supplierName: string | null;
  currency: string;
  financingType: string | null;
  grossTransactionMinor: number;
  supplierEntitlementMinor: number | null;
  dealershipMarginMinor: number | null;
  posted: {
    revenueMinor: number;
    cogsMinor: number;
    customerArMinor: number;
    supplierApMinor: number;
    inventoryReliefMinor: number;
    grossProfitMinor: number;
  };
  shouldBe: {
    commissionRevenueMinor: number | null;
    cogsMinor: number;
    inventoryReliefMinor: number;
  };
  overstatement: {
    revenueMinor: number | null;
    cogsMinor: number;
    customerArMinor: number | null;
  };
  journalEntryIds: Id<"journalEntries">[];
  flags: string[];
  /**
   * Already posted on agent basis — no vehicle revenue and no COGS to reclassify.
   * Deliberately NOT a flag: a flag means "a human must look at this", and a
   * correctly-posted sale needs no attention. It is tracked separately so the
   * migratable count means "rows the migration will actually change".
   */
  alreadyAgentBasis: boolean;
};

/**
 * The single judgement of what one consigned sale posted and whether it can be
 * corrected automatically. Used by the report to describe rows, and by the
 * migration to decide which ones it may touch.
 */
export async function assessConsignedSale(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    sale: Doc<"sales">;
    vehicle: Doc<"vehicles">;
    keyByAccount: Map<string, string>;
  }
): Promise<ConsignedSaleAssessment> {
  const { orgId, sale, vehicle, keyByAccount } = args;

  const entries = await ctx.db
    .query("journalEntries")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "sales").eq("sourceId", sale._id)
    )
    .collect();
  // A correction posts a SECOND entry against the same sale. Counting it as an
  // original would report every migrated sale as MULTIPLE_POSTED_JOURNALS with
  // its pre-correction revenue apparently intact — telling an accountant the
  // migration did nothing, and inviting a manual journal that corrects it
  // twice. `alreadyCorrected` is what the sale's basis is read from instead.
  const posted = entries.filter((e) => e.status === "POSTED");
  const correctionEntryIds = new Set(
    (
      await ctx.db
        .query("consignedSaleCorrections")
        .withIndex("by_org_sale", (q) => q.eq("orgId", orgId).eq("saleId", sale._id))
        .collect()
    ).flatMap((c) => (c.correctionJournalEntryId ? [c.correctionJournalEntryId as string] : []))
  );
  const alreadyCorrected = correctionEntryIds.size > 0;
  const live = posted.filter((e) => !correctionEntryIds.has(e._id));

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
  // Already on agent basis either because it was posted that way, or because a
  // recorded correction put it there. A sale with NO posted journal at all is
  // neither — it books nothing, which is an anomaly to investigate, not a
  // correctly-posted agency sale.
  const alreadyAgentBasis =
    alreadyCorrected || (live.length > 0 && postedRevenue === 0 && postedCogs === 0);

  const flags: string[] = [];
  if (live.length === 0) flags.push("NO_POSTED_JOURNAL");
  if (live.length > 1) flags.push("MULTIPLE_POSTED_JOURNALS");
  if (entitlementMinor === null) flags.push("NO_SOURCE_COST");
  if (marginMinor !== null && marginMinor < 0) flags.push("NEGATIVE_MARGIN");
  if (postedInventoryRelief > 0) flags.push("INVENTORY_RELIEVED_ON_CONSIGNED_CAR");
  if (
    vehicle.purchasePrice &&
    vehicle.purchasePrice > 0 &&
    entitlementMinor !== null &&
    toMinorUnits(vehicle.purchasePrice, currency) !== entitlementMinor
  ) {
    // Two different figures for what this car cost, and no way to tell which
    // one the supplier is actually owed. Correcting the sale means asserting
    // one of them as his entitlement, which is a decision about somebody's
    // money, so it goes to a human.
    //
    // Carrying a purchase price at all was previously enough to flag the row,
    // on the reading that the car might have been bought in and never
    // reclassified. That reading is settled: `sourceType: SOURCED` is a
    // reliable business invariant for consigned accounting, so a SOURCED
    // vehicle is the supplier's regardless of what else is recorded against
    // it. The broader flag was also measurably useless — on production 39 of
    // 42 consigned vehicles carry a purchase price, including both that have
    // sold, so it disqualified every row the migration existed to correct
    // while catching no actual ambiguity in most of them.
    flags.push("SOURCED_COST_CONFLICT");
  }
  if (!alreadyAgentBasis && marginMinor !== null && postedGrossProfit !== marginMinor) {
    // The reclassification-not-restatement claim fails here. Correcting
    // this row WOULD move reported profit, so it must not be migrated
    // silently.
    flags.push("PROFIT_WOULD_CHANGE");
  }

  return {
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
      revenueMinor: alreadyCorrected ? 0 : marginMinor === null ? null : postedRevenue - marginMinor,
      cogsMinor: alreadyCorrected ? 0 : postedCogs,
      customerArMinor: entitlementMinor === null ? null : postedCustomerAr - (marginMinor ?? 0),
    },
    journalEntryIds: live.map((e) => e._id),
    flags,
    alreadyAgentBasis,
  };
}

/**
 * Whether the migration may correct this row without a human first looking at
 * it. Any flag disqualifies it, and a row already on agent basis has nothing to
 * correct.
 */
export function isAutomaticallyCorrectable(assessment: ConsignedSaleAssessment): boolean {
  return assessment.flags.length === 0 && !assessment.alreadyAgentBasis;
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
      let alreadyAgentBasisCount = 0;
      let migratableCount = 0;

      for (const sale of sales) {
        if (sale.status !== "COMPLETED") continue;
        const vehicle = await ctx.db.get(sale.vehicleId);
        if (!vehicle || vehicle.sourceType !== "SOURCED") continue;

        const row = await assessConsignedSale(ctx, {
          orgId: org._id,
          sale,
          vehicle,
          keyByAccount,
        });

        if (row.flags.length > 0) anomalies.push(row);
        if (row.alreadyAgentBasis) alreadyAgentBasisCount += 1;
        if (isAutomaticallyCorrectable(row)) migratableCount += 1;
        rows.push(row);

        // A corrected sale no longer overstates anything, so it contributes
        // nothing to the overstatement totals — otherwise the report would keep
        // quoting the full pre-migration figure after the migration ran.
        if (!row.alreadyAgentBasis) {
          grossPostedRevenueMinor += row.posted.revenueMinor;
          correctRevenueMinor += row.dealershipMarginMinor ?? 0;
          postedCogsMinor += row.posted.cogsMinor;
        }
        postedCustomerArMinor += row.posted.customerArMinor;
        postedSupplierApMinor += row.posted.supplierApMinor;
      }

      perOrg.push({
        orgId: org._id,
        orgName: org.name,
        salesExamined: sales.length,
        sourcedSalesFound: rows.length,
        anomalyCount: anomalies.length,
        // Rows the migration would actually change. Previously this was
        // `rows - anomalies`, which counted sales already correctly posted on
        // agent basis as pending work and would have overstated the expected
        // effect of the migration on every re-read after a partial run.
        migratableCount,
        alreadyAgentBasisCount,
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
