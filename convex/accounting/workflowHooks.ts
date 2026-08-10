/**
 * workflowHooks.ts
 *
 * Convenience wrappers called from domain mutations to emit accounting events
 * through the central posting engine. Each hook posts a balanced double-entry
 * journal when a chart of accounts and a covering open period exist. When they
 * do NOT, the event is durably enqueued in the accounting outbox instead of
 * being silently dropped — so no sale/payment/expense/disbursement is ever made
 * operationally final without a captured, retryable GL record. The queue is
 * re-driven idempotently when a chart is initialized or a period is opened.
 */
import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { postAccountingEvent, PostCommand } from "./postingEngine";
import { EventType, ReceivableCreditKey, AcquisitionCorrectionType, classifyExpensePosting } from "./postingRules";
import { reverseAccountingEvent } from "./reversals";
import { getOpenPeriodForDate, checkPostingAllowed } from "../accountingPeriods";
import { isChartInitialized, ensureCommissionAccounts, ensureGeneralExpenseAccount, ensureSupplierAPAccount, ensureFixedAssetAccounts, ensurePartnerEquityAccounts, ensureClaimAccounts, ensureVatReceivableAccount, ensureMiscIncomeAccount, ensureSaleFiAccounts, ensureConsignmentAccounts, ensureExpenseCategoryAccounts, ensurePrepaidExpensesAccount, ensurePayrollAccounts } from "../chartOfAccounts";
import {
  enqueuePendingPost,
  enqueuePendingReversal,
  cancelPendingPostByKey,
  cancelPendingPostsBySource,
} from "../accountingOutbox";

export async function getOrgCurrency(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<string> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  return settings?.currency ?? "JOD";
}

/**
 * Whether an event dated here would post now or queue to the outbox.
 *
 * Exported so the historical migration's dry run can predict which of the two
 * a correction will do instead of reporting a bare "would correct" count —
 * the distinction is the whole difference between a correction that reaches
 * the books and one that sits waiting for a period to open.
 */
export async function shouldPost(ctx: MutationCtx, orgId: Id<"organizations">, date: number): Promise<boolean> {
  const [chartReady, period] = await Promise.all([
    isChartInitialized(ctx, orgId),
    getOpenPeriodForDate(ctx, orgId, date),
  ]);
  return chartReady && period !== null;
}

/**
 * Whether a domain event dated `date` would post immediately (chart ready + an
 * open period) rather than queue to the outbox. Payroll payment uses this to
 * avoid the "payment posts now but its accrual is still queued for a closed
 * period" negative-payable window: only enforce accrual-before-payment when the
 * payment itself would actually hit the ledger.
 */
export async function isPostableNow(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  date: number
): Promise<boolean> {
  return shouldPost(ctx, orgId, date);
}

/**
 * Posts the event now if the chart + an open period exist, otherwise enqueues it
 * to the durable outbox for retry. This is the single choke point that replaced
 * the previous "silently return if not postable" behavior.
 */
async function postOrEnqueue(ctx: MutationCtx, cmd: PostCommand): Promise<void> {
  // Period integrity: if this exact domain event is already captured but not yet
  // posted in the outbox, it will post with ITS ORIGINAL accounting date once the
  // period opens. A second hook call for the same event (e.g. a commission
  // accrued at sale completion into a closed month, then re-hooked at payroll
  // approval with the period-end date) must NOT create a replacement dated to a
  // different period — that would recognize the expense in the wrong month while
  // the queued original later self-dedupes away. Treat the second call as a
  // no-op; the queued original is the source of truth. (postAccountingEvent only
  // dedupes against POSTED events, so this pending-side guard is the only thing
  // that prevents the cross-period duplicate.)
  const queued = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", cmd.orgId).eq("idempotencyKey", cmd.idempotencyKey)
    )
    .filter((q) => q.and(q.eq(q.field("kind"), "POST"), q.neq(q.field("status"), "POSTED")))
    .first();
  if (queued) return;

  // Already on the books? Then there is nothing to queue. postAccountingEvent
  // dedupes on this key, so the enqueued row could never post anything — it
  // would sit PENDING forever, count as an unposted event against every future
  // period close, burn an attempt on each drain and finally dead-letter.
  //
  // Reachable through ordinary use now that MANUAL accrues at the sale: a July
  // commission posts in July, July closes, and August's payroll run for July
  // re-hooks the same accrual at the period-end date — which no longer posts,
  // so it queued a phantom for an accrual that is already recognized.
  const alreadyPosted = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", cmd.orgId).eq("idempotencyKey", cmd.idempotencyKey)
    )
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();
  if (alreadyPosted) return;

  // Self-heal: make sure the GENERAL_EXPENSE system account is mapped for this
  // org before the engine tries to resolve it (older charts lack the key).
  // Centralized here (not just in hookExpensePosted) because other posting
  // paths — e.g. cheque-return bank fees — can also resolve GENERAL_EXPENSE.
  if (await isChartInitialized(ctx, cmd.orgId)) {
    await ensureGeneralExpenseAccount(ctx, cmd.orgId, cmd.actorId);
    await ensureSupplierAPAccount(ctx, cmd.orgId, cmd.actorId);
  }
  if (await shouldPost(ctx, cmd.orgId, cmd.accountingDate)) {
    await postAccountingEvent(ctx, cmd);
  } else {
    await enqueuePendingPost(ctx, cmd, "No chart of accounts or open period at operation time");
  }
}

/**
 * Shared shape for every forward-posting domain hook: version-1 event dated at
 * the operational occurredAt, posted or durably enqueued. Individual hooks
 * only differ by event type, source, idempotency key, and payload.
 */
async function postDomainEvent(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    eventType: EventType;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    currency: string;
    occurredAt: number;
    actorId: Id<"users">;
    payload: Record<string, unknown>;
    /**
     * Distinguishes REPEATED events of the same type against the same source —
     * several instalments against one claim, say. `postAccountingEvent` dedupes
     * on (eventType, sourceType, sourceId, eventVersion) as well as on the
     * idempotency key, so leaving this at 1 makes every payment after the first
     * silently return "already posted": the subledger records three receipts
     * and the ledger records one. Defaults to 1, which is right for the events
     * that genuinely happen once per source.
     */
    eventVersion?: number;
  }
): Promise<void> {
  await postOrEnqueue(ctx, {
    orgId: args.orgId,
    eventType: args.eventType,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    eventVersion: args.eventVersion ?? 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: args.idempotencyKey,
    payload: args.payload,
    actorId: args.actorId,
  });
}

/**
 * What actually became of a reversal.
 *
 *  - REVERSED — the reversing journal is posted. The money is back.
 *  - DEFERRED — no period was open, so the reversal is queued. The original
 *    entry is STILL POSTED until the outbox drains, and anything that treats
 *    the amount as recovered before then is spending money the ledger still
 *    shows as spent.
 *  - NOT_POSTED — there was nothing to reverse (the forward entry never posted,
 *    and any queued copy of it has been cancelled).
 *
 * Returned rather than swallowed because the caller has to tell DEFERRED from
 * REVERSED. Collapsing the two is what let a slice be refunded in cash while
 * its original application was still live in the general ledger.
 */
export type ReversalOutcome = "REVERSED" | "DEFERRED" | "NOT_POSTED";

/**
 * Generic "undo this posted event, or drop it if it never posted" used when
 * voiding an upstream operation (a cancelled sale, a voided finance deal, a
 * deposit recorded in error). Reverses the posted journal inside an open
 * period, defers the reversal to the outbox when no period is open, and
 * cancels a still-unposted outbox entry so the round trip nets to zero.
 */
async function reverseEventIfPosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sourceType: string;
    sourceId: string;
    eventType: EventType;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
    reversalIdempotencyKey: string;
    pendingPostIdempotencyKey: string;
    /**
     * Pins the reversal to ONE event when several share a source.
     *
     * A source that can move money more than once — a deposit applied to each
     * car on its quote, a claim collected in instalments — writes several
     * events under one `sourceId`, distinguished only by version. Without this
     * the lookup below takes `.first()`, so a reversal aimed at the third
     * movement backs out the first: a live invoice loses its credit and the
     * cancelled one keeps it. Omit it only where the source genuinely posts
     * once.
     */
    eventVersion?: number;
  }
): Promise<ReversalOutcome> {
  const originalEvent =
    args.eventVersion === undefined
      ? await ctx.db
          .query("accountingEvents")
          .withIndex("by_org_source", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("sourceType", args.sourceType)
              .eq("sourceId", args.sourceId)
          )
          .filter((q) => q.eq(q.field("eventType"), args.eventType))
          .filter((q) => q.eq(q.field("status"), "POSTED"))
          .first()
      : await ctx.db
          .query("accountingEvents")
          .withIndex("by_org_event_source_version", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("eventType", args.eventType)
              .eq("sourceType", args.sourceType)
              .eq("sourceId", args.sourceId)
              .eq("eventVersion", args.eventVersion!)
          )
          .filter((q) => q.eq(q.field("status"), "POSTED"))
          .first();

  if (originalEvent) {
    const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
    if (period) {
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: originalEvent._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: args.reversalIdempotencyKey,
      });
      return "REVERSED";
    }
    // No open period — defer the reversal to the outbox instead of skipping it.
    await enqueuePendingReversal(ctx, {
      orgId: args.orgId,
      originalEventId: originalEvent._id,
      reversalDate: args.reversalDate,
      reason: args.reason,
      actorId: args.actorId,
      idempotencyKey: args.reversalIdempotencyKey,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
    });
    return "DEFERRED";
  }

  // No posted GL entry. If it's still sitting unposted in the outbox, cancel
  // it so it never posts (net GL effect of the round trip is zero).
  await cancelPendingPostByKey(ctx, args.orgId, args.pendingPostIdempotencyKey);
  return "NOT_POSTED";
}

