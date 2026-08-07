import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  assessConsignedSale,
  isAutomaticallyCorrectable,
  systemKeyByAccountId,
  type ConsignedSaleAssessment,
} from "./sourcedAgentImpact";
import { hookConsignedSaleReclassified } from "./accounting/workflowHooks";
import { auditLog } from "./financialAudit";

/**
 * Restates historical consigned sales from principal to agent basis.
 *
 * ## What it corrects, and why that is safe to automate
 *
 * A SOURCED vehicle is legally the supplier's. Every sale of one already on the
 * books was posted as though the dealership owned it: gross revenue, cost of
 * sales for a car it never bought. Those two offset, so the sale's contribution
 * to PROFIT was always right — what is wrong is that turnover and cost of sales
 * are both inflated by the supplier's share.
 *
 * That makes the correction a pure P&L reclassification:
 *
 *     Dr  Sales Revenue                    12,500
 *       Cr  Consignment Commission Revenue  3,000
 *       Cr  Cost of Vehicles Sold           9,500
 *
 * Nothing on the balance sheet moves, because nothing on it was wrong: the
 * original posting debited AR-Customers for the gross and credited AP-Suppliers
 * for the entitlement, and agent basis does exactly the same.
 *
 * ## What it refuses to correct
 *
 * Only rows `sourcedSaleImpactReport` reports as unflagged. The decision is not
 * re-implemented here — it is `assessConsignedSale` + `isAutomaticallyCorrectable`,
 * the same functions the report calls, so the report cannot approve one set of
 * rows while this rewrites another. A sale with no supplier cost, a negative
 * margin, relieved inventory, multiple posted journals, or a profit that would
 * move is counted and left alone for a human.
 *
 * ## Idempotency
 *
 * Two independent layers, because one is not enough to make the claim.
 *
 *  1. The GL: `hookConsignedSaleReclassified` keys on the sale, and
 *     postOrEnqueue drops an event whose key is already POSTED or already
 *     queued. A second run posts nothing even if everything else were wrong.
 *  2. This module: a `consignedSaleCorrections` row per sale, checked first.
 *     It exists so the audit trail is not duplicated either, and so a re-run
 *     can report "already corrected" rather than silently doing nothing.
 *
 * A re-run is therefore a no-op with a zero financial effect, which is the
 * requirement — not merely unlikely to double-post.
 *
 * ## Shape
 *
 * One paginated query over `sales`, everything else by index. Convex permits a
 * single paginated query per function, and `convex-test` does NOT enforce that
 * — a previous backfill in this repo passed 2,115 tests and full CI, then
 * failed on its first production call. Do not add a second `.paginate()` here.
 */

/** Small enough that one page cannot approach the transaction's read/write limits. */
const SALE_BATCH_SIZE = 25;

type Report = {
  /** SCHEDULED while pages remain; COMPLETE only on the final one. */
  status: "SCHEDULED" | "COMPLETE";
  /** True when nothing was written — the run only reported what it would do. */
  dryRun: boolean;
  salesScanned: number;
  consignedSalesFound: number;
  corrected: number;
  alreadyCorrected: number;
  alreadyAgentBasis: number;
  /** Left for a human because the impact report flags them. */
  flagged: number;
  revenueReclassifiedMinor: number;
  commissionRecognizedMinor: number;
  cogsReversedMinor: number;
  /** Asserted zero per row; summed here so the whole run can be checked at a glance. */
  netIncomeDeltaMinor: number;
};

const EMPTY_REPORT: Report = {
  status: "SCHEDULED",
  dryRun: false,
  salesScanned: 0,
  consignedSalesFound: 0,
  corrected: 0,
  alreadyCorrected: 0,
  alreadyAgentBasis: 0,
  flagged: 0,
  revenueReclassifiedMinor: 0,
  commissionRecognizedMinor: 0,
  cogsReversedMinor: 0,
  netIncomeDeltaMinor: 0,
};

const reportValidator = v.object({
  status: v.union(v.literal("SCHEDULED"), v.literal("COMPLETE")),
  dryRun: v.boolean(),
  salesScanned: v.number(),
  consignedSalesFound: v.number(),
  corrected: v.number(),
  alreadyCorrected: v.number(),
  alreadyAgentBasis: v.number(),
  flagged: v.number(),
  revenueReclassifiedMinor: v.number(),
  commissionRecognizedMinor: v.number(),
  cogsReversedMinor: v.number(),
  netIncomeDeltaMinor: v.number(),
});

