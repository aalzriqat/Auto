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
import { hookConsignedSaleReclassified, shouldPost } from "./accounting/workflowHooks";
import { auditLog } from "./financialAudit";
import { fromMinorUnits } from "./utils/money";

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
 *     can report on a sale it has already seen rather than silently doing
 *     nothing.
 *
 * A re-run is therefore a no-op with a zero financial effect, which is the
 * requirement — not merely unlikely to double-post.
 *
 * ## Queued is not corrected
 *
 * The correction is dated to the sale so it lands in the period it corrects,
 * and those periods are usually CLOSED — which means the ordinary outcome of
 * `hookConsignedSaleReclassified` is that the event QUEUES to the outbox rather
 * than posting. A `consignedSaleCorrections` row therefore carries a status,
 * and only `POSTED` means a journal exists:
 *
 *   PENDING_POSTING → POSTED                (the outbox drained it)
 *                   → FAILED                (it dead-lettered, or never queued)
 *                   → REQUIRES_RECONCILIATION (ledger settled, something else isn't)
 *
 * A re-run promotes PENDING_POSTING rows whose journal has since appeared and
 * retries FAILED ones, both against the SAME correction row, the same event
 * idempotency key and no second audit entry — a retry can add a journal that
 * was missing but can never add a second of anything. `reconcileConsignedSaleCorrections`
 * does the promotion on its own, without re-scanning every sale.
 *
 * Recording a queued correction as complete is the specific defect this
 * replaces: the pre-check reported `alreadyCorrected` forever while the books
 * were never touched.
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
  /**
   * Sales this run acted on: it created the correction and its event.
   *
   * NOT the same as "posted". A correction dated into a closed period queues,
   * and the two counters below say how these actually landed — `corrected` is
   * only ever the sum of them plus any that failed.
   */
  corrected: number;
  /** Of `corrected`: journals that exist right now. */
  postedNow: number;
  /** Of `corrected`: durably queued to the outbox, awaiting an open period. */
  queuedNow: number;
  /** Rows this run promoted from PENDING_POSTING to POSTED — their journal had since appeared. */
  reconciledToPosted: number;
  /** Correction rows seen again that are already POSTED. Nothing to do. */
  alreadyCorrected: number;
  /** Correction rows still waiting on the outbox. Re-run after the period opens. */
  awaitingPosting: number;
  /** Corrections whose operational transaction row a human has to resolve — see `reportingBasisReason`. Independent of the journal state. */
  requiresReconciliation: number;
  /** Correction rows whose event neither posted nor queued. Retried on the next run. */
  failed: number;
  alreadyAgentBasis: number;
  /** Left for a human because the impact report flags them. */
  flagged: number;
  /** Of `corrected`: sales whose reporting basis was restated on the transaction row too. */
  reportingBasisBackfilled: number;
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
  postedNow: 0,
  queuedNow: 0,
  reconciledToPosted: 0,
  alreadyCorrected: 0,
  awaitingPosting: 0,
  requiresReconciliation: 0,
  failed: 0,
  alreadyAgentBasis: 0,
  flagged: 0,
  reportingBasisBackfilled: 0,
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
  postedNow: v.number(),
  queuedNow: v.number(),
  reconciledToPosted: v.number(),
  alreadyCorrected: v.number(),
  awaitingPosting: v.number(),
  requiresReconciliation: v.number(),
  failed: v.number(),
  alreadyAgentBasis: v.number(),
  flagged: v.number(),
  reportingBasisBackfilled: v.number(),
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

const correctionKeyFor = (saleId: Id<"sales">): string => `consigned_agent_reclass_${saleId}`;

type CorrectionOutcome =
  | { status: "POSTED"; journalEntryId: Id<"journalEntries"> | undefined }
  | { status: "PENDING_POSTING" }
  | { status: "FAILED"; reason: string };

/**
 * What actually became of a correction event — asked of the ledger and the
 * outbox, never inferred from the fact that the hook returned without throwing.
 *
 * `postOrEnqueue` does one of three things and reports none of them: it posts,
 * it enqueues, or it returns early because the work was already done. Only the
 * first has written a journal, and treating the other two as if it had is what
 * let a queued correction be recorded as complete.
 */
async function correctionOutcomeFor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<CorrectionOutcome> {
  const posted = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey)
    )
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();
  if (posted) {
    const entry = await ctx.db
      .query("journalEntries")
      .withIndex("by_accounting_event", (q) => q.eq("accountingEventId", posted._id))
      .first();
    return { status: "POSTED", journalEntryId: entry?._id };
  }

  const queued = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey)
    )
    .first();
  if (queued) {
    // FAILED in the outbox means dead-lettered: MAX_ATTEMPTS is spent and
    // nothing retries it on its own. That is a failure with a durable record,
    // not a pending state, and calling it pending would leave a correction
    // waiting forever on a drain that has already given up.
    if (queued.status === "FAILED") {
      return {
        status: "FAILED",
        reason: `The correction event dead-lettered in the outbox after ${queued.attempts} attempts: ${queued.lastError ?? "no error recorded"}`,
      };
    }
    return { status: "PENDING_POSTING" };
  }

  return {
    status: "FAILED",
    reason:
      "The correction event neither posted nor queued. The organization most likely has no chart of accounts, so there is nothing to post to.",
  };
}