export async function hookDepositReceived(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    paymentMethod: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_RECEIVED",
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    idempotencyKey: `deposit_received_${args.depositId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      customerId: args.customerId.toString(),
    },
  });
}

/**
 * The exact accounting coordinates of one application of deposit money.
 *
 * Passed in rather than derived, and stored on the `depositApplications` row
 * that owns it, so the reversal reads back precisely what was posted. A
 * reversal that re-derives its target and gets it wrong does not fail — it
 * finds no event and returns quietly, leaving the subledger reinstated and the
 * ledger still showing the liability discharged.
 */
export type DepositApplicationIdentity = {
  eventType: "DEPOSIT_APPLIED" | "DEPOSIT_APPLIED_TO_SETTLEMENT";
  sourceType: string;
  sourceId: string;
  eventVersion: number;
  idempotencyKey: string;
};

export async function hookDepositApplied(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
    saleId?: Id<"sales">;
    /** Which car on a multi-vehicle quote consumed its share. */
    allocationVehicleId?: Id<"vehicles">;
    /**
     * The identity this application was recorded under.
     *
     * One deposit row can be applied several times — once per car it was
     * allocated across — and each is its own movement of money against its own
     * sale. Sharing an identity makes the second application collide with the
     * first on both the key and the (eventType, sourceType, sourceId,
     * eventVersion) tuple and silently post nothing, and makes every reversal
     * ambiguous. Omitted only by callers that predate the application record.
     */
    identity?: DepositApplicationIdentity;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_APPLIED",
    sourceType: args.identity?.sourceType ?? "deposits",
    sourceId: args.identity?.sourceId ?? args.depositId.toString(),
    idempotencyKey: args.identity?.idempotencyKey ?? `deposit_applied_${args.depositId}`,
    eventVersion: args.identity?.eventVersion ?? 1,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      saleId: args.saleId?.toString(),
      allocationVehicleId: args.allocationVehicleId?.toString(),
    },
  });
}

/**
 * Backs out ONE recorded application, using the identity it was posted under.
 *
 * Deliberately takes no depositId: reversing "the deposit" is what let a
 * cancellation on one car unwind another car's live credit.
 */
export async function reverseDepositApplication(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    identity: DepositApplicationIdentity;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<ReversalOutcome> {
  return await reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: args.identity.sourceType,
    sourceId: args.identity.sourceId,
    eventType: args.identity.eventType,
    eventVersion: args.identity.eventVersion,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `reversed_${args.identity.idempotencyKey}`,
    pendingPostIdempotencyKey: args.identity.idempotencyKey,
  });
}

/**
 * The deposit is retained by the dealership against the margin the supplier
 * owes it — only ever reachable on the DIRECT_TO_SUPPLIER route. See
 * ruleDepositAppliedToSettlement for why this credits the supplier receivable
 * rather than recognizing commission revenue a second time.
 */
export async function hookDepositAppliedToSettlement(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    supplierName?: string;
    actorId: Id<"users">;
    occurredAt: number;
    saleId?: Id<"sales">;
    /** See hookDepositApplied — one row, one identity per application. */
    identity?: DepositApplicationIdentity;
  }
) {
  // Every existing org's chart predates agent accounting, and this rule needs
  // RECEIVABLE_FROM_SUPPLIERS. Deposits are resolved BEFORE hookSaleCompleted
  // runs, so its self-heal comes too late: the first settlement-treated
  // consigned sale in any live org would roll the whole completion back with
  // "System account RECEIVABLE_FROM_SUPPLIERS is not mapped". No fixture can
  // catch it — they all call chartOfAccounts.initialize, which seeds it.
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureConsignmentAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_APPLIED_TO_SETTLEMENT",
    sourceType: args.identity?.sourceType ?? "deposits",
    sourceId: args.identity?.sourceId ?? args.depositId.toString(),
    // Distinct from `deposit_applied_*`: a deposit resolves exactly once, but
    // the two treatments credit different accounts, so sharing a key would let
    // whichever posted first silently suppress the other.
    idempotencyKey:
      args.identity?.idempotencyKey ?? `deposit_applied_settlement_${args.depositId}`,
    eventVersion: args.identity?.eventVersion ?? 1,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      supplierName: args.supplierName,
      saleId: args.saleId?.toString(),
    },
  });
}

/**
 * Restates one historical consigned sale from principal to agent basis. The
 * idempotency key is the sale, so a re-run of the migration posts nothing:
 * postOrEnqueue drops an event whose key is already POSTED or already queued.
 */
export async function hookConsignedSaleReclassified(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    currency: string;
    revenueMinor: number;
    commissionMinor: number;
    cogsMinor: number;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "CONSIGNED_SALE_RECLASSIFIED",
    sourceType: "sales",
    sourceId: args.saleId.toString(),
    idempotencyKey: `consigned_agent_reclass_${args.saleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      vehicleId: args.vehicleId.toString(),
      customerId: args.customerId.toString(),
      currency: args.currency,
      revenueMinor: args.revenueMinor,
      commissionMinor: args.commissionMinor,
      cogsMinor: args.cogsMinor,
    },
  });
}

/**
 * A receipt against a supplier receivable. Keyed on the receivable AND a
 * sequence, because a claim can legitimately be collected in several
 * instalments — keying on the receivable alone would silently drop every
 * payment after the first.
 */
export async function hookSupplierReceivableCollected(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId: Id<"vehicleSupplierReceivables">;
    vehicleId: Id<"vehicles">;
    sourcedFromName: string;
    amountMinor: number;
    currency: string;
    paymentMethod?: string;
    receiptSeq: number;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "SUPPLIER_RECEIVABLE_COLLECTED",
    sourceType: "vehicleSupplierReceivables",
    sourceId: args.receivableId.toString(),
    idempotencyKey: `supplier_receivable_collected_${args.receivableId}_${args.receiptSeq}`,
    // The source identity has to differ too, not just the key — see the note on
    // postDomainEvent's eventVersion.
    eventVersion: args.receiptSeq,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      receivableId: args.receivableId.toString(),
      sourcedFromName: args.sourcedFromName,
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      vehicleId: args.vehicleId.toString(),
    },
  });
}

type DepositResolutionHookArgs = {
  orgId: Id<"organizations">;
  depositId: Id<"deposits">;
  customerId: Id<"customers">;
  amountMinor: number;
  currency: string;
  actorId: Id<"users">;
  occurredAt: number;
  /** Only meaningful for DEPOSIT_REFUNDED — forfeiture never moves cash. */
  paymentMethod?: string;
  /**
   * Scopes the entry to ONE vehicle's slice of a shared quote deposit.
   *
   * Refunding part of a multi-vehicle deposit is a different movement from
   * resolving the whole row, and the two must not share an identity: keyed on
   * the deposit alone, the first partial refund would make every later one —
   * and the eventual release of the remainder — return "already posted" and
   * move no money at all.
   */
  sliceHoldId?: Id<"depositVehicleHolds">;
  /**
   * Which release of this row it is. Defaults to 1.
   *
   * A quote-scoped deposit can be released more than once — the free part now,
   * the rest when the cars it was held against fall away. Keyed on the row
   * alone, every release after the first returned "already posted" and moved
   * cash with no journal behind it.
   */
  releaseSeq?: number;
};

/** Refund and forfeiture post identical event shapes — only the event type (and thus the posting rule) differs. */
function makeDepositResolutionHook(eventType: "DEPOSIT_REFUNDED" | "DEPOSIT_FORFEITED", keyPrefix: string) {
  return async (ctx: MutationCtx, args: DepositResolutionHookArgs) =>
    postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: args.sliceHoldId ? "depositVehicleHolds" : "deposits",
      sourceId: (args.sliceHoldId ?? args.depositId).toString(),
      // The first release of a row keeps the original key, so nothing already
      // posted in production changes identity.
      idempotencyKey: args.sliceHoldId
        ? `${keyPrefix}_slice_${args.sliceHoldId}`
        : `${keyPrefix}_${args.depositId}${
            args.releaseSeq && args.releaseSeq > 1 ? `_${args.releaseSeq}` : ""
          }`,
      eventVersion: args.sliceHoldId ? 1 : (args.releaseSeq ?? 1),
      currency: args.currency,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      payload: {
        depositId: args.depositId.toString(),
        amountMinor: args.amountMinor,
        currency: args.currency,
        customerId: args.customerId.toString(),
        paymentMethod: args.paymentMethod,
        holdId: args.sliceHoldId?.toString(),
      },
    });
}

export const hookDepositRefunded = makeDepositResolutionHook("DEPOSIT_REFUNDED", "deposit_refunded");
export const hookDepositForfeited = makeDepositResolutionHook("DEPOSIT_FORFEITED", "deposit_forfeited");