/**
 * Who the correction is recorded as having been made by.
 *
 * A migration has no signed-in user, but `financialAuditLog.actorId` and
 * `journalEntries.postedBy` are both required — and rightly so, because an
 * accounting entry nobody is accountable for is not an audit trail. The
 * organization's owner is the closest true answer available: the correction is
 * made on the dealership's behalf, under its own books.
 */
async function correctionActorFor(
  ctx: MutationCtx,
  orgId: Id<"organizations">
): Promise<Id<"users"> | null> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(100);
  for (const membership of memberships) {
    const role = await ctx.db.get(membership.roleId);
    if (role?.isSystemOwnerRole === true) return membership.userId;
  }
  return memberships[0]?.userId ?? null;
}

/** The journal entry the correction event produced, if it posted rather than queued. */
async function correctionJournalEntryFor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<Id<"journalEntries"> | undefined> {
  const event = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey)
    )
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();
  if (!event) return undefined;
  const entry = await ctx.db
    .query("journalEntries")
    .withIndex("by_accounting_event", (q) => q.eq("accountingEventId", event._id))
    .first();
  return entry?._id;
}

async function correctOneSale(
  ctx: MutationCtx,
  args: {
    sale: Doc<"sales">;
    assessment: ConsignedSaleAssessment;
    actorId: Id<"users">;
  }
): Promise<{ netIncomeDeltaMinor: number }> {
  const { sale, assessment, actorId } = args;
  const revenueMinor = assessment.posted.revenueMinor;
  const cogsMinor = assessment.posted.cogsMinor;
  // Not null: a null margin raises NO_SOURCE_COST, which disqualifies the row.
  const commissionMinor = assessment.dealershipMarginMinor!;

  // Defence in depth. `isAutomaticallyCorrectable` already excluded any row
  // where this does not hold, but the whole licence to run unattended rests on
  // it, so it is asserted at the point of writing rather than inferred from a
  // check made earlier against data that has since been re-read.
  const netIncomeDeltaMinor = commissionMinor + cogsMinor - revenueMinor;
  if (netIncomeDeltaMinor !== 0) {
    throw new Error(
      `Refusing to correct sale ${sale._id}: the restatement would move net income by ${netIncomeDeltaMinor} minor units.`
    );
  }

  await hookConsignedSaleReclassified(ctx, {
    orgId: sale.orgId,
    saleId: sale._id,
    vehicleId: sale.vehicleId,
    customerId: sale.customerId,
    currency: assessment.currency,
    revenueMinor,
    commissionMinor,
    cogsMinor,
    actorId,
    // Dated to the sale, so the correction lands in the period whose numbers
    // it corrects. Where that period is closed the event queues rather than
    // posting, which is the outbox behaving as designed.
    occurredAt: sale.saleDate,
  });

  const correctionJournalEntryId = await correctionJournalEntryFor(
    ctx,
    sale.orgId,
    `consigned_agent_reclass_${sale._id}`
  );

  await ctx.db.insert("consignedSaleCorrections", {
    orgId: sale.orgId,
    saleId: sale._id,
    vehicleId: sale.vehicleId,
    currency: assessment.currency,
    originalJournalEntryIds: assessment.journalEntryIds,
    correctionJournalEntryId,
    revenueReclassifiedMinor: revenueMinor,
    commissionRecognizedMinor: commissionMinor,
    cogsReversedMinor: cogsMinor,
    netIncomeDeltaMinor,
    correctedBy: actorId,
    correctedAt: Date.now(),
  });

  await auditLog(ctx, {
    orgId: sale.orgId,
    actorId,
    actionType: "MIGRATE_TRANSACTION",
    resourceType: "sales",
    resourceId: sale._id,
    description: `Restated consigned sale to agent basis: removed ${revenueMinor} vehicle revenue and ${cogsMinor} cost, recognized ${commissionMinor} commission. Net income unchanged.`,
    before: {
      basis: "PRINCIPAL",
      revenueMinor,
      cogsMinor,
      journalEntryIds: assessment.journalEntryIds,
    },
    after: {
      basis: "CONSIGNED_AGENT",
      commissionRevenueMinor: commissionMinor,
      cogsMinor: 0,
      correctionJournalEntryId,
    },
    // Recorded for tracing, NOT for deduplication: `auditLog` stores this key
    // and never reads it, so this insert is unconditional. The
    // `consignedSaleCorrections` pre-check is the only thing keeping the audit
    // trail from duplicating on a re-run — do not remove it on the assumption
    // that this key protects anything.
    idempotencyKey: `consigned_agent_reclass_${sale._id}`,
  });

  return { netIncomeDeltaMinor };
}

