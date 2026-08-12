import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import {
  consignedSettlementRoute,
  dealershipCollectsGross,
  recordedConsignedMargin,
  recordedSupplierEntitlement,
  saleIsAgentSale,
  settlementPayer,
} from "./utils/vehicleOwnership";
import {
  deriveCashDealStages,
  deriveDealStages,
  obligationFromRow,
  type DealStage,
  type ObligationState,
} from "./utils/financingEconomics";

/**
 * THE UNIFIED DEAL QUEUE — a read projection, never a stored entity.
 *
 * SCRUM-63. The operator has one place to ask "what needs my attention?", and
 * clicking a row opens the deal's existing canonical screen. Nothing here
 * persists, nothing here mints a new Deal id, and nothing here is a second
 * source of truth about a deal's state.
 *
 * The three rules this file exists to enforce, all of which came out of the
 * SCRUM-63 architecture review:
 *
 * 1. **Server-side, not a client merge.** An earlier draft proposed unioning
 *    `applications.list` and `sales.list` in the browser. Both are
 *    independently cursored, so interleaving two cursors client-side produces
 *    an order that changes as pages load, and neither list knows about the
 *    other's rows — so a finalized financed deal would appear twice, once as
 *    its application and once as its sale. Dedup, ordering and identity are
 *    decided HERE, once.
 *
 * 2. **No money, at any permission level.** Every row is qualitative: who,
 *    what car, which stage, what is blocking, how long it has been waiting.
 *    `applications.list` spreads the whole application document and leaks
 *    financed amounts to anyone holding `view:sales`; this projection returns
 *    an explicit allow-list of fields and no amount appears in the type at
 *    all. That is a structural guarantee rather than a redaction pass that can
 *    be forgotten — see `deals.test.ts`, which asserts the shape.
 *
 * 3. **The stage and its blocker come from the SAME pure derivations the Deal
 *    screen uses** — `deriveDealStages` and `deriveCashDealStages`, fed the
 *    same facts. A queue that computed "what's blocking" its own cheaper way
 *    would be exactly the second source of truth the review forbade, and the
 *    disagreement would surface as a row saying one thing and the screen it
 *    opens saying another.
 */

/** How many rows the projection will scan per source before it stops. */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

/**
 * The views the queue offers.
 *
 * Deliberately absent: an "awaiting payment" view. A financed deal records
 * `expectedPaymentMethod`/`expectedPaymentDate`, but there is no payment stage
 * on either rail and a cash sale carries no payment fact at all — so a filter
 * by that name would answer a different question on each half of the queue.
 * The SCRUM-63 review reached the same conclusion about a cash PAYMENT stage:
 * do not invent the concept until the canonical evidence exists.
 */
export const dealQueueViewValidator = v.union(
  v.literal("ALL"),
  v.literal("NEEDS_ATTENTION"),
  v.literal("WAITING_ON_FINANCE"),
  v.literal("READY_FOR_HANDOVER"),
  v.literal("DEPOSIT_PENDING"),
  v.literal("CASH"),
  v.literal("FINANCED")
);

export type DealQueueView =
  | "ALL"
  | "NEEDS_ATTENTION"
  | "WAITING_ON_FINANCE"
  | "READY_FOR_HANDOVER"
  | "DEPOSIT_PENDING"
  | "CASH"
  | "FINANCED";

/**
 * One row of the queue.
 *
 * Every field is qualitative or an identifier. If you are about to add an
 * amount here, read rule 2 above first — the absence is the feature.
 */
export interface DealQueueRow {
  /** Stable React key. Prefixed because sale and application ids share a space visually, not structurally. */
  key: string;
  /** Where clicking the row goes — the deal's existing canonical screen. */
  href: string;
  dealKind: "CASH" | "FINANCED";
  /** Which record this row is keyed on. A financed deal moves from one to the other at finalization. */
  anchor: "APPLICATION" | "SALE";
  customerName: string;
  vehicleLabel: string;
  /** A real provider name, or null when there is none to show. */
  providerName: string | null;
  /** Set when there is no name — the client translates it, so it reads in the operator's language. */
  providerLabelKey: string | null;
  ownerName: string;
  /** The workflow status enum. The client owns the wording. */
  statusKey: string;
  /** The live stage — the first incomplete one — or null when the deal is finished or stopped. */
  stageKey: string | null;
  /** What is holding that stage up, when the derivation names a reason. */
  blockerKey: string | null;
  /** True when a human needs to do something. Drives both the default view and the sort. */
  needsAttention: boolean;
  /** A held deposit awaiting refund or forfeit — the state that lives ONLY on the old applications list today. */
  depositPending: boolean;
  /** When this deal last moved. Sales record no update time, so this is their creation. */
  lastActivityAt: number;
}