export async function hookSaleCompleted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    salespersonId: Id<"users">;
    saleAmountMinor: number;
    costMinor: number | undefined;
    currency: string;
    taxMinor: number | undefined;
    actorId: Id<"users">;
    occurredAt: number;
    /** Pass true for drop-shipped vehicles — credits AP-Suppliers instead of Vehicle Inventory for COGS. */
    isSourced?: boolean;
    /** Present when the vehicle is the supplier's and this sale is on agent basis — see SaleCompletedPayload. */
    consignment?: {
      supplierEntitlementMinor: number;
      /** What the third party actually pays the supplier on the direct route — see SaleCompletedPayload. */
      supplierGrossReceiptMinor?: number;
      supplierName?: string;
      settlementRoute: "DIRECT_TO_SUPPLIER" | "THROUGH_DEALERSHIP";
    };
    /** Documentation/admin fees on top of the vehicle price — added to the AR debit, credited to Dealer Fee Income. */
    dealerFeesMinor?: number;
    /** Warranty/GAP premium collected and the portion owed to the third-party underwriter — see SaleCompletedPayload. */
    warrantySoldMinor?: number;
    warrantyCostMinor?: number;
    gapSoldMinor?: number;
    gapCostMinor?: number;
  }
) {
  // Self-heal for orgs that initialized their chart before dealer-fee/warranty/GAP
  // support existed — only relevant when this specific sale actually uses one
  // of those fields, to avoid the extra lookups on every ordinary sale.
  if (args.dealerFeesMinor || args.warrantySoldMinor || args.gapSoldMinor) {
    if (await isChartInitialized(ctx, args.orgId)) {
      await ensureSaleFiAccounts(ctx, args.orgId, args.actorId);
    }
  }
  // Every existing org's chart predates agent accounting, so the first sourced
  // sale after deploy would otherwise fail to resolve these three keys.
  if (args.consignment && (await isChartInitialized(ctx, args.orgId))) {
    await ensureConsignmentAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "SALE_COMPLETED",
    sourceType: "sales",
    sourceId: args.saleId.toString(),
    idempotencyKey: `sale_completed_${args.saleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      saleAmountMinor: args.saleAmountMinor,
      costMinor: args.costMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      vehicleId: args.vehicleId.toString(),
      salespersonId: args.salespersonId.toString(),
      taxMinor: args.taxMinor,
      isSourced: args.isSourced ?? false,
      // Stamped unconditionally. It says "this payload was built by code that
      // considers consignment", which is what lets ruleSaleCompleted refuse a
      // sourced sale with no consignment block without also refusing the ones
      // queued before agent basis existed. See SaleCompletedPayload.
      consignmentEvaluated: true,
      ...(args.consignment ? { consignment: args.consignment } : {}),
      dealerFeesMinor: args.dealerFeesMinor,
      warrantySoldMinor: args.warrantySoldMinor,
      warrantyCostMinor: args.warrantyCostMinor,
      gapSoldMinor: args.gapSoldMinor,
      gapCostMinor: args.gapCostMinor,
    },
  });
}

/**
 * Phase 41 self-heal, scoped like ensureFixedAssetAccountsIfChartReady: only
 * expense-posting and supplier-payment-settling ever debit VAT_RECEIVABLE, so
 * this isn't added to the shared postOrEnqueue choke point.
 */
async function ensureVatReceivableAccountIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensureVatReceivableAccount(ctx, orgId, actorId);
  }
}

export async function hookSupplierPaymentSettled(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    payableId: Id<"vehicleSupplierPayables">;
    /** Which payment against this payable this is. Defaults to 1. */
    paymentSeq?: number;
    sourcedFromName: string;
    amountMinor: number;
    taxMinor?: number;
    currency: string;
    paymentMethod?: string;
    /** See SupplierPaymentSettledPayload — defaults to "COGS" (sale-originated payables). */
    costOrigin?: "COGS" | "VEHICLE_INVENTORY";
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (args.taxMinor && args.taxMinor > 0) {
    await ensureVatReceivableAccountIfChartReady(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "SUPPLIER_PAYMENT_SETTLED",
    sourceType: "vehicleSupplierPayables",
    sourceId: args.payableId.toString(),
    // Sequenced: a payable can be settled in instalments, and each one is its
    // own movement of money. See the note on postDomainEvent's eventVersion for
    // why the key alone is not enough.
    idempotencyKey: `supplier_payment_settled_${args.payableId}_${args.paymentSeq ?? 1}`,
    eventVersion: args.paymentSeq ?? 1,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      payableId: args.payableId.toString(),
      sourcedFromName: args.sourcedFromName,
      amountMinor: args.amountMinor,
      taxMinor: args.taxMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      costOrigin: args.costOrigin,
    },
  });
}

type CollectionHookArgs = {
  orgId: Id<"organizations">;
  paymentId: Id<"collectionPayments">;
  customerId: Id<"customers">;
  amountMinor: number;
  currency: string;
  paymentMethod: string;
  actorId: Id<"users">;
  occurredAt: number;
};

function makeCollectionHook(eventType: "COLLECTION_PAYMENT" | "COLLECTION_REFUND", keyPrefix: string) {
  return async (ctx: MutationCtx, args: CollectionHookArgs) =>
    postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: "collectionPayments",
      sourceId: args.paymentId.toString(),
      idempotencyKey: `${keyPrefix}_${args.paymentId}`,
      currency: args.currency,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      payload: {
        paymentId: args.paymentId.toString(),
        amountMinor: args.amountMinor,
        currency: args.currency,
        customerId: args.customerId.toString(),
        paymentMethod: args.paymentMethod,
      },
    });
}

export const hookCollectionPayment = makeCollectionHook("COLLECTION_PAYMENT", "collection_payment");

/**
 * Posts the cash-out + AR-reopening entry for an approved collection refund:
 * DR Accounts Receivable — Customers / CR Cash. The refund's operational side
 * (OUT collectionPayment + canonical payment + allocation reversal) is handled
 * by the caller; this hook only records the GL impact.
 */
export const hookCollectionRefund = makeCollectionHook("COLLECTION_REFUND", "collection_refund");

export async function hookExpensePosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    expenseId: Id<"expenses">;
    amountMinor: number;
    taxMinor?: number;
    currency: string;
    category?: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
    vehicleId?: Id<"vehicles">;
    capitalizeToInventory?: boolean;
    isPrepaid?: boolean;
  }
) {
  const { capitalize, prepaid } = classifyExpensePosting(args);
  if (args.taxMinor && args.taxMinor > 0) {
    await ensureVatReceivableAccountIfChartReady(ctx, args.orgId, args.actorId);
  }
  if (!capitalize && await isChartInitialized(ctx, args.orgId)) {
    // A prepaid expense debits the Prepaid Expenses asset now and releases it
    // to a per-category expense account later, so both must exist. A normal
    // expense resolves expenseAccountKeyForCategory, which can point at a
    // dedicated per-category account instead of always GENERAL_EXPENSE — either
    // way, self-heal the category accounts for charts initialized before those
    // additions.
    await ensureExpenseCategoryAccounts(ctx, args.orgId, args.actorId);
    if (prepaid) {
      await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
    }
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "EXPENSE_POSTED",
    sourceType: "expenses",
    sourceId: args.expenseId.toString(),
    idempotencyKey: `expense_posted_${args.expenseId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      expenseId: args.expenseId.toString(),
      amountMinor: args.amountMinor,
      taxMinor: args.taxMinor,
      currency: args.currency,
      category: args.category,
      paymentMethod: args.paymentMethod,
      vehicleId: args.vehicleId?.toString(),
      capitalizeToInventory: args.capitalizeToInventory,
      isPrepaid: prepaid,
    },
  });
}

// ─── Vehicle inventory capitalization ─────────────────────────────────────────

export async function hookVehicleAcquired(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    costMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_ACQUIRED",
    sourceType: "vehicles",
    sourceId: args.vehicleId.toString(),
    idempotencyKey: `vehicle_acquired_${args.vehicleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      costMinor: args.costMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookTradeInAccepted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    saleId: Id<"sales">;
    customerId: Id<"customers">;
    tradeInValueMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "TRADE_IN_ACCEPTED",
    sourceType: "vehicles",
    sourceId: args.vehicleId.toString(),
    idempotencyKey: `trade_in_accepted_${args.saleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      saleId: args.saleId.toString(),
      customerId: args.customerId.toString(),
      tradeInValueMinor: args.tradeInValueMinor,
      currency: args.currency,
    },
  });
}

/**
 * Reverses the TRADE_IN_ACCEPTED entry when the sale it was part of is
 * cancelled. reversalKey includes saleId, not just vehicleId — the same
 * vehicle can be traded in again on a later sale once its purchasePrice is
 * cleared, and a vehicle-only key would collide with an earlier trade-in's
 * reversal, causing reverseAccountingEvent's own idempotency check to report
 * "already reversed" without ever reversing the second sale's entry.
 */
export const hookTradeInReversed = makeReversalHook<{ vehicleId: Id<"vehicles">; saleId: Id<"sales"> }>({
  eventType: "TRADE_IN_ACCEPTED",
  sourceType: "vehicles",
  sourceId: (a) => a.vehicleId.toString(),
  reversalKey: (a) => `trade_in_reversed_${a.vehicleId}_${a.saleId}`,
  pendingPostKey: (a) => `trade_in_accepted_${a.saleId}`,
});

/**
 * Each landed-cost edit is its own economic event (upsertLandedCosts replaces
 * the whole items list every save), so the idempotency/source key includes
 * `editToken` — a caller-supplied per-edit discriminator (the landed-cost
 * row's updatedAt after the patch) rather than being derived from vehicleId
 * alone, which would collide across edits.
 */