/**
 * Restates the sale's operational transaction row onto the agent basis.
 *
 * `getProfitAndLoss` and the dashboard's transaction fallback sum `transactions`
 * as revenue, so correcting the journal alone leaves a sourced month reporting
 * 12,500 of turnover in the P&L against 3,000 in the sales report. Writing
 * `recognizedRevenueAmount` is what makes the three agree about history.
 *
 * Refuses to guess. `transactions` carries no sale id — only a vehicle — so the
 * row is identified by (org, vehicle, IN, VEHICLE_SALE) and accepted ONLY when
 * there is exactly one of it and its amount is the full sale price. A vehicle
 * sold twice, a deal whose deposits were booked as separate revenue rows, a
 * manually edited amount: each of those needs a person, and each is reported as
 * REQUIRES_RECONCILIATION rather than restated on a guess.
 */
async function backfillReportingBasis(
  ctx: MutationCtx,
  args: {
    sale: Doc<"sales">;
    /** The dealership's margin, in major units — what turnover should now be. */
    recognizedRevenue: number;
    dryRun: boolean;
  }
): Promise<
  | { ok: true; restated: boolean; transactionId: Id<"transactions"> | undefined }
  | { ok: false; reason: string }
> {
  const { sale } = args;
  const candidates = (
    await ctx.db
      .query("transactions")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", sale.orgId).eq("vehicleId", sale.vehicleId))
      .collect()
  ).filter((tx) => tx.isDeleted !== true && tx.type === "IN" && tx.category === "VEHICLE_SALE");

  // Nothing to restate rather than something to worry about: with no
  // vehicle-sale row, the P&L never counted this sale's gross as revenue, so
  // there is no overstatement to remove. Reported as unchanged, not as needing
  // a human — an operator who is told to reconcile a sale where nothing is
  // wrong stops reading the list.
  if (candidates.length === 0) {
    return { ok: true, restated: false, transactionId: undefined };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `${candidates.length} vehicle-sale transactions exist for this vehicle, so which one belongs to this sale cannot be determined. Restate the reporting basis by hand.`,
    };
  }

  const tx = candidates[0];
  // A row netted down by deposits already booked as revenue elsewhere. The
  // margin cannot simply be written here: part of the gross is recognized on
  // other rows in possibly other periods, and netting it out of this one would
  // move revenue between months to make a total come out right.
  if (Math.abs(tx.amount - sale.salePrice) > 1e-6) {
    return {
      ok: false,
      reason: `The vehicle-sale transaction is ${tx.amount} against a sale price of ${sale.salePrice} — deposits or an edit have already changed it, so the agent-basis amount cannot be derived from this row alone.`,
    };
  }

  if (!args.dryRun) {
    await ctx.db.patch(tx._id, { recognizedRevenueAmount: args.recognizedRevenue });
  }
  return { ok: true, restated: true, transactionId: tx._id };
}