export interface DealQueueResult {
  rows: DealQueueRow[];
  /**
   * How many scanned deals fall in each view, so the view chips can carry a
   * number without a query each.
   *
   * Free: the projection builds every row before filtering, so this is a count
   * over work already done rather than seven more scans. But it counts the
   * SCANNED window only — when `truncated` is true these are lower bounds, and
   * the screen must say so rather than present them as totals.
   */
  counts: Record<DealQueueView, number>;
  /**
   * True when a source had more rows than the scan limit, so the queue is not
   * showing everything.
   *
   * Surfaced rather than swallowed. A silently truncated worklist reads as
   * "you are done", which is the most expensive possible lie for a screen
   * whose entire job is "what still needs attention".
   */
  truncated: boolean;
  limit: number;
}

/** A deal is stopped when the rail says every remaining stage will never happen. */
function isStopped(stages: DealStage[]): boolean {
  return stages.some((stage) => stage.state === "STOPPED");
}

/**
 * Whether a human still has to do something about this deal.
 *
 * The stage rail is the first authority, but it is NOT the only one, and
 * rendering the screen is what proved it: a REJECTED application holding a
 * customer's deposit has a fully stopped rail — every remaining stage will
 * never happen — so the queue announced "nothing outstanding" directly beside a
 * "deposit pending" badge on the same row. Both statements came from this
 * function and its caller, and they contradicted each other.
 *
 * A held deposit on a dead deal is money the dealership owes a real person and
 * has not yet refunded or forfeited. That is the definition of outstanding, and
 * a rejected deal is exactly when it is most likely to be forgotten.
 */
function needsAttention(stages: DealStage[], depositPending: boolean): boolean {
  if (depositPending) return true;
  return liveStage(stages) !== null && !isStopped(stages);
}

/** The live stage: the one the rail is focused on. Null on a finished or dead deal. */
function liveStage(stages: DealStage[]): DealStage | null {
  return stages.find((stage) => stage.state === "CURRENT" || stage.state === "BLOCKED") ?? null;
}

/**
 * Whether a held deposit is waiting on a refund/forfeit decision.
 *
 * The same rule `applications.list` applies, and deliberately the same shape:
 * only a rejected or cancelled application can strand a deposit, so the
 * deposit index is only consulted for those. Reproduced rather than imported
 * because `hasHeldQuoteDeposit` is private to `applications.ts`, and the
 * SCRUM-63 claim boundary keeps this change out of that file while another
 * session owns it. Tracked as a follow-up to share one helper.
 */
async function hasPendingDepositResolution(
  ctx: QueryCtx,
  app: Doc<"financeApplications">
): Promise<boolean> {
  if (app.status !== "REJECTED" && app.status !== "CANCELLED") return false;
  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_quote_status", (q) => q.eq("quoteId", app.quoteId).eq("status", "HELD"))) {
    if (deposit.isDeleted !== true) return true;
  }
  return false;
}

/**
 * Whether every required document on this application is verified or waived.
 *
 * Same filter the approval gate and the Deal screen apply — an org-wide rule,
 * or one belonging to this deal's company. Counting rules the gate ignores
 * would show the queue a checklist the dealership can never finish.
 *
 * `rules` is passed in because it is org-wide: fetching it per row turned one
 * query into forty.
 */
async function requiredDocumentsComplete(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  rules: Array<Doc<"companyDocumentRules">>,
  quoteCompanyId: Id<"financeCompanies"> | undefined
): Promise<boolean> {
  const applicable = rules.filter((rule) => !rule.companyId || rule.companyId === quoteCompanyId);
  const required = applicable.filter((rule) => rule.isRequired === true);
  if (required.length === 0) return true;

  const docRows = await ctx.db
    .query("applicationDocuments")
    .withIndex("by_application", (q) => q.eq("applicationId", app._id))
    .collect();
  const byRule = new Map(docRows.map((doc) => [doc.ruleId, doc]));

  return required.every((rule) => {
    const status = byRule.get(rule._id)?.status;
    return status === "VERIFIED" || status === "WAIVED";
  });
}