export async function hookVehicleLandedCostCapitalized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    editToken: string;
    /** Per-account signed deltas — see VehicleLandedCostCapitalizedPayload. */
    accountDeltas: Array<{ paymentMethod?: string; deltaMinor: number }>;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_LANDED_COST_CAPITALIZED",
    sourceType: "vehicleLandedCosts",
    sourceId: `${args.vehicleId}_${args.editToken}`,
    idempotencyKey: `landed_cost_${args.vehicleId}_${args.editToken}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      // Net total kept at the top level too — accountingMigration.ts's
      // backfill reads this scalar to exclude already-posted landed-cost
      // amounts from its opening-balance calculation without needing to
      // know about the per-account breakdown.
      deltaMinor: args.accountDeltas.reduce((sum, d) => sum + d.deltaMinor, 0),
      accountDeltas: args.accountDeltas,
      currency: args.currency,
    },
  });
}

export async function hookVehicleAcquisitionCostCorrected(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    correctionToken: string;
    deltaMinor: number;
    currency: string;
    correctionType?: AcquisitionCorrectionType;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_ACQUISITION_COST_CORRECTED",
    sourceType: "vehicleCostCorrections",
    sourceId: `${args.vehicleId}_${args.correctionToken}`,
    idempotencyKey: `vehicle_cost_corrected_${args.vehicleId}_${args.correctionToken}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      deltaMinor: args.deltaMinor,
      currency: args.currency,
      correctionType: args.correctionType,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookVehiclePrepExpenseReclassified(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    expenseId: Id<"expenses">;
    vehicleId: Id<"vehicles">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_PREP_EXPENSE_RECLASSIFIED",
    sourceType: "expenses",
    sourceId: args.expenseId.toString(),
    idempotencyKey: `vehicle_prep_expense_reclassified_${args.expenseId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

// ─── Manual receivables ────────────────────────────────────────────────────────

export async function hookReceivableCreated(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId: Id<"receivables">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
    creditSystemKey: ReceivableCreditKey;
  }
) {
  if (args.creditSystemKey === "MISCELLANEOUS_INCOME" && (await isChartInitialized(ctx, args.orgId))) {
    await ensureMiscIncomeAccount(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "RECEIVABLE_CREATED",
    sourceType: "receivables",
    sourceId: args.receivableId.toString(),
    idempotencyKey: `receivable_created_${args.receivableId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      receivableId: args.receivableId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      creditSystemKey: args.creditSystemKey,
    },
  });
}

type CommissionHookArgs = {
  orgId: Id<"organizations">;
  saleId: Id<"sales">;
  salespersonId: Id<"users">;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  actorId: Id<"users">;
  occurredAt: number;
};

/**
 * Maps the commission accounts before a commission entry tries to resolve them.
 * Scoped to the commission hooks (like ensurePayrollAccountsIfChartReady) rather
 * than added to the shared choke point, since only these events touch them.
 */
async function ensureCommissionAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensureCommissionAccounts(ctx, orgId, actorId);
  }
}

function makeCommissionHook(
  eventType: "COMMISSION_ACCRUED" | "COMMISSION_PAID",
  sourceIdPrefix: string,
  keyPrefix: string
) {
  return async (ctx: MutationCtx, args: CommissionHookArgs) => {
    await ensureCommissionAccountsIfChartReady(ctx, args.orgId, args.actorId);
    const payload: Record<string, unknown> = {
      saleId: args.saleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      salespersonId: args.salespersonId.toString(),
    };
    if (args.paymentMethod) payload.paymentMethod = args.paymentMethod;
    await postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: "sales",
      sourceId: `${sourceIdPrefix}_${args.saleId}`,
      idempotencyKey: `${keyPrefix}_${args.saleId}`,
      currency: args.currency,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      payload,
    });
  };
}

export const hookCommissionAccrued = makeCommissionHook("COMMISSION_ACCRUED", "commission", "commission_accrued");
export const hookCommissionPaid = makeCommissionHook("COMMISSION_PAID", "commission_paid", "commission_paid");

/**
 * Corrects an already-recognized commission by a SIGNED delta. Each correction
 * is its own economic event, so — like hookVehicleLandedCostCapitalized's
 * editToken — the source and idempotency keys carry a `sequence` discriminator
 * rather than being derived from saleId alone, which would collide on the
 * second correction and silently drop it.
 *
 * The sequence is the sale's monotonically-incremented commissionAdjustmentSeq,
 * assigned inside the same mutation as the amount change. Convex mutations are
 * serializable, so two concurrent corrections cannot be handed the same number.
 */