async function correctOneSale(
  ctx: MutationCtx,
  args: {
    sale: Doc<"sales">;
    assessment: ConsignedSaleAssessment;
    actorId: Id<"users">;
  }
): Promise<{
  netIncomeDeltaMinor: number;
  status: "PENDING_POSTING" | "POSTED" | "FAILED";
  reportingBasisBackfilled: boolean;
  reportingBasisNeedsHuman: boolean;
}> {
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

  const idempotencyKey = correctionKeyFor(sale._id);
  const outcome = await correctionOutcomeFor(ctx, sale.orgId, idempotencyKey);

  // The reporting basis, restated on the operational ledger so the P&L stops
  // reporting this sale's gross as turnover. Attempted whatever the journal
  // did: the two are separate ledgers with separate failure modes, and holding
  // the reporting fix hostage to a period that happens to be closed would leave
  // the back-book disagreeing with itself for as long as the outbox is backed
  // up. `commissionMinor` is the same margin the journal recognizes.
  const basis = await backfillReportingBasis(ctx, {
    sale,
    recognizedRevenue: fromMinorUnits(commissionMinor, assessment.currency),
    dryRun: false,
  });

  // The two ledgers are recorded separately. Collapsing them meant a queued
  // correction whose transaction row needed a human was filed under a status
  // the reconciler never scans, so its journal id was never written and the
  // impact report kept reporting a corrected sale as fully overstated —
  // an invitation to post the correction a second time by hand.
  const status = outcome.status;
  const statusReason = outcome.status === "FAILED" ? outcome.reason : undefined;

  await ctx.db.insert("consignedSaleCorrections", {
    orgId: sale.orgId,
    saleId: sale._id,
    vehicleId: sale.vehicleId,
    currency: assessment.currency,
    originalJournalEntryIds: assessment.journalEntryIds,
    status,
    statusReason,
    reportingBasisStatus: basis.ok ? "RESTATED" : "REQUIRES_RECONCILIATION",
    reportingBasisReason: basis.ok ? undefined : basis.reason,
    eventIdempotencyKey: idempotencyKey,
    correctionJournalEntryId:
      outcome.status === "POSTED" ? outcome.journalEntryId : undefined,
    postedAt: outcome.status === "POSTED" ? Date.now() : undefined,
    recognizedRevenueTransactionId: basis.ok ? basis.transactionId : undefined,
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
      // What the correction actually did, not what it was asked to do. A
      // queued correction says so here rather than leaving a blank that reads
      // like a posting with a missing id.
      correctionStatus: status,
      correctionJournalEntryId:
        outcome.status === "POSTED" ? outcome.journalEntryId : undefined,
    },
    // Recorded for tracing, NOT for deduplication: `auditLog` stores this key
    // and never reads it, so this insert is unconditional. The
    // `consignedSaleCorrections` pre-check is the only thing keeping the audit
    // trail from duplicating on a re-run — do not remove it on the assumption
    // that this key protects anything.
    idempotencyKey,
  });

  return {
    netIncomeDeltaMinor,
    status,
    reportingBasisBackfilled: basis.ok && basis.restated,
    reportingBasisNeedsHuman: !basis.ok,
  };
}

/**
 * Brings an existing correction row up to date with what the ledger now says.
 *
 * Used both by a re-run of the migration and by `reconcileConsignedSaleCorrections`.
 * It patches the SAME row, reuses the SAME event idempotency key and writes no
 * audit entry — the audit entry was written when the correction was made, and
 * a promotion from queued to posted is not a second correction. A FAILED row is
 * re-hooked, which is safe for exactly the same reason: `postOrEnqueue` keys on
 * the idempotency key, so the retry can supply a journal that was missing but
 * cannot supply a second one.
 */
async function refreshCorrection(
  ctx: MutationCtx,
  correction: Doc<"consignedSaleCorrections">
): Promise<"POSTED" | "PENDING_POSTING" | "FAILED" | "UNCHANGED"> {
  // Only the journal's own state is terminal here. A row whose reporting basis
  // still needs a human is NOT terminal: its journal must still be promoted
  // when the outbox drains, or its id is never recorded and the impact report
  // reports an already-corrected sale as untouched.
  if (correction.status === "POSTED") return "UNCHANGED";

  const idempotencyKey = correction.eventIdempotencyKey ?? correctionKeyFor(correction.saleId);

  if (correction.status === "FAILED") {
    // Re-raise the event. Whatever blocked it — no chart of accounts, a period
    // that had not been created — may since have been fixed, and there is no
    // other path that would notice.
    const sale = await ctx.db.get(correction.saleId);
    if (sale && sale.orgId === correction.orgId) {
      await hookConsignedSaleReclassified(ctx, {
        orgId: correction.orgId,
        saleId: correction.saleId,
        vehicleId: correction.vehicleId,
        customerId: sale.customerId,
        currency: correction.currency,
        revenueMinor: correction.revenueReclassifiedMinor,
        commissionMinor: correction.commissionRecognizedMinor,
        cogsMinor: correction.cogsReversedMinor,
        actorId: correction.correctedBy,
        occurredAt: sale.saleDate,
      });
    }
  }

  const outcome = await correctionOutcomeFor(ctx, correction.orgId, idempotencyKey);
  if (outcome.status === "PENDING_POSTING" && correction.status === "PENDING_POSTING") {
    return "UNCHANGED";
  }

  await ctx.db.patch(correction._id, {
    status: outcome.status,
    statusReason: outcome.status === "FAILED" ? outcome.reason : undefined,
    ...(outcome.status === "POSTED"
      ? { correctionJournalEntryId: outcome.journalEntryId, postedAt: Date.now() }
      : {}),
  });
  return outcome.status;
}