/**
 * Whether the supplier's obligation on a CASH sale is finished.
 *
 * Lifted from `sales.dealCockpit` unchanged in substance, including the part
 * that matters most: a consigned sale with no obligation row resolves as
 * UNKNOWN, not as settled. Missing evidence keeps the stage open. Reporting a
 * deal complete because its record could not be found is how a queue tells a
 * dealership there is nothing left to collect.
 */
async function cashSettlementComplete(
  ctx: QueryCtx,
  sale: Doc<"sales">,
  vehicle: Doc<"vehicles"> | null
): Promise<boolean> {
  if (sale.status === "CANCELLED") return true;

  const route = consignedSettlementRoute({ supplierSettlementRoute: sale.supplierSettlementRoute });
  const collectsGross = dealershipCollectsGross(route);
  const consigned = saleIsAgentSale({
    vehicle: vehicle ?? null,
    salePrice: sale.salePrice,
    recordedMargin: recordedConsignedMargin(sale),
    recordedSupplierEntitlement: recordedSupplierEntitlement(sale),
    settlesDirect: !collectsGross,
  });
  if (!consigned) return true;

  let obligation: ObligationState;
  if (collectsGross) {
    const payables = await ctx.db
      .query("vehicleSupplierPayables")
      .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
      .collect();
    const payable = payables.find((row) => row.orgId === sale.orgId && row.status !== "CANCELLED");
    obligation = payable
      ? obligationFromRow({
          due: payable.amountDue,
          settled: payable.amountPaid ?? 0,
          rowCurrency: payable.currency,
          queryCurrency: payable.currency,
          storedPaid: payable.status === "PAID",
        })
      : "UNKNOWN";
  } else {
    const receivables = await ctx.db
      .query("vehicleSupplierReceivables")
      .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
      .collect();
    const claim = receivables.find((row) => row.orgId === sale.orgId && row.status !== "CANCELLED");
    obligation = claim
      ? obligationFromRow({
          due: claim.amountDue,
          settled: claim.amountReceived ?? 0,
          rowCurrency: claim.currency,
          queryCurrency: claim.currency,
          storedPaid: claim.status === "PAID",
        })
      : "UNKNOWN";
  }

  return obligation === "CLOSED" || obligation === "NONE";
}

/** The provider name to show, or the key that explains why there is none. */
function providerLabels(
  app: Doc<"financeApplications">,
  company: Doc<"financeCompanies"> | null,
  quoteMode: Doc<"quotes">["mode"] | undefined
): { providerName: string | null; providerLabelKey: string | null } {
  const manual = app.manualFinanceSnapshot?.providerName?.trim() || undefined;
  const named = company?.name ?? manual;
  if (named) return { providerName: named, providerLabelKey: null };

  const payer = settlementPayer({
    quoteMode: app.quoteModeAtSubmission ?? quoteMode,
    financeCompanyId: app.companyId,
    manualProviderName: manual,
  });
  if (!payer.external) return { providerName: null, providerLabelKey: "CashOrDirect" };
  if (payer.counterparty === null && payer.unidentifiedReason === "LEASE") {
    return { providerName: null, providerLabelKey: "LeaseFinancing" };
  }
  return { providerName: null, providerLabelKey: "UnnamedFinanceProvider" };
}

/** Does this row belong in the requested view? */
function matchesView(row: DealQueueRow, view: DealQueueView): boolean {
  switch (view) {
    case "ALL":
      return true;
    case "NEEDS_ATTENTION":
      return row.needsAttention;
    case "WAITING_ON_FINANCE":
      // The deal is with the financing company and nobody at the dealership can
      // move it. This is the one view whose whole point is that there is
      // nothing to do — it answers "who has gone quiet", not "what can I do".
      return row.dealKind === "FINANCED" && row.blockerKey === "AwaitingCreditDecision";
    case "READY_FOR_HANDOVER":
      return row.stageKey === "HANDOVER";
    case "DEPOSIT_PENDING":
      return row.depositPending;
    case "CASH":
      return row.dealKind === "CASH";
    case "FINANCED":
      return row.dealKind === "FINANCED";
  }
}