export async function hookCommissionAdjusted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    salespersonId: Id<"users">;
    sequence: number;
    /** New amount minus the amount currently on the books. Never the new amount. */
    deltaMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensureCommissionAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "COMMISSION_ADJUSTED",
    sourceType: "sales",
    sourceId: commissionAdjustmentSourceId(args.saleId, args.sequence),
    idempotencyKey: `commission_adjusted_${args.saleId}_${args.sequence}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      deltaMinor: args.deltaMinor,
      currency: args.currency,
      salespersonId: args.salespersonId.toString(),
    },
  });
}

/** Shared so the forward hook and its reversal can never disagree on the key. */
export function commissionAdjustmentSourceId(saleId: Id<"sales">, sequence: number): string {
  return `commission_adj_${saleId}_${sequence}`;
}

/**
 * The accounting date every commission entry for a sale must use — accrual and
 * correction alike. Living here rather than in each caller is the point: when
 * the accrual used a different rule from the correction, a correction could post
 * into an open period while the accrual it corrected was still queued behind a
 * closed one, leaving a naked delta in Commission Payable.
 *
 * The rule is the sale's own date, unconditionally, so the expense lands in the
 * period that recognized the revenue it was earned against. There are no
 * exceptions; the body records the two that used to exist and why both were
 * retired.
 *
 * This is the date for RECOGNITION only. A PAYMENT is dated when the cash
 * actually moves, not at the sale — see `hookCommissionPaid`'s callers. Reading
 * this docstring as if it covered payment too is what produced a regression
 * that blocked paying any commission whose month had since closed.
 */
export async function commissionAccountingDate(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">,
  saleDate: number
): Promise<number> {
  // The sale's date, unconditionally — and that is the whole rule.
  //
  // This began as "sale date, or today if the sale's period is closed", to stop
  // an accrual stranding in the outbox. Two things retired that fallback:
  //
  // 1. It was wrong. A commission belongs in the period that recognized the
  //    revenue it was earned against, and SALE_COMPLETED has no such fallback —
  //    so falling back moved the expense to a month the sale was not in, and
  //    separated it from its own revenue. payroll.test.ts has asserted since
  //    before this work that a commission for a closed month must wait for that
  //    month rather than be recognized in a later one.
  // 2. It was the last place callers could disagree. Payroll approval passed the
  //    run's period end and the backfill passed wall-clock time, so a backlog
  //    sale was recognized in whichever period first claimed the shared
  //    idempotency key. Making every caller route through one function is not
  //    enough while the function still takes an answer from them.
  //
  // The hazard the fallback guarded against is now covered where it belongs: the
  // drain-side guards refuse to settle a commission whose accrual has not posted,
  // so a queued accrual can no longer drive Commission Payable negative, and an
  // unposted entry is a period-close blocker an accountant is shown rather than a
  // silent stall. Queuing until the month opens is the designed behaviour, not a
  // failure — it is exactly what the sale's own entry does.
  //
  // Kept as a function, and every caller kept on it, so the rule has one home
  // if it ever needs to be conditional again.
  return saleDate;
}

/**
 * True once this sale's commission has been recognized in the ledger — either a
 * posted COMMISSION_ACCRUED journal entry or a still-queued accrual in the
 * outbox. Both AUTO and MANUAL accrue as soon as the amount is measurable on a
 * completed sale, so this decides whether a new amount is a FIRST accrual or a
 * correction to one already on the books (setCommissionAmount), whether
 * recalculateCommission's one-shot fix-up still applies, and — via
 * `commissionAccrualStrandedReason` below — whether a closed sale period is
 * actually an obstacle or an irrelevance.
 */
export async function hasCommissionAccrual(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<boolean> {
  // Only an ACTIVE accrual counts. A REVERSED event means the accrual was
  // backed out (e.g. the sale was voided), which must genuinely unlock the
  // amount again.
  const posted = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "sales").eq("sourceId", `commission_${saleId}`)
    )
    .filter((q) =>
      q.and(q.eq(q.field("eventType"), "COMMISSION_ACCRUED"), q.neq(q.field("status"), "REVERSED"))
    )
    .first();
  if (posted) return true;
  // Outbox rows persist after being processed (status POSTED) — a processed
  // row's accrual is already covered by the accountingEvents check above, so
  // only a still-queued (PENDING/FAILED) row counts as an accrual here.
  const pending = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", `commission_accrued_${saleId}`)
    )
    .filter((q) => q.neq(q.field("status"), "POSTED"))
    .first();
  return pending !== null;
}

/**
 * Non-null when raising a commission accrual for this sale RIGHT NOW would
 * produce an entry the ledger can never accept — a new accrual dated into a
 * CLOSED or LOCKED period. Such an entry is not merely delayed: it burns every
 * retry and dead-letters into a row that blocks both payment and every future
 * period close, and a LOCKED period cannot be reopened to rescue it.
 *
 * The condition that matters is whether a NEW accrual has to be created, not
 * whether the sale's period happens to be closed. Getting that backwards is a
 * real regression this branch shipped and had to withdraw: the guard was applied
 * unconditionally in `markCommissionPaid`, which refused the ordinary flow of
 * closing a month and then paying the commissions earned in it. When the accrual
 * is already on the books the accrual hook is an idempotent no-op, nothing is
 * dated into the closed period at all, and the payment is dated today — so the
 * closed period is simply irrelevant to that operation.
 *
 * `waiting: true` (no period exists yet) is deliberately allowed through. That
 * entry queues harmlessly, burns no attempts, and posts when the month opens —
 * which is exactly what the sale's own entry does, and what an org that has not
 * set up its accounting yet depends on.
 *
 * Callers that ALWAYS write an entry dated at the sale (setCommissionAmount and
 * recalculateCommission, which post a correction) must check the period
 * unconditionally instead; for them there is no no-op case.
 */
export async function commissionAccrualStrandedReason(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">,
  saleDate: number,
): Promise<"CLOSED_PERIOD" | null> {
  if (await hasCommissionAccrual(ctx, orgId, saleId)) return null;
  const check = await checkPostingAllowed(ctx, orgId, saleDate);
  // Only a CLOSED or LOCKED period. `waiting: true` — no period covers the sale
  // yet — deliberately passes: that accrual queues at the sale's own date and
  // posts when someone creates and opens the month, which is the whole of
  // earned-time recognition for an org still setting up its books.
  //
  // A round-11 review proposed refusing that case too, because payroll can
  // approve a run whose accrual is queued and then payRun refuses it. Rejected:
  // payroll.test.ts "#2 re-accruing a queued commission does not recognize it in
  // a later period" pins the opposite as a deliberate invariant, and refusing
  // would silently drop the commission out of payroll rather than defer it —
  // recognising it late in the wrong month is exactly what this branch exists to
  // stop. That situation has a real exit (create and open the period covering
  // the sale); it needed to be SAID, not prevented, so the close checklist now
  // reports those sales separately and payRun names the remedy.
  return !check.ok && !check.waiting ? "CLOSED_PERIOD" : null;
}

/** True while an entry for this key is still queued (captured but not posted). */
export async function isEventQueued(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  return (await queuedEntryStatus(ctx, orgId, idempotencyKey)) !== null;
}

/**
 * "PENDING", "FAILED", or null when nothing is outstanding.
 *
 * The distinction is the difference between a message that helps and one that
 * misleads. A PENDING entry really is waiting for its period to open. A FAILED
 * one has exhausted its retries: `drainPendingForOrg` reads only PENDING rows,
 * so opening a period does nothing for it, and telling someone to do that sends
 * them somewhere they cannot fix it.
 */
export async function queuedEntryStatus(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<"PENDING" | "FAILED" | null> {
  const pending = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .filter((q) => q.neq(q.field("status"), "POSTED"))
    .first();
  if (!pending) return null;
  return pending.status === "FAILED" ? "FAILED" : "PENDING";
}

/** The worst outstanding state across a sale's commission entries and its sale posting. */
export async function commissionEntriesOutstandingStatus(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sale: { _id: Id<"sales">; commissionAdjustmentSeq?: number }
): Promise<"PENDING" | "FAILED" | null> {
  const keys = [`sale_completed_${sale._id}`, `commission_accrued_${sale._id}`];
  const seq = safeAdjustmentSeq(sale.commissionAdjustmentSeq);
  if (seq === null) return "PENDING";
  for (let sequence = 1; sequence <= seq; sequence++) {
    keys.push(`commission_adjusted_${sale._id}_${sequence}`);
  }
  let worst: "PENDING" | "FAILED" | null = null;
  for (const key of keys) {
    const status = await queuedEntryStatus(ctx, orgId, key);
    if (status === "FAILED") return "FAILED";
    if (status === "PENDING") worst = "PENDING";
  }
  return worst;
}

/**
 * A correction credits Commission Payable exactly as the accrual does, so any
 * settlement that clears the payable must wait for the CORRECTIONS to post too,
 * not just the accrual. Checking only the accrual let a payment debit the full
 * corrected amount against a GL that held only the original — see the payroll
 * and direct-payment guards, which both call this so they cannot drift apart.
 *
 * The loop is clamped: commissionAdjustmentSeq is a plain number field and
 * `sales` rows are editable through the admin raw-JSON editor, so an implausible
 * value must not be able to make settlement unrunnable.
 */
export const MAX_COMMISSION_ADJUSTMENTS = 1000;

/**
 * The correction count, or null when it cannot be trusted.
 *
 * `Math.min(NaN, MAX)` is NaN and `1 <= NaN` is false, so clamping a corrupt
 * counter makes every walk over it quietly do nothing — the settlement guard
 * sees no corrections, the reversal leaves their deltas on the books, and both
 * report success. `sales` rows are writable through the admin raw-JSON editor,
 * so this is the threat model the ceiling exists for. Every caller that walks
 * the counter uses this, and each decides for itself whether null means refuse
 * or fail closed.
 */
export function safeAdjustmentSeq(adjustmentSeq: number | undefined): number | null {
  const seq = adjustmentSeq ?? 0;
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > MAX_COMMISSION_ADJUSTMENTS) return null;
  return seq;
}

/**
 * What the ledger has actually recognized for this sale's commission — the
 * posted accrual plus every posted correction, in minor units.
 *
 * Settlement debits the payable by the amount the SALE says is owed, while the
 * GL carries the amount the ENTRIES recognized. Those are normally identical
 * because every change posts a delta — but `sales` rows are writable through
 * the admin raw-JSON editor, and a bug in the delta arithmetic would produce
 * the same split. Paying against the difference drives Commission Payable
 * negative, and the next correction computes its delta from the already-wrong
 * row, so the normal workflow cannot repair it.
 */
export async function recognizedCommissionMinor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sale: { _id: Id<"sales">; commissionAdjustmentSeq?: number },
  currency: string
): Promise<number | null> {
  const postedAmount = async (
    idempotencyKey: string,
    field: "amountMinor" | "deltaMinor"
  ): Promise<{ minor: number; currency: string } | "ABSENT" | "MALFORMED"> => {
    const event = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .first();
    if (!event) return "ABSENT";
    const value = event.payload?.[field];
    // ABSENT and MALFORMED are NOT the same answer. Both used to return null
    // and the caller skipped either one, so a POSTED correction whose payload
    // could not be read was dropped from the total — while it had really moved
    // Commission Payable. That is the exact partial total the counter check
    // below refuses to produce, arrived at by another route.
    if (typeof value !== "number" || !Number.isFinite(value)) return "MALFORMED";
    return { minor: value, currency: event.currency };
  };

  // Only entries posted in the currency being settled. Minor units are
  // meaningless without their scale — JOD/KWD/BHD/OMR are scale 3 against USD's
  // 2 — so summing across currencies and comparing to one number is how a
  // legitimate settlement gets refused after an org changes its currency.
  // `null` means "recognized, but not in this currency", which is a different
  // problem from a wrong amount and deserves its own message.
  // Unreadable counter ⇒ recognition cannot be computed. Returning a partial
  // total would let a settlement compare against a number that silently omits
  // corrections, which is the same failure as not checking at all.
  const seq = safeAdjustmentSeq(sale.commissionAdjustmentSeq);
  if (seq === null) return null;
  let total = 0;
  let sawAny = false;
  let sawCurrency = false;
  for (const key of [
    { k: `commission_accrued_${sale._id}`, f: "amountMinor" as const },
    ...Array.from({ length: seq }, (_, i) => ({
      k: `commission_adjusted_${sale._id}_${i + 1}`,
      f: "deltaMinor" as const,
    })),
  ]) {
    const entry = await postedAmount(key.k, key.f);
    // Refuse, do not omit: this entry posted and moved the payable by an
    // amount that cannot be read here.
    if (entry === "MALFORMED") return null;
    if (entry === "ABSENT") continue;
    sawAny = true;
    if (entry.currency !== currency) continue;
    sawCurrency = true;
    total += entry.minor;
  }
  if (sawAny && !sawCurrency) return null;
  return total;
}

export async function commissionEntriesStillQueued(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sale: { _id: Id<"sales">; commissionAdjustmentSeq?: number }
): Promise<boolean> {
  // The sale's own posting counts. Inheriting its accounting date keeps the two
  // in the same PERIOD, but that is not the same as enforcing the order: once
  // that period opens while the sale's entry is still sitting in the outbox —
  // or has dead-lettered to FAILED and will never drain — a commission raised
  // now posts immediately, ahead of the revenue that earned it. The drain guard
  // covers entries that queue; nothing covered entries that post directly.
  if (await isEventQueued(ctx, orgId, `sale_completed_${sale._id}`)) return true;
  if (await isEventQueued(ctx, orgId, `commission_accrued_${sale._id}`)) return true;
  const seq = safeAdjustmentSeq(sale.commissionAdjustmentSeq);
  // A counter this code cannot read is treated as "something is outstanding".
  // Reporting "nothing queued" on unreadable evidence is an ALLOW, and what it
  // would allow is a settlement clearing corrections nobody could enumerate.
  if (seq === null) return true;
  for (let sequence = 1; sequence <= seq; sequence++) {
    if (await isEventQueued(ctx, orgId, `commission_adjusted_${sale._id}_${sequence}`)) return true;
  }
  return false;
}

// ─── Payroll hooks ─────────────────────────────────────────────────────────────
// Scoped self-heal (like ensureVatReceivableAccountIfChartReady): only payroll
// events touch the salaries/employee-advance accounts, so don't add them to the
// shared postOrEnqueue choke point.
async function ensurePayrollAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensurePayrollAccounts(ctx, orgId, actorId);
  }
}

/** Advance issued to an employee: Dr Employee Advances (asset) / Cr cash. */
export async function hookEmployeeAdvancePaid(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    advanceId: Id<"employeeAdvances">;
    userId: Id<"users">;
    amountMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "EMPLOYEE_ADVANCE_PAID",
    sourceType: "employeeAdvances",
    sourceId: args.advanceId.toString(),
    idempotencyKey: `employee_advance_paid_${args.advanceId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      advanceId: args.advanceId.toString(),
      userId: args.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

/** Advance repaid directly (outside payroll): Dr cash / Cr Employee Advances. */
export async function hookEmployeeAdvanceRecovered(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    advanceId: Id<"employeeAdvances">;
    // Unique per recovery event so partial repayments each post their own GL
    // entry. Keying idempotency on advanceId alone would silently drop every
    // recovery after the first, under-crediting Employee Advances.
    recoveryId: Id<"employeeAdvanceRecoveries">;
    userId: Id<"users">;
    amountMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "EMPLOYEE_ADVANCE_RECOVERED",
    sourceType: "employeeAdvances",
    sourceId: `recovery_${args.recoveryId}`,
    idempotencyKey: `employee_advance_recovered_${args.recoveryId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      advanceId: args.advanceId.toString(),
      userId: args.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

/** Salary accrued for one employee on a run: Dr Salaries Expense / Cr Salaries Payable. */
export async function hookPayrollAccrued(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    itemId: Id<"payrollItems">;
    runId: Id<"payrollRuns">;
    userId: Id<"users">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PAYROLL_ACCRUED",
    sourceType: "payrollItems",
    sourceId: `accrued_${args.itemId}`,
    idempotencyKey: `payroll_accrued_${args.itemId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      runId: args.runId.toString(),
      userId: args.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

/** One employee's payslip payment (clears salary + commission payables, recovers advance, pays net). */
export async function hookPayrollPaid(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    itemId: Id<"payrollItems">;
    userId: Id<"users">;
    salaryMinor: number;
    commissionMinor: number;
    advanceRecoveredMinor: number;
    netMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PAYROLL_PAID",
    sourceType: "payrollItems",
    sourceId: `paid_${args.itemId}`,
    idempotencyKey: `payroll_paid_${args.itemId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      itemId: args.itemId.toString(),
      userId: args.userId.toString(),
      salaryMinor: args.salaryMinor,
      commissionMinor: args.commissionMinor,
      advanceRecoveredMinor: args.advanceRecoveredMinor,
      netMinor: args.netMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

type ReversalHookArgs<TSourceId> = {
  orgId: Id<"organizations">;
  reason: string;
  actorId: Id<"users">;
  reversalDate: number;
} & TSourceId;

/**
 * All void/cancel hooks share reverseEventIfPosted semantics and differ only
 * in which original event they target and how their idempotency keys are
 * derived from the source id.
 */
function makeReversalHook<TSourceId extends Record<string, unknown>>(cfg: {
  eventType: EventType;
  sourceType: string;
  sourceId: (args: TSourceId) => string;
  reversalKey: (args: TSourceId) => string;
  pendingPostKey: (args: TSourceId) => string;
}) {
  return async (ctx: MutationCtx, args: ReversalHookArgs<TSourceId>) =>
    reverseEventIfPosted(ctx, {
      orgId: args.orgId,
      sourceType: cfg.sourceType,
      sourceId: cfg.sourceId(args),
      eventType: cfg.eventType,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
      reversalIdempotencyKey: cfg.reversalKey(args),
      pendingPostIdempotencyKey: cfg.pendingPostKey(args),
    });
}

/** Reverses the SALE_COMPLETED entry (or cancels its pending post) when a sale is cancelled. */
export const hookSaleCancelled = makeReversalHook<{ saleId: Id<"sales"> }>({
  eventType: "SALE_COMPLETED",
  sourceType: "sales",
  sourceId: (a) => a.saleId.toString(),
  reversalKey: (a) => `sale_cancelled_${a.saleId}`,
  pendingPostKey: (a) => `sale_completed_${a.saleId}`,
});

/** Reverses the FINANCE_DISBURSED entry created at finalizeDeal, when voiding a closed application that was never actually disbursed. */
export const hookFinanceDisbursementCancelled = makeReversalHook<{ applicationId: Id<"financeApplications"> }>({
  eventType: "FINANCE_DISBURSED",
  sourceType: "financeApplications",
  sourceId: (a) => a.applicationId.toString(),
  reversalKey: (a) => `finance_disbursement_cancelled_${a.applicationId}`,
  pendingPostKey: (a) => `finance_disbursed_${a.applicationId}`,
});

/** Reverses a COMMISSION_ACCRUED entry when the underlying sale is voided. */
export const hookCommissionReversed = makeReversalHook<{ saleId: Id<"sales"> }>({
  eventType: "COMMISSION_ACCRUED",
  sourceType: "sales",
  sourceId: (a) => `commission_${a.saleId}`,
  reversalKey: (a) => `commission_reversed_${a.saleId}`,
  pendingPostKey: (a) => `commission_accrued_${a.saleId}`,
});

/**
 * Reverses ONE COMMISSION_ADJUSTED entry. A voided sale must back out every
 * correction as well as the original accrual — reversing only the accrual
 * leaves each adjustment's delta stranded in Commission Payable, so a sale
 * accrued at 100 and corrected to 150 would still owe 50 after cancellation.
 * Callers reverse sequences 1..commissionAdjustmentSeq; see reverseCommissionForSale.
 *
 * No account self-heal is needed on this path, despite what the comment that
 * used to sit here claimed: this runs through makeReversalHook, not
 * makeCommissionHook, so ensureCommissionAccountsIfChartReady is never called.
 * It is safe anyway — a correction can only be reversed after it posted, which
 * already resolved both commission accounts — but the stated reason was wrong.
 */
export const hookCommissionAdjustmentReversed = makeReversalHook<{ saleId: Id<"sales">; sequence: number }>({
  eventType: "COMMISSION_ADJUSTED",
  sourceType: "sales",
  sourceId: (a) => commissionAdjustmentSourceId(a.saleId, a.sequence),
  reversalKey: (a) => `commission_adj_reversed_${a.saleId}_${a.sequence}`,
  pendingPostKey: (a) => `commission_adjusted_${a.saleId}_${a.sequence}`,
});

/**
 * Backs a sale's commission out of the ledger completely: the original accrual
 * plus every correction posted against it. The single entry point for voiding a
 * commission, so no caller can reverse the accrual and forget the adjustments.
 */
export async function reverseCommissionForSale(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    adjustmentSeq: number;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<void> {
  await hookCommissionReversed(ctx, {
    orgId: args.orgId,
    saleId: args.saleId,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
  });
  // Validated, not clamped. `Math.min(NaN, MAX)` is NaN and `1 <= NaN` is
  // false, so a NaN or negative counter silently reversed the accrual alone and
  // left every correction's expense and payable posted against a sale that no
  // longer exists — the cancellation reporting success either way. A counter
  // this code cannot trust is a reason to refuse the cancellation, not to
  // reverse part of it: setCommissionAmount refuses to issue a sequence past
  // the ceiling, so a valid row can never be in this state.
  const seq = safeAdjustmentSeq(args.adjustmentSeq);
  if (seq === null) {
    throw new ConvexError(
      "This sale's commission correction count is not a usable number, so its ledger entries cannot be reversed safely. Have accounting review it before cancelling."
    );
  }
  // The counter says how many corrections there SHOULD be; the entries say how
  // many there are. Validating the counter's type and range does not make it
  // true — a row edited back to 0 while commission_adjusted_..._1 sits posted
  // passes every check, and cancellation would then reverse the accrual, walk
  // nothing, and report success, leaving that correction's expense and payable
  // on a voided sale. The divergence control excludes cancelled sales, so it
  // would never surface. So walk past the counter until the entries actually
  // run out, and reverse what is really there.
  let actualSeq = seq;
  while (actualSeq < MAX_COMMISSION_ADJUSTMENTS) {
    const next = actualSeq + 1;
    const exists =
      (await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", args.orgId).eq("idempotencyKey", `commission_adjusted_${args.saleId}_${next}`)
        )
        .first()) !== null ||
      (await isEventQueued(ctx, args.orgId, `commission_adjusted_${args.saleId}_${next}`));
    if (!exists) break;
    actualSeq = next;
  }
  for (let sequence = 1; sequence <= actualSeq; sequence++) {
    await hookCommissionAdjustmentReversed(ctx, {
      orgId: args.orgId,
      saleId: args.saleId,
      sequence,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
    });
  }
}

/** Reverses a DEPOSIT_APPLIED entry when an applied deposit is reinstated as an active hold (e.g. the sale it was applied to gets voided). */
export const hookDepositApplicationReversed = makeReversalHook<{ depositId: Id<"deposits"> }>({
  eventType: "DEPOSIT_APPLIED",
  sourceType: "deposits",
  sourceId: (a) => a.depositId.toString(),
  reversalKey: (a) => `deposit_applied_reversed_${a.depositId}`,
  pendingPostKey: (a) => `deposit_applied_${a.depositId}`,
});

/**
 * Reverses a DEPOSIT_APPLIED_TO_SETTLEMENT entry. The settlement treatment
 * credits a different account from the ordinary application, so reversing it
 * with `hookDepositApplicationReversed` reverses nothing at all: that hook
 * looks for `DEPOSIT_APPLIED`, finds no such event, and silently no-ops —
 * leaving the deposit reinstated as HELD while the GL still shows its
 * liability extinguished against the supplier receivable.
 */
export const hookDepositSettlementApplicationReversed = makeReversalHook<{ depositId: Id<"deposits"> }>({
  eventType: "DEPOSIT_APPLIED_TO_SETTLEMENT",
  sourceType: "deposits",
  sourceId: (a) => a.depositId.toString(),
  reversalKey: (a) => `deposit_applied_settlement_reversed_${a.depositId}`,
  pendingPostKey: (a) => `deposit_applied_settlement_${a.depositId}`,
});

/**
 * Reverses the DEPOSIT_RECEIVED entry when a HELD deposit is voided as
 * recorded-in-error (as opposed to refunded/forfeited, which post their own
 * dedicated resolution entries). If the original entry never posted (still in
 * the outbox), it is cancelled so the round trip nets to zero.
 */
export const hookDepositVoided = makeReversalHook<{ depositId: Id<"deposits"> }>({
  eventType: "DEPOSIT_RECEIVED",
  sourceType: "deposits",
  sourceId: (a) => a.depositId.toString(),
  reversalKey: (a) => `deposit_voided_${a.depositId}`,
  pendingPostKey: (a) => `deposit_received_${a.depositId}`,
});

/**
 * Reverses the RECEIVABLE_CREATED entry when a manual receivable is
 * cancelled before any payment is collected. Safe to call for sale-linked
 * receivables too — those never had a RECEIVABLE_CREATED event posted (their
 * AR is recognized by SALE_COMPLETED instead), so this is a no-op for them.
 */
export const hookReceivableCancelled = makeReversalHook<{ receivableId: Id<"receivables"> }>({
  eventType: "RECEIVABLE_CREATED",
  sourceType: "receivables",
  sourceId: (a) => a.receivableId.toString(),
  reversalKey: (a) => `receivable_cancelled_${a.receivableId}`,
  pendingPostKey: (a) => `receivable_created_${a.receivableId}`,
});

export async function hookFinanceDisbursed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    saleId: Id<"sales">;
    financeCompanyId: Id<"financeCompanies">;
    customerId: Id<"customers">;
    loanAmountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FINANCE_DISBURSED",
    sourceType: "financeApplications",
    sourceId: args.applicationId.toString(),
    idempotencyKey: `finance_disbursed_${args.applicationId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      applicationId: args.applicationId.toString(),
      saleId: args.saleId.toString(),
      financeCompanyId: args.financeCompanyId.toString(),
      amountMinor: args.loanAmountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
    },
  });
}

export async function hookFinanceCashReceived(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    financeCompanyId: Id<"financeCompanies">;
    customerId?: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FINANCE_CASH_RECEIVED",
    sourceType: "financeApplications",
    sourceId: `disbursement_${args.applicationId}`,
    idempotencyKey: `finance_cash_received_${args.applicationId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      applicationId: args.applicationId.toString(),
      financeCompanyId: args.financeCompanyId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId?.toString(),
    },
  });
}

export async function hookPaymentLinkReceived(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    intentId: Id<"paymentIntents">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    provider: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PAYMENT_LINK_RECEIVED",
    sourceType: "paymentIntents",
    sourceId: args.intentId.toString(),
    idempotencyKey: `payment_link_received_${args.intentId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      intentId: args.intentId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      provider: args.provider,
    },
  });
}

