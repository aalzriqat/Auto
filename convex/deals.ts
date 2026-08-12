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
import { getOrgCurrency } from "./accounting/workflowHooks";

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
 * The held-deposit scan is bounded independently of the caller's page size.
 *
 * Held deposits are filtered AFTER the scan, down to the few whose deal was
 * rejected or cancelled — so a bound tied to `limit` lets deposits on live deals
 * crowd out the ones the DEPOSIT_PENDING view exists to show.
 */
const DEPOSIT_SCAN_CAP = MAX_LIMIT + 1;

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
  /**
   * When this deal last moved. Sales record no update time, so this is their
   * creation.
   *
   * ⚠️ NOT when the current stage began — the model records no such timestamp,
   * and an edit that changes nothing about the stage still advances this. It
   * measures silence, and the UI may only claim silence.
   */
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
  /**
   * The bound applied to each individual SCAN — not a cap on `rows`.
   *
   * `rows` is deliberately never sliced to it. Trimming the result would mean
   * choosing, on the server, which outstanding deals an operator does not get
   * to see, on the one screen whose purpose is that nothing outstanding goes
   * unnoticed. A scan that stopped early reports itself through `truncated`;
   * work that was found is always returned.
   */
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

  /**
   * The currency the deal is READ in — the sale frozen it, or the org current one.
   *
   * Passing the row own currency for both sides of `obligationFromRow` (which
   * an earlier revision did) makes its mismatch guard trivially true, so a
   * payable denominated in a currency the deal does not use resolved as CLOSED
   * on the strength of its stored status alone. `sales.dealCockpit` returns
   * UNKNOWN for exactly that row and keeps the settlement stage open, so the
   * queue reported a deal finished while the screen it opens said it was not —
   * the one disagreement this projection exists to make impossible.
   */
  const currency = sale.consignedMarginCurrency ?? (await getOrgCurrency(ctx, sale.orgId));

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
          queryCurrency: currency,
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
          queryCurrency: currency,
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

/**
 * Hydrate one candidate into a row, or drop it.
 *
 * One function for both anchors rather than two near-identical loops: the
 * previous shape duplicated the stage derivation, the provider labels and the
 * deposit lookup, and the two copies had already begun to differ.
 */