/**
 * Promotes queued corrections whose journals have since been drained.
 *
 * The migration itself can do this, but only by re-reading every sale in the
 * organization. After a closed period is reopened and the outbox drains, this
 * is the cheap way to make the correction records say what the ledger says —
 * one paginated query over the corrections themselves.
 */
export const reconcileConsignedSaleCorrections = internalMutation({
  args: {
    orgId: v.optional(v.id("organizations")),
    cursor: v.optional(v.string()),
    scanned: v.optional(v.number()),
    promoted: v.optional(v.number()),
    stillPending: v.optional(v.number()),
    failed: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    status: "SCHEDULED" | "COMPLETE";
    scanned: number;
    promoted: number;
    stillPending: number;
    failed: number;
  }> => {
    let scanned = args.scanned ?? 0;
    let promoted = args.promoted ?? 0;
    let stillPending = args.stillPending ?? 0;
    let failed = args.failed ?? 0;

    // The single paginated query. Indexed on status so a large corrected
    // back-book does not have to be walked to find the few still waiting.
    const page = await ctx.db
      .query("consignedSaleCorrections")
      .withIndex("by_status", (q) => q.eq("status", "PENDING_POSTING"))
      .paginate({ cursor: args.cursor ?? null, numItems: SALE_BATCH_SIZE });

    for (const correction of page.page) {
      if (args.orgId && correction.orgId !== args.orgId) continue;
      scanned += 1;
      const result = await refreshCorrection(ctx, correction);
      if (result === "POSTED") promoted += 1;
      else if (result === "FAILED") failed += 1;
      else stillPending += 1;
    }

    if (page.isDone) {
      return { status: "COMPLETE", scanned, promoted, stillPending, failed };
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrateConsignedSaleBasis.reconcileConsignedSaleCorrections,
      { orgId: args.orgId, cursor: page.continueCursor, scanned, promoted, stillPending, failed }
    );
    return { status: "SCHEDULED", scanned, promoted, stillPending, failed };
  },
});

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
        // Seen before — but "seen" is not "corrected". Ask the ledger what
        // became of it and, on a real run, bring the row up to date: promote a
        // queued correction whose journal has since drained, retry one whose
        // event never landed. Same row, same idempotency key, no second audit
        // entry and no second journal.
        const settled = dryRun ? existing.status : await refreshCorrection(ctx, existing);
        const effective = settled === "UNCHANGED" ? existing.status : settled;
        if (effective === "POSTED") {
          if (existing.status === "PENDING_POSTING") report.reconciledToPosted += 1;
          else report.alreadyCorrected += 1;
        } else if (effective === "PENDING_POSTING") {
          report.awaitingPosting += 1;
        } else {
          report.failed += 1;
        }
        // Counted alongside the journal state, not instead of it: a correction
        // can be fully posted and still have a transaction row nobody could
        // identify.
        if (existing.reportingBasisStatus === "REQUIRES_RECONCILIATION") {
          report.requiresReconciliation += 1;
        }
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

      if (dryRun) {
        // Predict how it would land rather than reporting a bare count. Whether
        // the correction posts or queues is decided by whether an open period
        // covers the sale date, which is knowable without writing anything —
        // and a dry run that cannot distinguish the two is exactly the report
        // that made a queued correction look complete.
        const basis = await backfillReportingBasis(ctx, {
          sale,
          recognizedRevenue: fromMinorUnits(
            assessment.dealershipMarginMinor ?? 0,
            assessment.currency
          ),
          dryRun: true,
        });
        // Counted exactly as the real run counts it, so the two reports are
        // comparable line for line — including the case where the journal
        // posts and the transaction row still needs a person.
        if (!basis.ok) report.requiresReconciliation += 1;
        else if (basis.restated) report.reportingBasisBackfilled += 1;
        if (await shouldPost(ctx, sale.orgId, sale.saleDate)) report.postedNow += 1;
        else report.queuedNow += 1;
        continue;
      }

      const { netIncomeDeltaMinor, status, reportingBasisBackfilled, reportingBasisNeedsHuman } =
        await correctOneSale(ctx, { sale, assessment, actorId });
      report.netIncomeDeltaMinor += netIncomeDeltaMinor;
      if (status === "POSTED") report.postedNow += 1;
      else if (status === "PENDING_POSTING") report.queuedNow += 1;
      else report.failed += 1;
      if (reportingBasisBackfilled) report.reportingBasisBackfilled += 1;
      if (reportingBasisNeedsHuman) report.requiresReconciliation += 1;
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