export const queue = query({
  args: {
    orgId: v.id("organizations"),
    view: v.optional(dealQueueViewValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<DealQueueResult> => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const view: DealQueueView = args.view ?? "ALL";

    // Clamped rather than trusted. Convex accepts NaN and Infinity through
    // `v.number()`, and either one turns `.take()` into an unbounded scan on a
    // live subscription.
    const requested = args.limit;
    const limit =
      typeof requested === "number" && Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_LIMIT)
        : DEFAULT_LIMIT;

    // One extra row per source, purely to answer "is there more?" without a
    // second query. Never rendered.
    const scan = limit + 1;

    const [saleDocs, appDocs, rules] = await Promise.all([
      ctx.db
        .query("sales")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .order("desc")
        .take(scan),
      ctx.db
        .query("financeApplications")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .order("desc")
        .take(scan),
      ctx.db
        .query("companyDocumentRules")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect(),
    ]);

    const truncated = saleDocs.length > limit || appDocs.length > limit;
    const sales = saleDocs.slice(0, limit);
    const apps = appDocs.slice(0, limit);

    const rows: DealQueueRow[] = [];

    /**
     * Which applications are already represented by a sale row.
     *
     * This is the dedup, and it uses the same rule as the Deal screen's
     * `canonicalSaleId`: an application yields to its sale only when that sale
     * is READABLE — present, in this org, not soft-deleted. `finalizedSaleId`
     * survives `sales.softDelete` and nothing clears it, so trusting the
     * pointer alone would drop the application row while the sale row it
     * deferred to no longer exists, and the deal would vanish from the queue
     * entirely.
     */
    const representedByASale = new Set<string>();

    // --- sale-anchored rows: every cash deal, and every finalized financed one -
    for (const sale of sales) {
      const [vehicle, customer, salesperson] = await Promise.all([
        ctx.db.get(sale.vehicleId),
        ctx.db.get(sale.customerId),
        ctx.db.get(sale.salespersonId),
      ]);

      const app = sale.applicationId ? await ctx.db.get(sale.applicationId) : null;
      const application = app && app.orgId === args.orgId ? app : null;
      if (application) representedByASale.add(application._id);

      /**
       * FINANCED is a property of the SALE, not of whether an application row
       * exists — `sales.create` accepts a financing type and has no
       * `applicationId` field, so an applicationless financed sale is ordinary.
       * Deriving the kind from the application alone labelled those CASH.
       * Same rule `sales.dealCockpit` applies.
       */
      const externallyFinanced =
        sale.financingType === "FINANCED" || sale.financingType === "LEASE";
      const dealKind: "CASH" | "FINANCED" =
        application || externallyFinanced ? "FINANCED" : "CASH";

      let stages: DealStage[];
      let statusKey: string;
      let providerName: string | null = null;
      let providerLabelKey: string | null = null;
      let depositPending = false;

      if (application) {
        // The financed rail, from the application — the same delegation
        // `SaleDealCockpit` performs when it renders a financed sale.
        const [company, quote] = await Promise.all([
          application.companyId ? ctx.db.get(application.companyId) : Promise.resolve(null),
          ctx.db.get(application.quoteId),
        ]);
        const docsComplete = await requiredDocumentsComplete(
          ctx,
          application,
          rules,
          quote?.companyId
        );
        stages = deriveDealStages({
          settlementComplete: undefined,
          dealCancelled: sale.status === "CANCELLED",
          status: application.status,
          vehicleHandoverAt: application.vehicleHandoverAt,
          finalizedSaleId: application.finalizedSaleId,
          disbursedAt: application.disbursedAt,
          creditDecision: application.creditDecision,
          appraisalStatus: application.appraisalStatus,
          gapResolution: application.gapResolution,
          settlementStatus: application.settlementStatus,
          handoverStatus: application.handoverStatus,
          rawAppraisalGapMinor: application.rawAppraisalGapMinor,
          approvedDealerPurchaseAmountMinor: application.approvedDealerPurchaseAmountMinor,
          requiredDocumentsComplete: docsComplete,
        });
        statusKey = application.status;
        ({ providerName, providerLabelKey } = providerLabels(application, company, quote?.mode));
        depositPending = await hasPendingDepositResolution(ctx, application);
      } else {
        stages = deriveCashDealStages({
          saleStatus: sale.status,
          settlementComplete: await cashSettlementComplete(ctx, sale, vehicle),
        });
        statusKey = sale.status;
      }

      const live = liveStage(stages);
      rows.push({
        key: `sale:${sale._id}`,
        href: `/${args.orgId}/sales/${sale._id}/deal`,
        dealKind,
        anchor: "SALE",
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : "",
        vehicleLabel: vehicle ? `${vehicle.make} ${vehicle.model} ${vehicle.year}`.trim() : "",
        providerName,
        providerLabelKey,
        ownerName: salesperson?.name ?? salesperson?.email ?? "",
        statusKey,
        stageKey: live?.key ?? null,
        blockerKey: live?.blocker ?? null,
        needsAttention: needsAttention(stages, depositPending),
        depositPending,
        lastActivityAt: sale._creationTime,
      });
    }

    // --- application-anchored rows: financing not yet finalized into a sale ---
    for (const application of apps) {
      if (representedByASale.has(application._id)) continue;

      /**
       * An application naming a sale this scan did not reach is still
       * represented by that sale — the queue simply has not paged to it. Left
       * in, it would render a second row for the same deal at a different URL
       * the moment the sale fell past the limit, which is the duplicate the
       * projection exists to prevent. Validated the same way as the dedup
       * above: only a readable sale suppresses the application row.
       */
      if (application.finalizedSaleId) {
        const finalized = await ctx.db.get(application.finalizedSaleId);
        if (finalized && !finalized.isDeleted && finalized.orgId === args.orgId) continue;
      }

      const [customer, vehicle, salesperson, company, quote] = await Promise.all([
        ctx.db.get(application.customerId),
        ctx.db.get(application.vehicleId),
        ctx.db.get(application.salespersonId),
        application.companyId ? ctx.db.get(application.companyId) : Promise.resolve(null),
        ctx.db.get(application.quoteId),
      ]);

      const docsComplete = await requiredDocumentsComplete(
        ctx,
        application,
        rules,
        quote?.companyId
      );
      const stages = deriveDealStages({
        settlementComplete: undefined,
        status: application.status,
        vehicleHandoverAt: application.vehicleHandoverAt,
        finalizedSaleId: application.finalizedSaleId,
        disbursedAt: application.disbursedAt,
        creditDecision: application.creditDecision,
        appraisalStatus: application.appraisalStatus,
        gapResolution: application.gapResolution,
        settlementStatus: application.settlementStatus,
        handoverStatus: application.handoverStatus,
        rawAppraisalGapMinor: application.rawAppraisalGapMinor,
        approvedDealerPurchaseAmountMinor: application.approvedDealerPurchaseAmountMinor,
        requiredDocumentsComplete: docsComplete,
      });

      const live = liveStage(stages);
      const { providerName, providerLabelKey } = providerLabels(application, company, quote?.mode);
      const depositPending = await hasPendingDepositResolution(ctx, application);
      rows.push({
        key: `application:${application._id}`,
        href: `/${args.orgId}/applications/${application._id}/deal`,
        dealKind: "FINANCED",
        anchor: "APPLICATION",
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : "",
        vehicleLabel: vehicle ? `${vehicle.make} ${vehicle.model} ${vehicle.year}`.trim() : "",
        providerName,
        providerLabelKey,
        ownerName: salesperson?.name ?? "",
        statusKey: application.status,
        stageKey: live?.key ?? null,
        blockerKey: live?.blocker ?? null,
        needsAttention: needsAttention(stages, depositPending),
        depositPending,
        lastActivityAt: application.updatedAt ?? application.createdAt,
      });
    }

    /**
     * Attention first, then longest-waiting first.
     *
     * Not newest-first, which is what both existing lists do. This queue exists
     * to answer "what needs me", and the deal that has been stuck longest is
     * the one nobody has looked at — putting it last is how a financing company
     * goes quiet for three weeks without anyone noticing. Finished and stopped
     * deals sort below everything actionable regardless of age.
     */
    const ALL_VIEWS: DealQueueView[] = [
      "ALL",
      "NEEDS_ATTENTION",
      "WAITING_ON_FINANCE",
      "READY_FOR_HANDOVER",
      "DEPOSIT_PENDING",
      "CASH",
      "FINANCED",
    ];
    const counts = Object.fromEntries(
      ALL_VIEWS.map((key) => [key, rows.filter((row) => matchesView(row, key)).length])
    ) as Record<DealQueueView, number>;

    const filtered = rows.filter((row) => matchesView(row, view));
    filtered.sort((a, b) => {
      if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
      return a.lastActivityAt - b.lastActivityAt;
    });

    return { rows: filtered, counts, truncated, limit };
  },
});