async function buildRow(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    key: string;
    sale: Doc<"sales"> | null;
    application: Doc<"financeApplications"> | null;
    rules: Array<Doc<"companyDocumentRules">>;
    /**
     * The subledger still carries an open obligation against this sale.
     *
     * Used in ONE direction only: it can refuse to call a deal settled, and it
     * can never declare one settled. Declaring settlement is the cockpit's job —
     * it resolves route, currency and entitlement to do so, and a second
     * derivation of that here would be a second answer waiting to disagree.
     *
     * The asymmetry is the point. Without it, `deriveDealStages` falls back to
     * `settlementStatus` alone, so a financed deal stamped FULLY_SETTLED reads
     * as finished even though an open payable is what put it in this queue —
     * the supplier sweep would surface the row and then mark it needing
     * nothing. Erring the other way merely shows a human a deal they can close.
     */
    hasOpenObligation: boolean;
  }
): Promise<DealQueueRow | null> {
  const { sale, application, rules, orgId } = args;
  if (!sale && !application) return null;

  /**
   * Hydration fails CLOSED on tenancy.
   *
   * These ids are followed out of documents already proven to be in this org,
   * so this is not the caller-supplied-id case `requireOwnedRow` exists for —
   * one reviewer verified as much, and the shipped `sales.dealCockpit` and
   * `applications.dealCockpit` follow the same ids without re-checking. But a
   * Convex id carries a TABLE, not an organization, and the super-admin raw
   * record editor can write any field on any row. Re-checking costs one
   * comparison and turns "another tenant's customer name renders here" from a
   * data-integrity assumption into an impossibility.
   */
  const inOrg = <T extends { orgId?: Id<"organizations"> }>(doc: T | null): T | null =>
    doc && doc.orgId === orgId ? doc : null;

  const vehicleId = sale?.vehicleId ?? application!.vehicleId;
  const customerId = sale?.customerId ?? application!.customerId;
  const salespersonId = sale?.salespersonId ?? application!.salespersonId;

  const [vehicleDoc, customerDoc, salesperson] = await Promise.all([
    ctx.db.get(vehicleId),
    ctx.db.get(customerId),
    ctx.db.get(salespersonId),
  ]);
  const vehicle = inOrg(vehicleDoc);
  const customer = inOrg(customerDoc);

  let stages: DealStage[];
  let statusKey: string;
  let providerName: string | null = null;
  let providerLabelKey: string | null = null;
  let depositPending = false;
  let dealKind: "CASH" | "FINANCED";

  if (application) {
    const [companyDoc, quoteDoc] = await Promise.all([
      application.companyId ? ctx.db.get(application.companyId) : Promise.resolve(null),
      ctx.db.get(application.quoteId),
    ]);
    const company = inOrg(companyDoc);
    const quote = inOrg(quoteDoc);
    const docsComplete = await requiredDocumentsComplete(ctx, application, rules, quote?.companyId);

    stages = deriveDealStages({
      settlementComplete: args.hasOpenObligation ? false : undefined,
      dealCancelled: sale?.status === "CANCELLED",
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
    dealKind = "FINANCED";
  } else {
    const cashSale = sale!;
    stages = deriveCashDealStages({
      saleStatus: cashSale.status,
      settlementComplete: args.hasOpenObligation
        ? false
        : await cashSettlementComplete(ctx, cashSale, vehicle),
    });
    statusKey = cashSale.status;
    // FINANCED is a property of the SALE, not of whether an application row
    // exists: `sales.create` accepts a financing type and has no `applicationId`
    // field, so an applicationless financed sale is ordinary. Deriving the kind
    // from the application alone labelled those CASH.
    dealKind =
      cashSale.financingType === "FINANCED" || cashSale.financingType === "LEASE"
        ? "FINANCED"
        : "CASH";
  }

  const live = liveStage(stages);
  const anchoredOnSale = sale !== null;

  return {
    key: args.key,
    href: anchoredOnSale
      ? `/${orgId}/sales/${sale!._id}/deal`
      : `/${orgId}/applications/${application!._id}/deal`,
    dealKind,
    anchor: anchoredOnSale ? "SALE" : "APPLICATION",
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
    // Sales record no update time, so a sale-anchored row without an
    // application falls back to its creation.
    lastActivityAt:
      application?.updatedAt ?? application?.createdAt ?? sale?._creationTime ?? 0,
  };
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

    /**
     * CANDIDATES ARE OPEN WORK, NOT RECENT ROWS.
     *
     * This is the correction two independent adversarial reviews demanded, and
     * both reproduced the defect it fixes: the first version scanned the newest
     * `limit` rows of each table and only then sorted oldest-first, so a deal
     * old enough to be pushed past that window by newer activity vanished from
     * every view. On the one screen whose stated purpose is to surface the
     * longest-stuck work, the longest-stuck work was the first thing dropped —
     * and `truncated: true` said "there is more", never "and the oldest is
     * missing". That is the steady state for any dealership after a few weeks,
     * not an edge case.
     *
     * So actionable candidates are reached through STATUS indexes and are
     * age-independent: an application sitting with the finance company for
     * three months is found because of what it IS, not when it was created.
     * History is a different question with a different shape, and only the
     * history views carry a bounded window.
     */
    const ACTIONABLE_APP_STATUSES = [
      "DRAFT",
      "PENDING_DOCS",
      "UNDER_REVIEW",
      "APPROVED",
    ] as const;

    /** Views that ask about finished work as well as open work. */
    const wantsHistory = view === "ALL" || view === "CASH" || view === "FINANCED";
    const cap = limit + 1;

    const [appPages, openSales, heldDeposits, rules, historySales, historyApps] =
      await Promise.all([
        Promise.all(
          ACTIONABLE_APP_STATUSES.map((status) =>
            ctx.db
              .query("financeApplications")
              .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
              .take(cap)
          )
        ),
        ctx.db
          .query("sales")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
          .filter((q) => q.neq(q.field("isDeleted"), true))
          .take(cap),
        // A held deposit is the ONLY thing that makes a rejected or cancelled
        // deal actionable, and it is indexed directly — so that population is
        // reached by what it is rather than through a window over dead rows.
        //
        // Its bound is DELIBERATELY not `cap`. Only a fraction of held deposits
        // belong to a rejected or cancelled deal, and the filter that finds them
        // runs after this scan — so on a floor with many live deposits, a
        // `limit`-sized page fills with rows that all fail the filter and the
        // DEPOSIT_PENDING view renders empty while unresolved deposits exist.
        // `truncated` still tells the truth, but a view that shows nothing is a
        // poor way to say "there is more". A cap that does not shrink with the
        // caller's page size costs one wider scan of a small table.
        ctx.db
          .query("deposits")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "HELD"))
          .take(DEPOSIT_SCAN_CAP),
        ctx.db
          .query("companyDocumentRules")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect(),
        wantsHistory
          ? ctx.db
              .query("sales")
              .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
              .filter((q) => q.neq(q.field("isDeleted"), true))
              .order("desc")
              .take(cap)
          : Promise.resolve([] as Array<Doc<"sales">>),
        wantsHistory
          ? ctx.db
              .query("financeApplications")
              .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
              .order("desc")
              .take(cap)
          : Promise.resolve([] as Array<Doc<"financeApplications">>),
      ]);

    /**
     * Deals whose supplier is still owed, however old the deal is.
     *
     * Closing the last hole the status-driven scan left open. A CLOSED
     * application or a COMPLETED sale is not an "open status", but it is still
     * actionable while the supplier has not been paid or has not paid back the
     * dealership's margin — and that is money, on a deal everyone has already
     * mentally filed as finished. Reached through the subledger's own
     *  index, so it is found by being unsettled rather than by
     * being recent.
     */
    const OPEN_PAYABLE_STATUSES = [
      "PENDING",
      "NOT_YET_DUE",
      "DUE_ON_SALE",
      "PARTIALLY_PAID",
      "DISPUTED",
    ] as const;
    const OPEN_RECEIVABLE_STATUSES = ["OPEN", "PARTIALLY_PAID", "DISPUTED"] as const;

    const [payablePages, receivablePages] = await Promise.all([
      Promise.all(
        OPEN_PAYABLE_STATUSES.map((status) =>
          ctx.db
            .query("vehicleSupplierPayables")
            .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
            .take(cap)
        )
      ),
      Promise.all(
        OPEN_RECEIVABLE_STATUSES.map((status) =>
          ctx.db
            .query("vehicleSupplierReceivables")
            .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
            .take(cap)
        )
      ),
    ]);

    const unsettledSaleIds = new Set<string>();
    for (const row of [...payablePages.flat(), ...receivablePages.flat()]) {
      if (row.saleId) unsettledSaleIds.add(row.saleId);
    }
    const unsettledSales = (
      await Promise.all(
        Array.from(unsettledSaleIds).map((id) => ctx.db.get(id as Id<"sales">))
      )
    ).filter(
      (sale): sale is Doc<"sales"> =>
        sale !== null && sale.orgId === args.orgId && sale.isDeleted !== true
    );

    /**
     * Applications made actionable by a deposit nobody has resolved.
     *
     * Resolved deposit-first through `by_vehicle` rather than by scanning dead
     * applications: `financeApplications` has no `by_quote` index, and a window
     * over rejected rows would reintroduce exactly the age bias this section
     * exists to remove.
     */
    const depositApps = (
      await Promise.all(
        heldDeposits
          .filter((deposit) => deposit.isDeleted !== true)
          .map(async (deposit) => {
            // Resolved by CUSTOMER, not by the deposit vehicle. A quote can
            // carry several cars, so the deposit vehicle and the application
            // vehicle are not the same field on a multi-vehicle deal and
            // matching on it silently missed those deposits entirely. A
            // customer own applications are few, and the index is exact.
            const linked = await ctx.db
              .query("financeApplications")
              .withIndex("by_customer", (q) => q.eq("customerId", deposit.customerId))
              .collect();
            return linked.filter(
              (app) =>
                app.orgId === args.orgId &&
                app.quoteId === deposit.quoteId &&
                (app.status === "REJECTED" || app.status === "CANCELLED")
            );
          })
      )
    ).flat();

    /**
     * EVERY capped scan reports its own overflow. No exceptions.
     *
     * The previous version checked the sales, deposit and application buckets
     * and silently omitted the two supplier-obligation sweeps, which are capped
     * exactly like the others. An independent review reproduced the
     * consequence: put more open payables in one status than a page holds, and
     * the obligation past the cap left `unsettledSaleIds`, left the candidate
     * set, and left NEEDS_ATTENTION — while this function still answered
     * `truncated: false`. Unpaid supplier money, on deals already filed as
     * finished, hidden by a queue asserting it had shown everything.
     *
     * So overflow is derived from the pages themselves rather than restated per
     * source. A capped page is `limit + 1` rows wide precisely so that "one more
     * than fits" is observable, and every such page is now folded in here — the
     * bug was possible only because one scan could be added without its cap
     * being accounted for.
     *
     * Per STATUS, not per flattened list: `[...a, ...b].length > limit` would
     * fire on two half-full buckets that lost nothing, and stay silent on the
     * one bucket that actually did.
     */
    const overflowed = (pages: Array<Array<unknown>>): boolean =>
      pages.some((page) => page.length > limit);

    const actionableOverflow =
      // Measured against its own wider bound, since that is the bound it was
      // actually cut off at.
      heldDeposits.length > DEPOSIT_SCAN_CAP - 1 ||
      overflowed([openSales, ...appPages, ...payablePages, ...receivablePages]);
    const truncated = actionableOverflow || overflowed([historySales, historyApps]);

    /**
     * One entry per DEAL, keyed on the identity its row will use.
     *
     * Identity is resolved BEFORE hydration and independently of any window.
     * The previous version suppressed an application row whenever its finalized
     * sale existed, trusting the sale row to represent the deal — true only if
     * that sale also happened to be inside its own window. When it was not,
     * both representations disappeared and the deal was absent from the queue
     * entirely. Resolving the anchor from the sale document fetched by id
     * removes the dependency on windows altogether.
     */
    type Candidate = {
      sale: Doc<"sales"> | null;
      application: Doc<"financeApplications"> | null;
    };
    const candidates = new Map<string, Candidate>();

    const addApplication = async (application: Doc<"financeApplications">) => {
      const finalized = application.finalizedSaleId
        ? await ctx.db.get(application.finalizedSaleId)
        : null;
      const readableSale =
        finalized && !finalized.isDeleted && finalized.orgId === args.orgId ? finalized : null;
      const key = readableSale ? `sale:${readableSale._id}` : `application:${application._id}`;
      const existing = candidates.get(key);
      candidates.set(key, { sale: readableSale ?? existing?.sale ?? null, application });
    };

    const addSale = async (sale: Doc<"sales">) => {
      const linked = sale.applicationId ? await ctx.db.get(sale.applicationId) : null;
      const application = linked && linked.orgId === args.orgId ? linked : null;
      const key = `sale:${sale._id}`;
      const existing = candidates.get(key);
      candidates.set(key, { sale, application: application ?? existing?.application ?? null });
    };

    /**
     * Sales first, then applications — the order is the dedup.
     *
     * A candidate sale claims its linked application, so the application loop
     * must be able to see that claim; running both together let a COMPLETED
     * sale and its still-open application each mint their own key and the deal
     * rendered twice. Sequencing the two phases is what makes the sale the
     * canonical anchor whenever one exists, in BOTH pointer directions.
     */
    const actionableApps = appPages.flat();

    await Promise.all([...openSales, ...unsettledSales, ...historySales].map(addSale));
    const claimedByASale = new Set<string>();
    for (const candidate of candidates.values()) {
      if (candidate.application) claimedByASale.add(candidate.application._id);
    }
    await Promise.all(
      [...actionableApps, ...depositApps, ...historyApps]
        .filter((application) => !claimedByASale.has(application._id))
        .map(addApplication)
    );

    /**
     * Hydration, batched across rows.
     *
     * Sequential per-row awaits made total latency the SUM of every row's
     * round-trips rather than the maximum, on a live subscription that
     * re-executes on any related write.
     */
    const rows = (
      await Promise.all(
        Array.from(candidates.entries()).map(([key, candidate]) =>
          buildRow(ctx, {
            orgId: args.orgId,
            key,
            sale: candidate.sale,
            application: candidate.application,
            rules,
            // The sweep above already asked the subledger this question, so the
            // answer travels with the candidate rather than being asked again.
            hasOpenObligation: candidate.sale !== null && unsettledSaleIds.has(candidate.sale._id),
          })
        )
      )
    ).filter((row): row is DealQueueRow => row !== null);

    /**
     * Attention first, then longest SILENT first.
     *
     * Not newest-first, which is what both existing lists do. This queue exists
     * to answer "what needs me", and the deal nobody has touched in weeks is the
     * one nobody has looked at — putting it last is how a financing company goes
     * quiet without anyone noticing. Finished and stopped deals sort below
     * everything actionable regardless of age.
     *
     * The key is time since the deal last MOVED, not time in its current stage:
     * no stage-entered timestamp exists in the model, and an ordering is allowed
     * to be a heuristic. The wording it drives is not, which is why the row says
     * "days since update" rather than "days waiting".
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