// ─── GL Phase 11: fixed-asset lifecycle ───────────────────────────────────────

/**
 * Unlike GENERAL_EXPENSE/AP-Suppliers (self-healed unconditionally in
 * postOrEnqueue since many event types can resolve them), the 6 fixed-asset
 * accounts are only ever needed by these 4 hooks — so the self-heal is scoped
 * here instead of added to the shared choke point, to avoid the extra lookup
 * on every unrelated posting event.
 */
async function ensureFixedAssetAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensureFixedAssetAccounts(ctx, orgId, actorId);
  }
}

interface FixedAssetHookBaseArgs {
  orgId: Id<"organizations">;
  assetId: Id<"fixedAssets">;
  currency: string;
  actorId: Id<"users">;
  occurredAt: number;
}

async function postFixedAssetEvent(
  ctx: MutationCtx,
  eventType: Extract<
    EventType,
    "ASSET_CAPITALIZED" | "DEPRECIATION_POSTED" | "ASSET_IMPAIRED" | "ASSET_DISPOSED"
  >,
  args: FixedAssetHookBaseArgs,
  details: {
    sourceId?: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }
) {
  await ensureFixedAssetAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "fixedAssets",
    sourceId: details.sourceId ?? args.assetId.toString(),
    idempotencyKey: details.idempotencyKey,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      assetId: args.assetId.toString(),
      ...details.payload,
      currency: args.currency,
    },
  });
}