export const migrateConsignedSaleBasis = internalMutation({
  args: {
    /** Omit to sweep every organization. */
    orgId: v.optional(v.id("organizations")),
    /**
     * Report what would change and write nothing. Run this first, reconcile it
     * against sourcedSaleImpactReport, and only then run for real.
     */
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    report: v.optional(reportValidator),
  },
  // Explicit return type is required, not stylistic: a self-scheduling handler
  // without one makes its own inferred type circular, and TypeScript reports
  // the resulting failure in whichever unrelated files happen to import the
  // generated api — hundreds of errors nowhere near the cause.
  handler: async (ctx, args): Promise<Report> => {
    const dryRun = args.dryRun ?? false;
    const report: Report = { ...EMPTY_REPORT, ...args.report, dryRun };

    // The one paginated query. Scoped to an org when asked, which is how a
    // dealership is migrated on its own after its own impact report was read.
    const page = args.orgId
      ? await ctx.db
          .query("sales")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId!))
          .paginate({ cursor: args.cursor ?? null, numItems: SALE_BATCH_SIZE })
      : await ctx.db
          .query("sales")
          .paginate({ cursor: args.cursor ?? null, numItems: SALE_BATCH_SIZE });

    // Per-org, and only for orgs this page actually touches — the chart is a
    // full table read, so hoisting it out of the sale loop is the difference
    // between one read per page and one per sale.
    const keyByAccountCache = new Map<string, Map<string, string>>();
    // Memoized for the same reason as the chart: it is constant per org, and
    // resolving it per sale cost a `memberships.take(100)` plus one role read
    // each — up to ~2,500 extra document reads on a 25-sale page.
    const actorCache = new Map<string, Id<"users"> | null>();

    for (const sale of page.page) {
      report.salesScanned += 1;
      if (sale.status !== "COMPLETED" || sale.isDeleted === true) continue;

      const vehicle = await ctx.db.get(sale.vehicleId);
      if (!vehicle || vehicle.sourceType !== "SOURCED") continue;
      report.consignedSalesFound += 1;

      const existing = await ctx.db
        .query("consignedSaleCorrections")
        .withIndex("by_org_sale", (q) => q.eq("orgId", sale.orgId).eq("saleId", sale._id))
        .first();
      if (existing) {
        report.alreadyCorrected += 1;
        continue;
      }

      let keyByAccount = keyByAccountCache.get(sale.orgId);
      if (!keyByAccount) {
        keyByAccount = await systemKeyByAccountId(ctx, sale.orgId);
        keyByAccountCache.set(sale.orgId, keyByAccount);
      }

      const assessment = await assessConsignedSale(ctx, {
        orgId: sale.orgId,
        sale,
        vehicle,
        keyByAccount,
      });

      if (assessment.alreadyAgentBasis) {
        report.alreadyAgentBasis += 1;
        continue;
      }
      if (!isAutomaticallyCorrectable(assessment)) {
        report.flagged += 1;
        continue;
      }

      // Resolved before the dry-run short-circuit, so a dry run predicts what
      // the real run will actually do. Checking it afterwards meant the one
      // function whose entire purpose is prediction reported as `corrected`
      // rows the real run would report as `flagged`.
      let actorId = actorCache.get(sale.orgId);
      if (actorId === undefined) {
        actorId = await correctionActorFor(ctx, sale.orgId);
        actorCache.set(sale.orgId, actorId);
      }
      if (actorId === null) {
        // An org with no members cannot have an accountable actor, and an
        // accounting entry nobody is accountable for is not one this may write.
        // Counted as flagged so the number of untouched rows stays truthful.
        report.flagged += 1;
        continue;
      }

      report.corrected += 1;
      report.revenueReclassifiedMinor += assessment.posted.revenueMinor;
      report.commissionRecognizedMinor += assessment.dealershipMarginMinor ?? 0;
      report.cogsReversedMinor += assessment.posted.cogsMinor;

      if (dryRun) continue;

      const { netIncomeDeltaMinor } = await correctOneSale(ctx, { sale, assessment, actorId });
      report.netIncomeDeltaMinor += netIncomeDeltaMinor;
    }

    if (page.isDone) {
      report.status = "COMPLETE";
      return report;
    }

    await ctx.scheduler.runAfter(0, internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis, {
      orgId: args.orgId,
      dryRun,
      cursor: page.continueCursor,
      report,
    });
    return report;
  },
});