export async function hookAssetCapitalized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    costMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postFixedAssetEvent(ctx, "ASSET_CAPITALIZED", args, {
    idempotencyKey: `asset_capitalized_${args.assetId}`,
    payload: {
      costMinor: args.costMinor,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookDepreciationPosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    yearMonth: string; // "YYYY-MM", used only for the idempotency key
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postFixedAssetEvent(ctx, "DEPRECIATION_POSTED", args, {
    sourceId: `depr_${args.assetId}_${args.yearMonth}`,
    idempotencyKey: `depr_${args.assetId}_${args.yearMonth}`,
    payload: {
      amountMinor: args.amountMinor,
    },
  });
}

export async function hookFiCommissionRecognized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    deferralId: Id<"dealerProductDeferrals">;
    yearMonth: string; // "YYYY-MM", used only for the idempotency key
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureSaleFiAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FI_COMMISSION_RECOGNIZED",
    sourceType: "dealerProductDeferrals",
    sourceId: args.deferralId.toString(),
    idempotencyKey: `fi_commission_${args.deferralId}_${args.yearMonth}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      deferralId: args.deferralId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

/**
 * Monthly release of one term-month of a prepaid expense from the Prepaid
 * Expenses asset into its operating-expense account. Exact same shape as
 * hookFiCommissionRecognized — idempotent per (schedule, yearMonth) — see
 * prepaidExpenses.amortizePrepaidExpenseForMonth.
 */
export async function hookPrepaidExpenseAmortized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    yearMonth: string; // "YYYY-MM", used only for the idempotency key
    amountMinor: number;
    currency: string;
    expenseSystemKey: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
    await ensureExpenseCategoryAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PREPAID_EXPENSE_AMORTIZED",
    sourceType: "prepaidExpenseSchedules",
    // Per-month sourceId (same idiom as the monthly depreciation posting): each
    // recognition is a distinct GL event on the source-identity dedup index, so
    // month 2+ can't be mistaken for a duplicate of month 1. The reversal
    // clawback below finds all of a schedule's months via payload.scheduleId.
    sourceId: `prepaid_amort_${args.scheduleId}_${args.yearMonth}`,
    idempotencyKey: `prepaid_amort_${args.scheduleId}_${args.yearMonth}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      scheduleId: args.scheduleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      expenseSystemKey: args.expenseSystemKey,
      // Explicit recognition month for the report's event-derived bucketing
      // (utils/prepaidRecognitionEvents.ts) — previously only encoded in the
      // sourceId suffix, which the report parses as a fallback for events
      // posted before this field existed.
      yearMonth: args.yearMonth,
    },
  });
}

/**
 * Posts the cash-in entry for a partial refund of a prepaid schedule's unused
 * portion — called from prepaidExpenses.correctSchedule. `correctionId` (the
 * prepaidScheduleCorrections row) makes the idempotency key unique per
 * correction, distinct from the per-month keys hookPrepaidExpenseAmortized uses.
 */
export async function hookPrepaidExpenseRefunded(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    correctionId: Id<"prepaidScheduleCorrections">;
    amountMinor: number;
    taxMinor?: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
  }
  if (args.taxMinor && args.taxMinor > 0) {
    await ensureVatReceivableAccountIfChartReady(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PREPAID_EXPENSE_REFUNDED",
    sourceType: "prepaidExpenseSchedules",
    sourceId: `prepaid_refund_${args.correctionId}`,
    idempotencyKey: `prepaid_refund_${args.correctionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      scheduleId: args.scheduleId.toString(),
      amountMinor: args.amountMinor,
      taxMinor: args.taxMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

/**
 * Posts the accelerated write-off of a prepaid schedule's non-refundable
 * unused portion — same GL shape as hookPrepaidExpenseAmortized (release the
 * asset into its expense account) but as a distinct eventType and a one-off
 * per-correction idempotency key rather than a per-month one.
 */
export async function hookPrepaidExpenseWrittenOff(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    correctionId: Id<"prepaidScheduleCorrections">;
    amountMinor: number;
    currency: string;
    expenseSystemKey: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
    await ensureExpenseCategoryAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PREPAID_EXPENSE_WRITTEN_OFF",
    sourceType: "prepaidExpenseSchedules",
    sourceId: `prepaid_writeoff_${args.correctionId}`,
    idempotencyKey: `prepaid_writeoff_${args.correctionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      scheduleId: args.scheduleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      expenseSystemKey: args.expenseSystemKey,
    },
  });
}

/**
 * Claws back every month of F&I commission already recognized for a
 * deferral whose sale was cancelled — unlike makeReversalHook's single-event
 * lookup, a deferral can have one FI_COMMISSION_RECOGNIZED event per
 * recognized month, so each is reversed individually. reverseAccountingEvent
 * is a no-op (returns alreadyReversed) on an event it's already reversed, so
 * this is safe to call more than once for the same deferral. Also drops any
 * month that was enqueued but never posted, so it never posts later.
 */
export async function hookFiCommissionRecognitionsReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    deferralId: Id<"dealerProductDeferrals">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<void> {
  const postedEvents = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", args.orgId).eq("sourceType", "dealerProductDeferrals").eq("sourceId", args.deferralId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "FI_COMMISSION_RECOGNIZED"))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .collect();

  const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
  for (const event of postedEvents) {
    const reversalIdempotencyKey = `fi_commission_reversed_${event._id}`;
    if (period) {
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
      });
    } else {
      await enqueuePendingReversal(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
        sourceType: "dealerProductDeferrals",
        sourceId: args.deferralId.toString(),
      });
    }
  }

  // Drops every not-yet-posted queued month, PENDING or FAILED — a recognition
  // attempt that failed 10 times (accountingOutbox.ts's MAX_ATTEMPTS) moves to
  // FAILED but stays retryable by a finance user, so a status: "PENDING"-only
  // sweep here would leave it behind: a later manual retry could then post F&I
  // revenue for a deferral whose sale was already cancelled.
  await cancelPendingPostsBySource(ctx, args.orgId, "dealerProductDeferrals", args.deferralId.toString());
}

/**
 * Reverses every prepaid GL event already posted for a schedule whose expense
 * is being reversed — every monthly amortization release AND every correction
 * (partial refund, accelerated write-off), same per-event clawback shape as
 * hookFiCommissionRecognitionsReversed. Together with reversing the original
 * EXPENSE_POSTED entry (which reverseExpense already does), this unwinds the
 * whole prepaid lifecycle to zero: the asset debit, the cash credit, every
 * asset→expense release, and any correction's cash refund or accelerated
 * write-off. Without covering the correction event types too, a schedule that
 * had a refund or write-off posted before its expense was reversed would keep
 * that correction's postings live in the GL — orphaned cash/prepaid/VAT
 * balances with no corresponding expense. Idempotent (reverseAccountingEvent
 * no-ops on an already-reversed event) and also drops any not-yet-posted
 * queued event (amortization or correction alike).
 *
 * Returns how many already-POSTED events it reversed, which is how a caller
 * tells real ledger history apart from a schedule that never reached the GL.
 * Note this is NOT implied by the source expense having posted: amortization
 * refuses to run until EXPENSE_POSTED lands (prepaidExpenses.ts's
 * "source_expense_not_posted" — it won't release an asset that was never
 * booked), but a correction won't. correctSchedule can post an accelerated
 * write-off against a schedule whose EXPENSE_POSTED is still queued behind a
 * month that has no open period, so a count > 0 with no posted EXPENSE_POSTED
 * is a reachable state, not a contradiction. A count of 0 means this schedule
 * left no footprint in the ledger.
 */
export async function hookPrepaidExpenseAmortizationsReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<number> {
  const scheduleIdStr = args.scheduleId.toString();
  const REVERSIBLE_EVENT_TYPES = [
    "PREPAID_EXPENSE_AMORTIZED",
    "PREPAID_EXPENSE_REFUNDED",
    "PREPAID_EXPENSE_WRITTEN_OFF",
  ] as const;
  // Each event type uses a per-event (per-month, or per-correction) sourceId,
  // so they're gathered by their (stable) payload.scheduleId rather than an
  // exact sourceId match.
  const postedEvents: Doc<"accountingEvents">[] = [];
  for (const eventType of REVERSIBLE_EVENT_TYPES) {
    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) => q.eq("orgId", args.orgId).eq("eventType", eventType))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .collect();
    postedEvents.push(...events.filter((e) => (e.payload as { scheduleId?: string })?.scheduleId === scheduleIdStr));
  }

  const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
  for (const event of postedEvents) {
    const reversalIdempotencyKey = `prepaid_reversed_${event._id}`;
    if (period) {
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
      });
    } else {
      await enqueuePendingReversal(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
        sourceType: "prepaidExpenseSchedules",
        sourceId: event.sourceId,
      });
    }
  }

  // Drop any not-yet-posted queued amortization months for this schedule
  // (PENDING or FAILED), so a later retry can't post a month for a reversed
  // prepayment — same reasoning as the F&I clawback.
  for (const status of ["PENDING", "FAILED"] as const) {
    const queued = (
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .collect()
    ).filter(
      (p) =>
        p.sourceType === "prepaidExpenseSchedules" &&
        (p.payload as { scheduleId?: string })?.scheduleId === scheduleIdStr
    );
    for (const entry of queued) {
      if (entry.kind === "POST") await ctx.db.delete(entry._id);
    }
  }

  return postedEvents.length;
}

export async function hookAssetImpaired(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postFixedAssetEvent(ctx, "ASSET_IMPAIRED", args, {
    // No timestamp suffix: an asset can only transition ACTIVE -> IMPAIRED
    // once (impair() gates on status === "ACTIVE"), so the key must stay
    // stable across retries rather than vary with wall-clock occurredAt.
    idempotencyKey: `asset_impaired_${args.assetId}`,
    payload: {
      amountMinor: args.amountMinor,
    },
  });
}

// ─── GL Phase 12: partner equity movements ────────────────────────────────────

/** Same scoped-self-heal reasoning as ensureFixedAssetAccountsIfChartReady: only these three hooks ever resolve the partner-equity accounts. */
async function ensurePartnerEquityAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensurePartnerEquityAccounts(ctx, orgId, actorId);
  }
}

export interface PartnerEquityHookArgs {
  orgId: Id<"organizations">;
  transactionId: Id<"partnerEquityTransactions">;
  partnerId: Id<"partnerEquity">;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  actorId: Id<"users">;
  occurredAt: number;
}

async function postPartnerEquityEvent(
  ctx: MutationCtx,
  eventType: Extract<EventType, "CAPITAL_CONTRIBUTED" | "PARTNER_DREW" | "PROFIT_DISTRIBUTED">,
  args: PartnerEquityHookArgs
) {
  await ensurePartnerEquityAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "partnerEquityTransactions",
    sourceId: args.transactionId.toString(),
    idempotencyKey: `${eventType.toLowerCase()}_${args.transactionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      partnerId: args.partnerId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookCapitalContributed(ctx: MutationCtx, args: PartnerEquityHookArgs) {
  await postPartnerEquityEvent(ctx, "CAPITAL_CONTRIBUTED", args);
}

// ─── GL Phase 13: claim receivables ───────────────────────────────────────────

export interface ClaimHookArgs {
  orgId: Id<"organizations">;
  claimId: Id<"claims">;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  actorId: Id<"users">;
  occurredAt: number;
}

async function postClaimEvent(
  ctx: MutationCtx,
  eventType: Extract<EventType, "CLAIM_SETTLED" | "CLAIM_WRITTEN_OFF">,
  args: ClaimHookArgs
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureClaimAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "claims",
    sourceId: args.claimId.toString(),
    idempotencyKey: `${eventType.toLowerCase()}_${args.claimId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      claimId: args.claimId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookClaimSettled(ctx: MutationCtx, args: ClaimHookArgs) {
  await postClaimEvent(ctx, "CLAIM_SETTLED", args);
}

export async function hookClaimWrittenOff(ctx: MutationCtx, args: ClaimHookArgs) {
  await postClaimEvent(ctx, "CLAIM_WRITTEN_OFF", args);
}

// ─── GL Phase 15: cash-drawer bank deposit ────────────────────────────────────

/**
 * No scoped self-heal here: unlike the fixed-asset/partner-equity/claim
 * accounts, BANK_ACCOUNT and CASH_ON_HAND are foundational accounts already
 * ensured by chartOfAccounts.initialize for every org.
 */
export async function hookCashDrawerDeposited(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sessionId: Id<"cashDrawerSessions">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "CASH_DRAWER_DEPOSITED",
    sourceType: "cashDrawerSessions",
    sourceId: args.sessionId.toString(),
    idempotencyKey: `cash_drawer_deposited_${args.sessionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      sessionId: args.sessionId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

export async function hookPartnerDrew(ctx: MutationCtx, args: PartnerEquityHookArgs) {
  await postPartnerEquityEvent(ctx, "PARTNER_DREW", args);
}

export async function hookProfitDistributed(ctx: MutationCtx, args: PartnerEquityHookArgs) {
  await postPartnerEquityEvent(ctx, "PROFIT_DISTRIBUTED", args);
}

export async function hookAssetDisposed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    costMinor: number;
    accumulatedDepreciationMinor: number;
    proceedsMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postFixedAssetEvent(ctx, "ASSET_DISPOSED", args, {
    idempotencyKey: `asset_disposed_${args.assetId}`,
    payload: {
      costMinor: args.costMinor,
      accumulatedDepreciationMinor: args.accumulatedDepreciationMinor,
      proceedsMinor: args.proceedsMinor,
    },
  });
}

